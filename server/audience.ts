// The profiles: one per person, how each is known, their traits and one timeline of events from every source. The
// one rule that decides who is who: two records are one person when they share an email, a phone number or your user
// id, within the kinds the file matches by. Nothing else is compared and nothing is guessed. A profile has at most one
// user id, so two profiles with different user ids are never joined, whatever else they share.
import { randomBytes } from "node:crypto";
import type { DatabaseSync, SQLInputValue, StatementSync } from "node:sqlite";
import { SOURCES, type Config, type ConfigFileState, type IdKind, type Source, type Trait } from "./config.ts";
import { DAY, bad, decodeCursor, encodeCursor, fail, isObj, notFound, type Page } from "./errors.ts";
import { fold, normalEmail, normalPhone, normalUserId } from "./identity.ts";

export type Row = Record<string, SQLInputValue>;

/** A person as an event, an import row or the API names them. At least one of email, phone and userId. */
export interface PersonInput {
  email?: string | null;
  phone?: string | null;
  userId?: string | null;
  name?: string | null;
}

export interface Ids {
  email: string | null;
  phone: string | null;
  userId: string | null;
  name: string | null;
}

export interface EventRecord {
  source: Source;
  type: string;
  at: string;
  text: string | null;
  props: Record<string, unknown> | null;
  external: string | null;
}

export interface Resolved {
  profile: string;
  created: boolean;
  /** Profiles that turned out to be this person and were joined into it. */
  merged: string[];
  /** Identifiers given that belong to another person with a different user id, so they were not added here. */
  conflicts: number;
}

export interface IgnoredTrait {
  trait: string;
  reason: string;
}

const PROFILE_ID = /^[A-Za-z0-9_-]{12}$/;
const NAME_MAX = 200;
const TEXT_MAX = 300;
const PROPS_MAX = 4096;

export const newId = () => randomBytes(9).toString("base64url");
export const isProfileId = (v: string) => PROFILE_ID.test(v);

/** The person an API body names, checked and written the way they are compared. */
export function parsePerson(v: unknown, at: string, config: Pick<Config, "matchBy" | "phoneCountry">): Ids {
  if (!isObj(v)) throw bad(`${at} is a map with email, phone, userId and name.`);
  const extra = Object.keys(v).filter((k) => !["email", "phone", "userId", "name"].includes(k));
  if (extra.length) throw bad(`${at}: unknown ${extra.join(", ")}; a person is named by email, phone and userId, with an optional name.`);
  const given = (x: unknown) => x !== undefined && x !== null && x !== "";
  const ids: Ids = { email: null, phone: null, userId: null, name: null };
  if (given(v.email)) ids.email = normalEmail(v.email) ?? fail(`${at}.email is not an email address.`);
  if (given(v.phone)) ids.phone = normalPhone(v.phone, config.phoneCountry) ?? fail(`${at}.phone is not a phone number, such as +905551112233.`);
  if (given(v.userId)) ids.userId = normalUserId(v.userId) ?? fail(`${at}.userId is your own id for the person, 1 to 128 characters without spaces.`);
  if (given(v.name)) {
    if (typeof v.name !== "string" || v.name.trim().length > NAME_MAX) throw bad(`${at}.name is a text of up to ${NAME_MAX} characters.`);
    ids.name = v.name.trim() || null;
  }
  const matchable = config.matchBy.filter((k) => idOf(ids, k) !== null);
  if (!matchable.length)
    throw bad(
      `${at} needs ${config.matchBy.map((k) => (k === "user_id" ? "userId" : k)).join(", ")} or more: people are matched only by ${config.matchBy.join(", ")}.`,
    );
  return ids;
}

const idOf = (ids: Ids, k: IdKind) => (k === "email" ? ids.email : k === "phone" ? ids.phone : ids.userId);

