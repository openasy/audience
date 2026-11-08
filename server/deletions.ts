// Deletion on request (KVKK Art. 7 and 11, GDPR Art. 17). The person's profile, identifiers, traits, events and
// memberships are deleted here at once, and every linked product with delete: true is asked to delete them too: each
// product's part is a task that is tried until it is done, waits while the product says it must keep the person for now,
// and fails with the product's own message when trying again would not help. The log keeps the request's reference,
// who recorded it, when, and how much was deleted where; a task holds the identifiers its product needs only until it
// is done, and never after.
import type { Audience } from "./audience.ts";
import { newId, parsePerson } from "./audience.ts";
import type { LinkedProduct } from "./config.ts";
import { AudienceError, DAY, bad, decodeCursor, encodeCursor, isObj, notFound, type Page } from "./errors.ts";
import { analyticsVisitorsOf, consentPeople, LinkError, type Links } from "./links.ts";
import { log } from "./log.ts";

/** What a product needs to find the person: their identifiers, and for Analytics the visitors known to be them. */
export interface Who {
  emails: string[];
  phones: string[];
  userIds: string[];
  visitors: Array<{ site: string; visitor: string }>;
}

type State = "pending" | "waiting" | "done" | "failed";
const WAIT = 60 * 60_000;
const MAX_BACKOFF = 6 * 60 * 60_000;

/** What a linked product answers to POST /api/v1/erasures, the call every product that keeps people takes from Audience. */
interface Erasure {
  status: "done" | "waiting";
  deleted?: number;
  detail?: string;
}

