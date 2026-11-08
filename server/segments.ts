// Segments: rules on traits and events, who meets them now, how many did over time, and who reads them. Membership
// is kept up to date as events come in (only the people they are about are evaluated again) and counted again in full
// on a timer, for rules with a period, which change as days pass. The members a product reads, the CSV export and the
// segments on a profile are evaluated at the moment they are asked for, so they are never out of date.
import type { SQLInputValue } from "node:sqlite";
import type { Audience, Row } from "./audience.ts";
import { newId } from "./audience.ts";
import type { TraitType } from "./config.ts";
import { csvLine } from "./csv.ts";
import { AudienceError, DAY, bad, decodeAfter, encodeAfter, isObj, notFound, type Page } from "./errors.ts";
import { compile, hasPeriod, parseRules, RuleError, type Condition } from "./rules.ts";

export function createSegments(a: Audience) {
  const { all, one, run, tx, clock } = a;
  const iso = () => new Date(clock()).toISOString();
  const today = () => iso().slice(0, 10);
  const types = (key: string): TraitType => a.traitOf(key)?.type ?? "string";
  const sqlOf = (rules: Condition, now = clock()) => compile(rules, now, types);

  interface SegmentRow {
    id: string;
    name: string;
    description: string | null;
    rules: string;
    owner: string;
    created_at: string;
    updated_at: string;
    size: number;
    counted_at: string | null;
  }
  const rows = () => all<SegmentRow>("SELECT * FROM segments ORDER BY name COLLATE NOCASE, id");
  const rowOf = (id: string) => one<SegmentRow>("SELECT * FROM segments WHERE id = ?", id) ?? null;
  function must(id: string): SegmentRow {
    const s = rowOf(id);
    if (!s) throw notFound("The segment");
    return s;
  }

  /** The size on each of the last `days` days, the latest count of each day; 0 before the segment was made. */
  function history(s: SegmentRow, days: number) {
    const from = new Date(clock() - (days - 1) * DAY).toISOString().slice(0, 10);
    const known = all<{ day: string; size: number }>("SELECT day, size FROM segment_sizes WHERE segment = ? AND day >= ? ORDER BY day", s.id, from);
    const before = one<{ size: number }>("SELECT size FROM segment_sizes WHERE segment = ? AND day < ? ORDER BY day DESC LIMIT 1", s.id, from);
    let last = before?.size ?? 0;
    return Array.from({ length: days }, (_, i) => {
      const day = new Date(clock() - (days - 1 - i) * DAY).toISOString().slice(0, 10);
      if (day < s.created_at.slice(0, 10)) return { day, size: 0 };
      const k = known.find((x) => x.day === day);
      if (k) last = k.size;
      if (day === today()) last = s.size;
      return { day, size: last };
    });
  }

  function readers(id: string) {
    return all<{ actor: string; last_at: string; reads: number }>(
      "SELECT actor, last_at, reads FROM segment_readers WHERE segment = ? ORDER BY last_at DESC",
      id,
    ).map((r) => ({ actor: r.actor, lastAt: r.last_at, reads: r.reads }));
  }

  function present(s: SegmentRow) {
    const h = history(s, 31);
    const recent = readers(s.id).filter((r) => r.lastAt >= new Date(clock() - 30 * DAY).toISOString());
    const rules = JSON.parse(s.rules) as Condition;
    return {
      id: s.id,
      name: s.name,
      description: s.description,
      rules,
      owner: s.owner,
      createdAt: s.created_at,
      updatedAt: s.updated_at,
      size: s.size,
      change30d: s.size - h[0]!.size,
      countedAt: s.counted_at,
      period: hasPeriod(rules),
      usedBy: recent.map((r) => r.actor),
    };
  }

  // ---------------------------------------------------------------- Membership

  /** Applies who meets the rules among `scope` (every profile when null): joins, leaves, the size and today's size. */
  function apply(s: SegmentRow, match: Set<string>, had: Set<string>, at: string) {
    let joined = 0;
    let left = 0;
    for (const p of match)
      if (!had.has(p)) {
        run("INSERT INTO segment_members (segment, profile, since) VALUES (?, ?, ?)", s.id, p, at);
        run("INSERT INTO segment_changes (segment, profile, change, at) VALUES (?, ?, 'joined', ?)", s.id, p, at);
        joined++;
      }
    for (const p of had)
      if (!match.has(p)) {
        run("DELETE FROM segment_members WHERE segment = ? AND profile = ?", s.id, p);
        run("INSERT INTO segment_changes (segment, profile, change, at) VALUES (?, ?, 'left', ?)", s.id, p, at);
        left++;
      }
    return { joined, left };
  }

  function storeSize(id: string, at: string, counted: boolean) {
    const size = one<{ n: number }>("SELECT COUNT(*) AS n FROM segment_members WHERE segment = ?", id)!.n;
    run(`UPDATE segments SET size = ?${counted ? ", counted_at = ?" : ""} WHERE id = ?`, ...(counted ? [size, at, id] : [size, id]));
    run(
      "INSERT INTO segment_sizes (segment, day, size) VALUES (?, ?, ?) ON CONFLICT (segment, day) DO UPDATE SET size = excluded.size",
      id,
      at.slice(0, 10),
      size,
    );
    return size;
  }

  /** Counts every segment, or one, again in full: one query per segment over all profiles. */
  function recount(only?: string) {
    const now = clock();
    const at = new Date(now).toISOString();
    let changes = 0;
    tx(() => {
      for (const s of rows()) {
        if (only && s.id !== only) continue;
        const { sql, args } = sqlOf(JSON.parse(s.rules) as Condition, now);
        const match = new Set(all<{ id: string }>(`SELECT p.id FROM profiles p WHERE ${sql}`, ...args).map((r) => r.id));
        const had = new Set(all<{ profile: string }>("SELECT profile FROM segment_members WHERE segment = ?", s.id).map((r) => r.profile));
        const r = apply(s, match, had, at);
        changes += r.joined + r.left;
        storeSize(s.id, at, true);
      }
    });
    return changes;
  }

  /** Evaluates again only the people whose events or traits just changed. */
  function refresh(ids: Set<string>) {
    if (!ids.size) return;
    const now = clock();
    const at = new Date(now).toISOString();
    const list = JSON.stringify([...ids]);
    tx(() => {
      for (const s of rows()) {
        const { sql, args } = sqlOf(JSON.parse(s.rules) as Condition, now);
        const match = new Set(
          all<{ id: string }>(`SELECT p.id FROM profiles p WHERE p.id IN (SELECT value FROM json_each(?)) AND ${sql}`, list, ...args).map((r) => r.id),
        );
        const had = new Set(
          all<{ profile: string }>("SELECT profile FROM segment_members WHERE segment = ? AND profile IN (SELECT value FROM json_each(?))", s.id, list).map(
            (r) => r.profile,
          ),
        );
        const r = apply(s, match, had, at);
        if (r.joined || r.left) storeSize(s.id, at, false);
      }
    });
  }

  /** A profile about to be joined into another or deleted leaves its segments, and the sizes say so. */
  function leaving(profile: string, at: string) {
    for (const m of all<{ segment: string }>("SELECT segment FROM segment_members WHERE profile = ?", profile)) {
      run("DELETE FROM segment_members WHERE segment = ? AND profile = ?", m.segment, profile);
      run("INSERT INTO segment_changes (segment, profile, change, at) VALUES (?, ?, 'left', ?)", m.segment, profile, at);
      storeSize(m.segment, at, false);
    }
  }

  a.hooks.changed = refresh;
  a.hooks.leaving = leaving;

  // ---------------------------------------------------------------- Reading members

  /** People as a product reads them: who they are and their traits, a page at a time, in a few queries. */
  function presentMany(ids: string[]) {
    if (!ids.length) return [];
    const list = JSON.stringify(ids);
    const idRows = all<{ profile: string; kind: string; value: string }>(
      "SELECT profile, kind, value FROM identifiers WHERE profile IN (SELECT value FROM json_each(?)) ORDER BY added_at, value",
      list,
    );
    const traitRows = all<{ profile: string; key: string; value: string; num: number | null }>(
      "SELECT profile, key, value, num FROM traits WHERE profile IN (SELECT value FROM json_each(?)) ORDER BY key",
      list,
    );
    const names = new Map(
      all<{ id: string; name: string | null }>("SELECT id, name FROM profiles WHERE id IN (SELECT value FROM json_each(?))", list).map((r) => [r.id, r.name]),
    );
    return ids.map((id) => {
      const mine = idRows.filter((r) => r.profile === id);
      const emails = mine.filter((r) => r.kind === "email").map((r) => r.value);
      const phones = mine.filter((r) => r.kind === "phone").map((r) => r.value);
      const traits: Record<string, string | number | boolean> = {};
      for (const t of traitRows)
        if (t.profile === id) {
          const type = types(t.key);
          traits[t.key] = type === "number" && t.num !== null ? t.num : type === "boolean" ? t.value === "true" : t.value;
        }
      return {
        id,
        name: names.get(id) ?? null,
        email: emails[0] ?? null,
        phone: phones[0] ?? null,
        userId: mine.find((r) => r.kind === "user_id")?.value ?? null,
        emails,
        phones,
        traits,
      };
    });
  }
  type Member = ReturnType<typeof presentMany>[number];

  function noteReader(id: string, actor: string) {
    run(
      "INSERT INTO segment_readers (segment, actor, last_at, reads) VALUES (?, ?, ?, 1) ON CONFLICT (segment, actor) DO UPDATE SET last_at = excluded.last_at, reads = reads + 1",
      id,
      actor,
      iso(),
    );
  }

  /** The members now, in id order, `max` at a time; the cursor carries on after the last id of the page before. */
  function membersPage(rules: Condition, after: string, max: number, now: number): { ids: string[]; more: boolean } {
    const { sql, args } = sqlOf(rules, now);
    const ids = all<{ id: string }>(`SELECT p.id FROM profiles p WHERE p.id > ? AND ${sql} ORDER BY p.id LIMIT ?`, after, ...args, max + 1).map((r) => r.id);
    return { ids: ids.slice(0, max), more: ids.length > max };
  }

  function members(id: string, cursor: string | undefined, max: number, actor: string): Page<Member> & { segment: string; name: string } {
    const s = must(id);
    const after = decodeAfter(cursor);
    const { ids, more } = membersPage(JSON.parse(s.rules) as Condition, after, max, clock());
    if (!after) noteReader(id, actor);
    return { segment: s.id, name: s.name, items: presentMany(ids), ...(more && { nextCursor: encodeAfter(ids.at(-1)!) }) };
  }

  /** The whole segment as CSV: id, name, email, phone, user id and every trait in the file, a row per person. */
  function* csv(id: string, actor: string): Generator<string> {
    const s = must(id);
    noteReader(id, actor);
    const traits = a.config().traits.map((t) => t.key);
    yield csvLine(["id", "name", "email", "phone", "user_id", ...traits]);
    const rules = JSON.parse(s.rules) as Condition;
    const now = clock();
    let after = "";
    for (;;) {
      const page = membersPage(rules, after, 1000, now);
      let chunk = "";
      for (const m of presentMany(page.ids)) chunk += csvLine([m.id, m.name, m.email, m.phone, m.userId, ...traits.map((k) => m.traits[k] ?? "")]);
      if (chunk) yield chunk;
      if (!page.more) return;
      after = page.ids.at(-1)!;
    }
  }

  /** Who joined and left, oldest first after the cursor; a product polls it to act when someone enters. */
  function changes(id: string, cursor: string | undefined, max: number) {
    must(id);
    const after = cursor ? Number(decodeAfter(cursor)) : 0;
    if (!Number.isInteger(after) || after < 0) throw bad("cursor is not one this API returned.");
    const list = all<{ id: number; profile: string; change: "joined" | "left"; at: string }>(
      "SELECT id, profile, change, at FROM segment_changes WHERE segment = ? AND id > ? ORDER BY id LIMIT ?",
      id,
      after,
      max,
    );
    const last = list.at(-1)?.id ?? after;
    // The cursor is given even on an empty page, so the next poll starts where this one ended.
    return { segment: id, changes: list.map((c) => ({ profile: c.profile, change: c.change, at: c.at })), cursor: encodeAfter(String(last)) };
  }

  /** The segments a profile meets now. */
  function forProfile(profile: string) {
    const now = clock();
    return rows()
      .filter((s) => {
        const { sql, args } = sqlOf(JSON.parse(s.rules) as Condition, now);
        return !!one(`SELECT 1 FROM profiles p WHERE p.id = ? AND ${sql}`, profile, ...args);
      })
      .map((s) => ({ id: s.id, name: s.name }));
  }

  // ---------------------------------------------------------------- Writing

  function parseBody(body: unknown, partial: boolean) {
    if (!isObj(body)) throw bad("The body is { name, rules, description }.");
    const extra = Object.keys(body).filter((k) => !["name", "description", "rules"].includes(k));
    if (extra.length) throw bad(`unknown ${extra.join(", ")}; a segment takes name, description and rules.`);
    const out: { name?: string; description?: string | null; rules?: Condition } = {};
    if (body.name !== undefined || !partial) {
      if (typeof body.name !== "string" || !body.name.trim() || body.name.trim().length > 120) throw bad("name is a text of 1 to 120 characters.");
      out.name = body.name.trim();
    }
    if (body.description !== undefined) {
      if (body.description !== null && (typeof body.description !== "string" || body.description.length > 500))
        throw bad("description is a text of up to 500 characters.");
      out.description = typeof body.description === "string" ? body.description.trim() || null : null;
    }
    if (body.rules !== undefined || !partial) out.rules = rulesOf(body.rules);
    return out;
  }

  function rulesOf(v: unknown): Condition {
    try {
      return parseRules(v, a.config());
    } catch (err) {
      if (err instanceof RuleError) throw bad(err.message);
      throw err;
    }
  }

  function taken(name: string, except?: string) {
    const other = one<{ id: string }>("SELECT id FROM segments WHERE name = ? COLLATE NOCASE", name);
    if (other && other.id !== except) throw new AudienceError(409, "conflict", `There is a segment named ${name} already.`);
  }

  function create(body: unknown, actor: string) {
    const b = parseBody(body, false);
    if (one<{ n: number }>("SELECT COUNT(*) AS n FROM segments")!.n >= 200)
      throw new AudienceError(409, "conflict", "There are 200 segments; delete one first.");
    taken(b.name!);
    const id = newId();
    const at = iso();
    tx(() => {
      run(
        "INSERT INTO segments (id, name, description, rules, owner, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        id,
        b.name!,
        b.description ?? null,
        JSON.stringify(b.rules),
        actor,
        at,
        at,
      );
      recount(id);
    });
    return get(id);
  }

  function update(id: string, body: unknown) {
    const s = must(id);
    const b = parseBody(body, true);
    if (b.name) taken(b.name, id);
    tx(() => {
      run(
        "UPDATE segments SET name = ?, description = ?, rules = ?, updated_at = ? WHERE id = ?",
        b.name ?? s.name,
        b.description === undefined ? s.description : b.description,
        b.rules ? JSON.stringify(b.rules) : s.rules,
        iso(),
        id,
      );
      if (b.rules) recount(id);
    });
    return get(id);
  }

  function remove(id: string) {
    must(id);
    run("DELETE FROM segments WHERE id = ?", id);
  }

  function get(id: string) {
    const s = must(id);
    return { ...present(s), history: history(s, 90), readers: readers(id) };
  }

  /** How many people rules would hold now, and a few of them, without saving anything. */
  function preview(body: unknown) {
    if (!isObj(body) || Object.keys(body).some((k) => k !== "rules")) throw bad("The body is { rules }.");
    const rules = rulesOf(body.rules);
    const now = clock();
    const { sql, args } = sqlOf(rules, now);
    const started = performance.now();
    const size = one<{ n: number }>(`SELECT COUNT(*) AS n FROM profiles p WHERE ${sql}`, ...args)!.n;
    const sample = all<{ id: string }>(`SELECT p.id FROM profiles p WHERE ${sql} ORDER BY COALESCE(p.last_at, p.created_at) DESC LIMIT 5`, ...args).map(
      (r) => r.id,
    );
    return { size, sample: presentMany(sample), ms: Math.round(performance.now() - started) };
  }

  function purge() {
    run("DELETE FROM segment_changes WHERE at < ?", new Date(clock() - 90 * DAY).toISOString());
  }

  return {
    list: () => rows().map(present),
    get,
    create,
    update,
    remove,
    preview,
    members,
    csv,
    changes,
    forProfile,
    recount,
    refresh,
    purge,
    count: () => one<{ n: number }>("SELECT COUNT(*) AS n FROM segments")!.n,
    /** For tests: the SQL a rule tree becomes. */
    sqlOf: (rules: Condition, now: number) => sqlOf(rules, now) as { sql: string; args: SQLInputValue[] },
  };
}

export type Segments = ReturnType<typeof createSegments>;
export type { Row };