/** A trait's value as the file's type takes it, or the reason it does not. */
export function traitValue(t: Trait, v: unknown): { value: string; num: number | null } | { reason: string } {
  switch (t.type) {
    case "number": {
      const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v.replace(",", ".")) : NaN;
      return Number.isFinite(n) ? { value: String(n), num: n } : { reason: "is a number" };
    }
    case "boolean": {
      const s = typeof v === "boolean" ? String(v) : typeof v === "string" ? v.trim().toLowerCase() : "";
      return s === "true" || s === "false" ? { value: s, num: null } : { reason: "is true or false" };
    }
    case "date": {
      const s = typeof v === "string" ? v.trim() : "";
      if (/^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s))) return { value: s, num: null };
      const ms = /^\d{4}-\d{2}-\d{2}T/.test(s) ? Date.parse(s) : NaN;
      return Number.isNaN(ms) ? { reason: "is a date, such as 2026-12-31" } : { value: new Date(ms).toISOString(), num: null };
    }
    default: {
      const s = typeof v === "string" ? v.trim() : typeof v === "number" || typeof v === "boolean" ? String(v) : null;
      if (s === null || !s || s.length > 500) return { reason: "is a text of up to 500 characters" };
      if (t.values) {
        // The file's spelling wins: free, FREE and Free are all Free.
        const known = t.values.find((x) => fold(x) === fold(s));
        return known ? { value: known, num: null } : { reason: `is one of ${t.values.join(", ")}` };
      }
      return { value: s, num: null };
    }
  }
}

/** Checks an event's own fields: type, time, id, text and properties. */
export function parseEventFields(
  v: Record<string, unknown>,
  at: string,
  now: number,
): { type: string; at: string; external: string | null; text: string | null; props: Record<string, unknown> | null } {
  if (typeof v.type !== "string" || !/^[a-z0-9][a-z0-9_.:-]{0,63}$/.test(v.type))
    throw bad(`${at}.type is the kind of event: lowercase letters, digits, _ . : and -, such as form_submitted.`);
  let when = new Date(now).toISOString();
  if (v.at !== undefined) {
    const ms = typeof v.at === "string" ? Date.parse(v.at) : NaN;
    if (Number.isNaN(ms)) throw bad(`${at}.at is a time, such as 2026-11-08T09:30:00Z.`);
    if (ms > now + DAY) throw bad(`${at}.at is more than a day ahead; events are what happened.`);
    when = new Date(ms).toISOString();
  }
  let external: string | null = null;
  if (v.id !== undefined) {
    if (typeof v.id !== "string" || !/^[^\s]{1,200}$/.test(v.id))
      throw bad(`${at}.id is the source's own id for the event, 1 to 200 characters without spaces.`);
    external = v.id;
  }
  let text: string | null = null;
  if (v.text !== undefined && v.text !== null) {
    if (typeof v.text !== "string" || v.text.length > TEXT_MAX) throw bad(`${at}.text is how the timeline says it, up to ${TEXT_MAX} characters.`);
    text = v.text.trim() || null;
  }
  let props: Record<string, unknown> | null = null;
  if (v.properties !== undefined && v.properties !== null) {
    if (!isObj(v.properties)) throw bad(`${at}.properties is a map.`);
    if (JSON.stringify(v.properties).length > PROPS_MAX) throw bad(`${at}.properties is at most ${PROPS_MAX} bytes of JSON.`);
    props = v.properties;
  }
  return { type: v.type, at: when, external, text, props };
}

export interface AudienceOptions {
  clock?: () => number;
  fileState?: () => ConfigFileState | null;
}