export function createDeletions(a: Audience, links: Links) {
  const { all, one, run, tx, clock } = a;
  const iso = () => new Date(clock()).toISOString();
  let running: Promise<void> | null = null;

  /** POST /api/v1/deletions and DELETE /api/v1/people/{id}: deletes here now, and queues each linked product's part. */
  function request(body: unknown, actor: string) {
    if (!isObj(body)) throw bad("The body is { reference, profile } or { reference, person }.");
    const extra = Object.keys(body).filter((k) => !["reference", "profile", "person"].includes(k));
    if (extra.length) throw bad(`unknown ${extra.join(", ")}; a deletion takes reference, and profile or person.`);
    const reference = typeof body.reference === "string" ? body.reference.trim() : "";
    if (reference.length < 3 || reference.length > 100) throw bad("reference is the request's own reference, such as KVKK-2026-031, 3 to 100 characters.");
    if ((body.profile === undefined) === (body.person === undefined))
      throw bad("Name the person by profile (an id this API returned) or by person (email, phone, userId).");
    const config = a.config();
    const who: Who = { emails: [], phones: [], userIds: [], visitors: [] };
    const profiles = new Set<string>();
    if (typeof body.profile === "string") {
      const p = a.current(body.profile);
      if (!p) throw notFound("The person");
      profiles.add(p);
    } else {
      const ids = parsePerson(body.person, "person", { ...config, matchBy: ["email", "phone", "user_id"] });
      if (ids.email) who.emails.push(ids.email);
      if (ids.phone) who.phones.push(ids.phone);
      if (ids.userId) who.userIds.push(ids.userId);
      // Every profile with any of them goes, whatever the file matches by: a deletion errs on the side of the person.
      for (const [kind, v] of [
        ["email", ids.email],
        ["phone", ids.phone],
        ["user_id", ids.userId],
      ] as const)
        if (v) for (const r of all<{ profile: string }>("SELECT profile FROM identifiers WHERE kind = ? AND value = ?", kind, v)) profiles.add(r.profile);
    }
    for (const p of profiles) {
      for (const r of all<{ kind: string; value: string }>("SELECT kind, value FROM identifiers WHERE profile = ?", p)) {
        const list = r.kind === "email" ? who.emails : r.kind === "phone" ? who.phones : who.userIds;
        if (!list.includes(r.value)) list.push(r.value);
      }
      who.visitors.push(...all<{ site: string; visitor: string }>("SELECT site, visitor FROM analytics_visitors WHERE profile = ?", p));
    }
    const id = newId();
    const at = iso();
    const targets = config.links.filter((l) => l.delete).map((l) => l.id);
    const out = tx(() => {
      const gone = a.eraseLocal([...profiles]);
      run("INSERT INTO deletions (id, reference, at, actor, profiles, events) VALUES (?, ?, ?, ?, ?, ?)", id, reference, at, actor, gone.profiles, gone.events);
      for (const product of targets)
        run("INSERT INTO deletion_tasks (deletion, product, state, people, next_at) VALUES (?, ?, 'pending', ?, ?)", id, product, JSON.stringify(who), at);
      return gone;
    });
    log("info", "deleted on request", { deletion: id, reference, profiles: out.profiles, events: out.events, products: targets });
    void tick();
    return get(id);
  }

  /** One product's part. Throws LinkError when it could not be done now. */
  async function perform(product: LinkedProduct, who: Who, reference: string): Promise<{ state: "done" | "waiting"; deleted: number; detail: string | null }> {
    const c = links.client(product);
    if (product === "analytics") {
      let deleted = 0;
      for (const site of links.link("analytics")?.sites ?? []) {
        const visitors = new Set(who.visitors.filter((v) => v.site === site).map((v) => v.visitor));
        for (const u of who.userIds) for (const v of await analyticsVisitorsOf(c, site, u)) visitors.add(v);
        for (const v of visitors) {
          const r = await c.call("DELETE", `/api/v1/visitors/${encodeURIComponent(v)}`, { site });
          if (r.status !== 404) deleted++;
        }
      }
      return { state: "done", deleted, detail: null };
    }
    if (product === "consent") {
      let deleted = 0;
      for (const p of await consentPeople(c, who)) {
        const r = await c.call("DELETE", `/api/v1/people/${encodeURIComponent(p.id)}`, { reason: reference });
        if (r.status !== 404) deleted++;
      }
      return { state: "done", deleted, detail: null };
    }
    // Forms, CRM and Messages take the same call: the identifiers, and the reference to log and to answer again by.
    const r = await c.call("POST", "/api/v1/erasures", undefined, {
      reference,
      product: "audience",
      people: { emails: who.emails, phones: who.phones, userIds: who.userIds },
    });
    const e = r.body as Erasure | null;
    if (r.status === 404 || !e || (e.status !== "done" && e.status !== "waiting"))
      throw new LinkError(`The ${product} product does not take POST /api/v1/erasures yet, or answered something else.`, r.status, true);
    return { state: e.status, deleted: typeof e.deleted === "number" ? e.deleted : 0, detail: typeof e.detail === "string" ? e.detail.slice(0, 500) : null };
  }

  /** Tries every task that is due; at most one round at a time. */
  function tick(): Promise<void> {
    if (running) return running;
    running = (async () => {
      const due = all<{ deletion: string; product: LinkedProduct; people: string | null; attempts: number }>(
        "SELECT deletion, product, people, attempts FROM deletion_tasks WHERE state IN ('pending', 'waiting') AND next_at <= ? ORDER BY next_at LIMIT 100",
        iso(),
      );
      for (const t of due) {
        const reference = one<{ reference: string }>("SELECT reference FROM deletions WHERE id = ?", t.deletion)!.reference;
        const who = JSON.parse(t.people ?? '{"emails":[],"phones":[],"userIds":[],"visitors":[]}') as Who;
        try {
          const r = await perform(t.product, who, reference);
          if (r.state === "done")
            run(
              "UPDATE deletion_tasks SET state = 'done', people = NULL, deleted = ?, detail = ?, done_at = ?, attempts = attempts + 1 WHERE deletion = ? AND product = ?",
              r.deleted,
              r.detail,
              iso(),
              t.deletion,
              t.product,
            );
          else
            run(
              "UPDATE deletion_tasks SET state = 'waiting', detail = ?, next_at = ?, attempts = attempts + 1 WHERE deletion = ? AND product = ?",
              r.detail,
              new Date(clock() + WAIT).toISOString(),
              t.deletion,
              t.product,
            );
        } catch (err) {
          const e = err instanceof LinkError ? err : new LinkError(String(err), null, false);
          if (e.permanent)
            run(
              "UPDATE deletion_tasks SET state = 'failed', detail = ?, attempts = attempts + 1 WHERE deletion = ? AND product = ?",
              e.message,
              t.deletion,
              t.product,
            );
          else
            run(
              "UPDATE deletion_tasks SET state = 'pending', detail = ?, next_at = ?, attempts = attempts + 1 WHERE deletion = ? AND product = ?",
              e.message,
              new Date(clock() + Math.min(MAX_BACKOFF, 60_000 * 2 ** t.attempts)).toISOString(),
              t.deletion,
              t.product,
            );
          log("warn", "deletion not done in a linked product", { deletion: t.deletion, product: t.product, error: e.message });
        }
      }
    })().finally(() => (running = null));
    return running;
  }

  /** Failed parts are tried again now, after someone fixed the token or the address. */
  async function retry(id: string) {
    if (!one("SELECT 1 FROM deletions WHERE id = ?", id)) throw notFound("The deletion");
    const n = Number(
      run("UPDATE deletion_tasks SET state = 'pending', next_at = ? WHERE deletion = ? AND state IN ('failed', 'waiting', 'pending')", iso(), id).changes,
    );
    if (!n) throw new AudienceError(409, "conflict", "Every linked product has done its part already.");
    await tick();
    return get(id);
  }

  function presentTasks(id: string) {
    return all<{ product: string; state: State; attempts: number; detail: string | null; deleted: number | null; done_at: string | null; next_at: string }>(
      "SELECT product, state, attempts, detail, deleted, done_at, next_at FROM deletion_tasks WHERE deletion = ? ORDER BY product",
      id,
    ).map((t) => ({
      product: t.product,
      state: t.state,
      attempts: t.attempts,
      detail: t.detail,
      deleted: t.deleted,
      doneAt: t.done_at,
      nextAt: t.state === "done" || t.state === "failed" ? null : t.next_at,
    }));
  }

  function present(d: { id: string; reference: string; at: string; actor: string; profiles: number; events: number }) {
    const tasks = presentTasks(d.id);
    const state: State = tasks.some((t) => t.state === "failed")
      ? "failed"
      : tasks.some((t) => t.state === "pending")
        ? "pending"
        : tasks.some((t) => t.state === "waiting")
          ? "waiting"
          : "done";
    return { id: d.id, reference: d.reference, at: d.at, actor: d.actor, profiles: d.profiles, events: d.events, state, products: tasks };
  }

  function get(id: string) {
    const d = one<{ id: string; reference: string; at: string; actor: string; profiles: number; events: number }>("SELECT * FROM deletions WHERE id = ?", id);
    if (!d) throw notFound("The deletion");
    return present(d);
  }

  function list(cursor: string | undefined, max: number): Page<ReturnType<typeof present>> {
    const offset = decodeCursor(cursor);
    const rows = all<{ id: string; reference: string; at: string; actor: string; profiles: number; events: number }>(
      "SELECT * FROM deletions ORDER BY at DESC, id LIMIT ? OFFSET ?",
      max + 1,
      offset,
    );
    return { items: rows.slice(0, max).map(present), ...(rows.length > max && { nextCursor: encodeCursor(offset + max) }) };
  }

  function counts() {
    const rows = all<{ state: State; n: number }>("SELECT state, COUNT(DISTINCT deletion) AS n FROM deletion_tasks GROUP BY state");
    return Object.fromEntries(rows.map((r) => [r.state, r.n])) as Partial<Record<State, number>>;
  }

  /** Tasks stuck far longer than any product should need still show; nothing is dropped silently. */
  const stale = () =>
    one<{ n: number }>("SELECT COUNT(*) AS n FROM deletion_tasks WHERE state != 'done' AND next_at < ?", new Date(clock() - 30 * DAY).toISOString())!.n;

  return { request, tick, retry, get, list, counts, stale };
}

export type Deletions = ReturnType<typeof createDeletions>;