export function createAudience(db: DatabaseSync, { clock = Date.now, fileState = () => null }: AudienceOptions = {}) {
  let config: Config = {
    matchBy: ["email", "phone", "user_id"],
    phoneCountry: "TR",
    traits: [],
    links: [],
    keepDays: 761,
    recountMinutes: 15,
    text: "",
  };
  const cache = new Map<string, StatementSync>();
  const stmt = (sql: string) => {
    let s = cache.get(sql);
    if (!s) cache.set(sql, (s = db.prepare(sql)));
    return s;
  };
  const all = <T = Row>(sql: string, ...args: SQLInputValue[]) => stmt(sql).all(...args) as T[];
  const one = <T = Row>(sql: string, ...args: SQLInputValue[]) => stmt(sql).get(...args) as T | undefined;
  const run = (sql: string, ...args: SQLInputValue[]) => stmt(sql).run(...args);
  const iso = () => new Date(clock()).toISOString();

  let depth = 0;
  /** Runs fn in one transaction; nested calls join the outer one. */
  function tx<T>(fn: () => T): T {
    if (depth > 0) return fn();
    depth++;
    db.exec("BEGIN IMMEDIATE");
    try {
      const out = fn();
      db.exec("COMMIT");
      return out;
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    } finally {
      depth--;
    }
  }

  /** Told which profiles changed, so segments follow, and which are about to go: joined into another or deleted. */
  const hooks = {
    changed: (_ids: Set<string>) => {},
    leaving: (_profile: string, _at: string) => {},
  };

  const traitOf = (key: string) => config.traits.find((t) => t.key === key);

  // ---------------------------------------------------------------- Matching

  const owners = (kind: IdKind, value: string) =>
    all<{ profile: string }>(
      "SELECT i.profile FROM identifiers i JOIN profiles p ON p.id = i.profile WHERE i.kind = ? AND i.value = ? ORDER BY p.created_at",
      kind,
      value,
    ).map((r) => r.profile);
  const userIdsOf = (profile: string) =>
    all<{ value: string }>("SELECT value FROM identifiers WHERE profile = ? AND kind = 'user_id'", profile).map((r) => r.value);

  function addSource(profile: string, source: Source) {
    const p = one<{ sources: string }>("SELECT sources FROM profiles WHERE id = ?", profile)!;
    const set = new Set(p.sources.split(" ").filter(Boolean));
    if (set.has(source)) return;
    set.add(source);
    run("UPDATE profiles SET sources = ? WHERE id = ?", SOURCES.filter((s) => set.has(s)).join(" "), profile);
  }

  /** Joins `from` into `into`: identifiers, traits (the newer value wins), events and visitors move; `from` is gone. */
  function merge(from: string, into: string, kind: IdKind) {
    const at = iso();
    hooks.leaving(from, at);
    run(
      "INSERT OR IGNORE INTO identifiers (kind, value, profile, added_at, source) SELECT kind, value, ?, added_at, source FROM identifiers WHERE profile = ?",
      into,
      from,
    );
    run(
      `INSERT INTO traits (profile, key, value, num, folded, updated_at, source)
       SELECT ?, key, value, num, folded, updated_at, source FROM traits WHERE profile = ? AND true
       ON CONFLICT (profile, key) DO UPDATE SET value = excluded.value, num = excluded.num, folded = excluded.folded,
         updated_at = excluded.updated_at, source = excluded.source WHERE excluded.updated_at > traits.updated_at`,
      into,
      from,
    );
    run("UPDATE events SET profile = ? WHERE profile = ?", into, from);
    run("UPDATE OR IGNORE analytics_visitors SET profile = ? WHERE profile = ?", into, from);
    const a = one<Row>("SELECT * FROM profiles WHERE id = ?", from)!;
    const b = one<Row>("SELECT * FROM profiles WHERE id = ?", into)!;
    const older = (a.created_at as string) < (b.created_at as string) ? a : b;
    const sources = new Set([...(a.sources as string).split(" "), ...(b.sources as string).split(" ")].filter(Boolean));
    const last = [a.last_at, b.last_at].filter(Boolean).sort().at(-1) ?? null;
    run(
      "UPDATE profiles SET name = COALESCE(name, ?), created_at = ?, first_source = ?, sources = ?, last_at = ?, updated_at = ? WHERE id = ?",
      a.name ?? null,
      older.created_at as string,
      older.first_source as string,
      SOURCES.filter((s) => sources.has(s)).join(" "),
      last as string | null,
      at,
      into,
    );
    run("DELETE FROM profiles WHERE id = ?", from);
    run("INSERT INTO merges (from_profile, into_profile, at, kind) VALUES (?, ?, ?, ?)", from, into, at, kind);
    // Anyone who held the old id is sent on to the person it is now.
    run("UPDATE merges SET into_profile = ? WHERE into_profile = ?", into, from);
  }

  /**
   * The profile these identifiers name, made or joined as needed. A user id decides first: the profile that has it is
   * the person. Profiles that share an email or phone with it join it, unless they have a different user id. Without
   * a user id, the profile with the email, then the phone, is the person.
   */
  function resolve(given: Ids, source: Source, at: string): Resolved {
    const ids: Ids = {
      email: normalEmail(given.email),
      phone: normalPhone(given.phone, config.phoneCountry),
      userId: normalUserId(given.userId),
      name: given.name,
    };
    return tx(() => {
      const kinds = config.matchBy.filter((k) => idOf(ids, k) !== null);
      const ownersBy = new Map(kinds.map((k) => [k, owners(k, idOf(ids, k)!)]));
      const matched = [...new Set([...ownersBy.values()].flat())];
      const users = new Map(matched.map((p) => [p, userIdsOf(p)]));
      const u = config.matchBy.includes("user_id") ? ids.userId : null;
      let target: string | null = u ? (ownersBy.get("user_id")?.[0] ?? null) : null;
      const priority = (["user_id", "email", "phone"] as IdKind[]).flatMap((k) => ownersBy.get(k) ?? []);
      if (!target) {
        const free = u ? priority.filter((p) => !users.get(p)!.length) : priority;
        target = free[0] ?? null;
      }
      let conflicts = 0;
      const merged: string[] = [];
      let created = false;
      if (!target) {
        target = newId();
        created = true;
        run(
          "INSERT INTO profiles (id, name, created_at, updated_at, first_source, sources) VALUES (?, ?, ?, ?, ?, ?)",
          target,
          ids.name,
          at,
          iso(),
          source,
          source,
        );
      } else {
        // The others join it when they have no user id, or the same one.
        const mine = new Set([...(users.get(target) ?? []), ...(u ? [u] : [])]);
        for (const p of matched) {
          if (p === target) continue;
          const theirs = users.get(p)!;
          // Left apart; the identifier they share is counted as a conflict below.
          if (theirs.length && (mine.size ? theirs.some((x) => !mine.has(x)) : theirs.length > 1)) continue;
          const kind = kinds.find((k) => ownersBy.get(k)!.includes(p))!;
          merge(p, target, kind);
          merged.push(p);
          for (const x of theirs) mine.add(x);
        }
        if (ids.name) run("UPDATE profiles SET name = ? WHERE id = ?", ids.name, target);
      }
      // Identifiers are added where nobody else has them. A second user id is never added.
      const hasUser = userIdsOf(target).length > 0;
      for (const k of ["email", "phone", "user_id"] as IdKind[]) {
        const value = idOf(ids, k);
        if (value === null) continue;
        if (k === "user_id" && hasUser) {
          if (!userIdsOf(target).includes(value)) conflicts++;
          continue;
        }
        const who = config.matchBy.includes(k) ? owners(k, value) : [];
        if (who.includes(target)) continue;
        if (who.length) {
          conflicts++;
          continue;
        }
        run("INSERT OR IGNORE INTO identifiers (kind, value, profile, added_at, source) VALUES (?, ?, ?, ?, ?)", k, value, target, at, source);
      }
      addSource(target, source);
      return { profile: target, created, merged, conflicts };
    });
  }

  // ---------------------------------------------------------------- Traits and events

  /** Sets traits from a source as of `at`; a value older than the one kept does not replace it. null removes a trait. */
  function setTraits(profile: string, traits: unknown, source: Source, at: string): IgnoredTrait[] {
    if (traits === undefined || traits === null) return [];
    if (!isObj(traits)) throw bad("traits is a map of trait names and values.");
    const ignored: IgnoredTrait[] = [];
    for (const [key, v] of Object.entries(traits)) {
      const t = traitOf(key);
      if (!t) {
        ignored.push({ trait: key, reason: "not in audience.yaml" });
        continue;
      }
      if (t.from && !t.from.includes(source)) {
        ignored.push({ trait: key, reason: `set only from ${t.from.join(", ")}` });
        continue;
      }
      if (v === null) {
        run("DELETE FROM traits WHERE profile = ? AND key = ? AND updated_at <= ?", profile, key, at);
        continue;
      }
      const parsed = traitValue(t, v);
      if ("reason" in parsed) {
        ignored.push({ trait: key, reason: parsed.reason });
        continue;
      }
      run(
        `INSERT INTO traits (profile, key, value, num, folded, updated_at, source) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (profile, key) DO UPDATE SET value = excluded.value, num = excluded.num, folded = excluded.folded,
           updated_at = excluded.updated_at, source = excluded.source WHERE excluded.updated_at >= traits.updated_at`,
        profile,
        key,
        parsed.value,
        parsed.num,
        fold(parsed.value),
        at,
        source,
      );
    }
    return ignored;
  }

  /** Adds an event to a profile's timeline; false when the source sent the same id before. */
  function addEvent(profile: string, e: EventRecord): number | null {
    if (e.external && one("SELECT 1 FROM events WHERE source = ? AND external = ?", e.source, e.external)) return null;
    const r = run(
      "INSERT INTO events (profile, source, type, at, text, props, external, recorded_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      profile,
      e.source,
      e.type,
      e.at,
      e.text,
      e.props ? JSON.stringify(e.props) : null,
      e.external,
      iso(),
    );
    run("UPDATE profiles SET last_at = MAX(COALESCE(last_at, ''), ?), updated_at = ? WHERE id = ?", e.at, iso(), profile);
    run("INSERT INTO daily (day, source, events) VALUES (?, ?, 1) ON CONFLICT (day, source) DO UPDATE SET events = events + 1", e.at.slice(0, 10), e.source);
    addSource(profile, e.source);
    return Number(r.lastInsertRowid);
  }

  /** The sources that may send events over the API: the API itself, and Forms, CRM and Messages once linked in the file. */
  function checkSource(v: unknown, at: string): Source {
    const s = v ?? "api";
    if (s === "api") return "api";
    if (s === "forms" || s === "crm" || s === "messages") {
      if (!config.links.some((l) => l.id === s)) throw bad(`${at}: ${s} is not linked; add it under sources in audience.yaml.`);
      return s;
    }
    throw bad(`${at}.source is api, forms, crm or messages; Analytics and imports are read by Audience itself.`);
  }

  /** POST /api/v1/events: up to 1000 events, checked whole before any is recorded. */
  function ingest(body: unknown) {
    if (!isObj(body) || !Array.isArray(body.events) || body.events.length < 1 || body.events.length > 1000)
      throw bad("The body is { events: [...] } with 1 to 1000 events.");
    const now = clock();
    const parsed = body.events.map((raw, i) => {
      const at = `events[${i}]`;
      if (!isObj(raw)) throw bad(`${at} is a map with type and person.`);
      const extra = Object.keys(raw).filter((k) => !["source", "type", "at", "id", "person", "traits", "properties", "text"].includes(k));
      if (extra.length) throw bad(`${at}: unknown ${extra.join(", ")}; an event takes source, type, at, id, person, traits, properties and text.`);
      const source = checkSource(raw.source, at);
      const person = parsePerson(raw.person, `${at}.person`, config);
      if (raw.traits !== undefined && raw.traits !== null && !isObj(raw.traits)) throw bad(`${at}.traits is a map of trait names and values.`);
      return { source, person, traits: raw.traits, ...parseEventFields(raw, at, now) };
    });
    const changed = new Set<string>();
    const results = tx(() =>
      parsed.map((e) => {
        const r = resolve(e.person, e.source, e.at);
        const ignoredTraits = setTraits(r.profile, e.traits, e.source, e.at);
        const event = addEvent(r.profile, { source: e.source, type: e.type, at: e.at, text: e.text, props: e.props, external: e.external });
        changed.add(r.profile);
        for (const m of r.merged) changed.add(m);
        return { ...r, event, duplicate: event === null, ignoredTraits };
      }),
    );
    hooks.changed(changed);
    // A later event in the batch may have joined an earlier one's profile into another; name the person it is now.
    const now2 = results.map((r) => ({ ...r, profile: current(r.profile) ?? r.profile }));
    return { recorded: now2.filter((r) => !r.duplicate).length, duplicates: now2.filter((r) => r.duplicate).length, results: now2 };
  }

  /** POST /api/v1/profiles: a person and their traits, without an event. */
  function upsert(body: unknown) {
    if (!isObj(body)) throw bad("The body is { person, traits, source }.");
    const extra = Object.keys(body).filter((k) => !["person", "traits", "source"].includes(k));
    if (extra.length) throw bad(`unknown ${extra.join(", ")}; the body takes person, traits and source.`);
    const source = checkSource(body.source, "body");
    const person = parsePerson(body.person, "person", config);
    const at = iso();
    const r = tx(() => {
      const res = resolve(person, source, at);
      run("UPDATE profiles SET last_at = MAX(COALESCE(last_at, ''), ?) WHERE id = ?", at, res.profile);
      return { ...res, ignoredTraits: setTraits(res.profile, body.traits, source, at) };
    });
    hooks.changed(new Set([r.profile, ...r.merged]));
    return { ...r, person: personOf(r.profile)! };
  }

  /** The profile an id names now: itself, or the one it was joined into. */
  function current(id: string): string | null {
    if (one("SELECT 1 FROM profiles WHERE id = ?", id)) return id;
    const m = one<{ into_profile: string }>("SELECT into_profile FROM merges WHERE from_profile = ? ORDER BY id DESC LIMIT 1", id);
    return m && one("SELECT 1 FROM profiles WHERE id = ?", m.into_profile) ? m.into_profile : null;
  }

  // ---------------------------------------------------------------- Reading

  function traitsOf(profile: string) {
    const out: Record<string, string | number | boolean> = {};
    for (const r of all<{ key: string; value: string; num: number | null }>("SELECT key, value, num FROM traits WHERE profile = ? ORDER BY key", profile)) {
      const t = traitOf(r.key);
      out[r.key] = t?.type === "number" && r.num !== null ? r.num : t?.type === "boolean" ? r.value === "true" : r.value;
    }
    return out;
  }

  function present(p: Row) {
    const ids = all<{ kind: IdKind; value: string }>("SELECT kind, value FROM identifiers WHERE profile = ? ORDER BY added_at, value", p.id as string);
    const emails = ids.filter((i) => i.kind === "email").map((i) => i.value);
    const phones = ids.filter((i) => i.kind === "phone").map((i) => i.value);
    return {
      id: p.id as string,
      name: (p.name as string | null) ?? null,
      email: emails[0] ?? null,
      phone: phones[0] ?? null,
      userId: ids.find((i) => i.kind === "user_id")?.value ?? null,
      emails,
      phones,
      traits: traitsOf(p.id as string),
      sources: (p.sources as string).split(" ").filter(Boolean) as Source[],
      firstSource: p.first_source as Source,
      createdAt: p.created_at as string,
      lastAt: (p.last_at as string | null) || null,
    };
  }
  type Person = ReturnType<typeof present>;

  function personOf(id: string): Person | null {
    const p = one<Row>("SELECT * FROM profiles WHERE id = ?", id);
    return p ? present(p) : null;
  }

  function presentEvent(e: Row) {
    return {
      id: e.id as number,
      source: e.source as Source,
      type: e.type as string,
      at: e.at as string,
      text: (e.text as string | null) ?? null,
      properties: e.props ? (JSON.parse(e.props as string) as Record<string, unknown>) : null,
    };
  }

  /** GET /api/v1/people: newest activity first, by part of a name or identifier, exactly by one, or by a trait. */
  function people(
    filter: { q?: string; email?: string; phone?: string; userId?: string; trait?: string; segment?: string },
    cursor: string | undefined,
    max: number,
  ): Page<Person> & { total: number } {
    const where: string[] = [];
    const args: SQLInputValue[] = [];
    const exact = (kind: IdKind, value: string | null) => {
      where.push("EXISTS (SELECT 1 FROM identifiers i WHERE i.profile = p.id AND i.kind = ? AND i.value = ?)");
      args.push(kind, value ?? "\u0000");
    };
    if (filter.email !== undefined) exact("email", normalEmail(filter.email));
    if (filter.phone !== undefined) exact("phone", normalPhone(filter.phone, config.phoneCountry));
    if (filter.userId !== undefined) exact("user_id", normalUserId(filter.userId));
    if (filter.q) {
      const like = `%${filter.q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
      where.push("(p.name LIKE ? ESCAPE '\\' OR EXISTS (SELECT 1 FROM identifiers i WHERE i.profile = p.id AND i.value LIKE ? ESCAPE '\\'))");
      args.push(like, like.toLowerCase());
    }
    if (filter.trait) {
      const at = filter.trait.indexOf(":");
      if (at < 1) throw bad("trait is name:value, such as plan:Free.");
      where.push("EXISTS (SELECT 1 FROM traits t WHERE t.profile = p.id AND t.key = ? AND t.folded = ?)");
      args.push(filter.trait.slice(0, at), fold(filter.trait.slice(at + 1)));
    }
    if (filter.segment) {
      where.push("EXISTS (SELECT 1 FROM segment_members m WHERE m.profile = p.id AND m.segment = ?)");
      args.push(filter.segment);
    }
    const w = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const offset = decodeCursor(cursor);
    const rows = all<Row>(`SELECT * FROM profiles p ${w} ORDER BY COALESCE(p.last_at, p.created_at) DESC, p.id LIMIT ? OFFSET ?`, ...args, max + 1, offset);
    const total = (one<{ n: number }>(`SELECT COUNT(*) AS n FROM profiles p ${w}`, ...args)?.n ?? 0) as number;
    return { items: rows.slice(0, max).map(present), total, ...(rows.length > max && { nextCursor: encodeCursor(offset + max) }) };
  }

  /** A profile's timeline, newest first. */
  function timeline(id: string, cursor: string | undefined, max: number): Page<ReturnType<typeof presentEvent>> {
    const offset = decodeCursor(cursor);
    const rows = all<Row>("SELECT * FROM events WHERE profile = ? ORDER BY at DESC, id DESC LIMIT ? OFFSET ?", id, max + 1, offset);
    return { items: rows.slice(0, max).map(presentEvent), ...(rows.length > max && { nextCursor: encodeCursor(offset + max) }) };
  }

  /** GET /api/v1/people/{id}: the profile, the latest of its timeline and the profiles it was joined from. */
  function person(id: string) {
    const now = current(id);
    if (!now) throw notFound("The person");
    const p = personOf(now)!;
    const events = timeline(now, undefined, 50);
    return {
      ...p,
      mergedFrom: all<{ from_profile: string }>("SELECT from_profile FROM merges WHERE into_profile = ? ORDER BY id", now).map((r) => r.from_profile),
      events: events.items,
      ...(events.nextCursor && { nextCursor: events.nextCursor }),
      eventCount: one<{ n: number }>("SELECT COUNT(*) AS n FROM events WHERE profile = ?", now)!.n,
    };
  }

  /** Everything kept about a person, for a request under KVKK Art. 11 or GDPR Art. 15. */
  function exportPerson(id: string) {
    const now = current(id);
    if (!now) throw notFound("The person");
    return {
      exportedAt: iso(),
      person: personOf(now)!,
      events: all<Row>("SELECT * FROM events WHERE profile = ? ORDER BY at, id", now).map(presentEvent),
      analyticsVisitors: all<{ site: string; visitor: string }>("SELECT site, visitor FROM analytics_visitors WHERE profile = ? ORDER BY site, visitor", now),
    };
  }

  /** Deletes profiles here: identifiers, traits, events and memberships. Returns how many events went with them. */
  function eraseLocal(ids: string[]): { profiles: number; events: number } {
    return tx(() => {
      let events = 0;
      let profiles = 0;
      for (const id of ids) {
        events += one<{ n: number }>("SELECT COUNT(*) AS n FROM events WHERE profile = ?", id)!.n;
        hooks.leaving(id, iso());
        profiles += Number(run("DELETE FROM profiles WHERE id = ?", id).changes);
        // Old ids that led to this person lead nowhere now.
        run("DELETE FROM merges WHERE into_profile = ? OR from_profile = ?", id, id);
      }
      return { profiles, events };
    });
  }

  /** Deletes events older than the file keeps them; the profiles stay. */
  function purge() {
    const before = new Date(clock() - config.keepDays * DAY).toISOString();
    return Number(run("DELETE FROM events WHERE at < ?", before).changes);
  }

  // ---------------------------------------------------------------- Overview

  function summary() {
    const now = clock();
    const day = (offset: number) => new Date(now - offset * DAY).toISOString().slice(0, 10);
    const days = Array.from({ length: 14 }, (_, i) => day(13 - i));
    const profiles = one<{ n: number }>("SELECT COUNT(*) AS n FROM profiles")!.n;
    const byDay = new Map(
      all<{ d: string; n: number }>("SELECT substr(created_at, 1, 10) AS d, COUNT(*) AS n FROM profiles WHERE created_at >= ? GROUP BY d", days[0]!).map(
        (r) => [r.d, r.n],
      ),
    );
    // Profiles there are now, by the day each was first seen: the count at the end of each of the last 14 days.
    let left = profiles;
    const trend: number[] = [];
    for (const d of [...days].reverse()) {
      trend.unshift(left);
      left -= byDay.get(d) ?? 0;
    }
    const daily = all<{ day: string; source: Source; events: number }>("SELECT day, source, events FROM daily WHERE day >= ?", days[0]!);
    const month = new Date(now).toISOString().slice(0, 7);
    return {
      profiles,
      new30d: one<{ n: number }>("SELECT COUNT(*) AS n FROM profiles WHERE created_at >= ?", new Date(now - 30 * DAY).toISOString())!.n,
      trend,
      knownBy: {
        email: one<{ n: number }>("SELECT COUNT(DISTINCT profile) AS n FROM identifiers WHERE kind = 'email'")!.n,
        phone: one<{ n: number }>("SELECT COUNT(DISTINCT profile) AS n FROM identifiers WHERE kind = 'phone'")!.n,
        userId: one<{ n: number }>("SELECT COUNT(DISTINCT profile) AS n FROM identifiers WHERE kind = 'user_id'")!.n,
      },
      mergedThisMonth: one<{ n: number }>("SELECT COUNT(*) AS n FROM merges WHERE at >= ?", `${month}-01`)!.n,
      eventsToday: daily.filter((d) => d.day === day(0)).reduce((n, d) => n + d.events, 0),
      events: days.map((d) => ({
        day: d,
        sources: Object.fromEntries(SOURCES.map((s) => [s, daily.find((x) => x.day === d && x.source === s)?.events ?? 0])) as Record<Source, number>,
      })),
      firstSources: all<{ source: Source; profiles: number }>(
        "SELECT first_source AS source, COUNT(*) AS profiles FROM profiles GROUP BY first_source ORDER BY profiles DESC, source",
      ),
      file: fileState(),
    };
  }

  function gauges() {
    return {
      profiles: one<{ n: number }>("SELECT COUNT(*) AS n FROM profiles")!.n,
      events: one<{ n: number }>("SELECT COUNT(*) AS n FROM events")!.n,
    };
  }

  return {
    db,
    tx,
    all,
    one,
    run,
    hooks,
    clock,
    config: () => config,
    setConfig(c: Config) {
      config = c;
    },
    traitOf,
    resolve,
    setTraits,
    addEvent,
    ingest,
    upsert,
    current,
    personOf,
    person,
    people,
    timeline,
    exportPerson,
    eraseLocal,
    purge,
    summary,
    gauges,
    fileState,
  };
}

export type Audience = ReturnType<typeof createAudience>;
export type Person = NonNullable<ReturnType<Audience["personOf"]>>;
