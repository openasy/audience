// Reads Analytics: the visits of identified visitors, as they happen. Analytics keeps the user id a site gives its
// signed-in visitors (openasy.identify()); every visit with one becomes part of that person's profile, matched by the
// user id and nothing else, with the visitor's earlier and later visits on the same site. Visits without a user id of
// visitors never identified stay in Analytics.
import { createHash } from "node:crypto";
import type { Audience, EventRecord } from "./audience.ts";
import { DAY } from "./errors.ts";
import { analyticsVisits, LinkError, type AnalyticsEvent, type AnalyticsVisit, type Client, type Links } from "./links.ts";
import { log } from "./log.ts";

const TYPE = /^[a-z0-9][a-z0-9_.:-]{0,63}$/;

/** What a visit becomes on the timeline: its start, page views, the site's own events and forms sent. */
export function visitEvents(site: string, v: AnalyticsVisit, timeline: AnalyticsEvent[]): EventRecord[] {
  const base = { site, visit: v.id, visitor: v.visitor };
  const out: EventRecord[] = [
    {
      source: "analytics",
      type: "visit_started",
      at: v.startedAt,
      text: v.source ? `Visited ${site} from ${v.source}` : `Visited ${site}`,
      props: {
        ...base,
        entry: v.entry,
        source: v.source,
        referrer: v.referrer,
        utm_source: v.utm.source,
        utm_medium: v.utm.medium,
        utm_campaign: v.utm.campaign,
        device: v.device,
      },
      external: `${site}:${v.id}:start`,
    },
  ];
  for (const e of timeline) {
    const id = `${site}:${v.id}:${createHash("sha256").update(JSON.stringify(e)).digest("base64url").slice(0, 16)}`;
    if (e.type === "pageview" && e.path)
      out.push({
        source: "analytics",
        type: "page_viewed",
        at: e.at,
        text: `Viewed ${e.path}`,
        props: { ...base, path: e.path, title: e.title },
        external: id,
      });
    else if (e.type === "event" && e.name) {
      const type = e.name
        .toLowerCase()
        .replace(/[^a-z0-9_.:-]+/g, "_")
        .slice(0, 64);
      if (!TYPE.test(type)) continue;
      const props: Record<string, unknown> = { ...base, path: e.path };
      for (const [k, x] of Object.entries(e.props ?? {})) if (!(k in props) && (typeof x !== "object" || x === null)) props[k] = x;
      out.push({ source: "analytics", type, at: e.at, text: e.path ? `${e.name} on ${e.path}` : e.name, props, external: id });
    } else if (e.type === "form" && e.action === "submit" && e.form)
      out.push({
        source: "analytics",
        type: "form_submitted",
        at: e.at,
        text: `Sent the form ${e.form} on ${e.path ?? site}`,
        props: { ...base, form: e.form, path: e.path },
        external: id,
      });
  }
  return out;
}

export function createPull(a: Audience, links: Links) {
  const { one, run, all, clock } = a;
  let running: Promise<number> | null = null;
  let lastRun = 0;

  const key = (site: string) => `analytics:${site}`;
  function setState(site: string, fields: { cursor?: string | null; error?: string | null; ok?: boolean; read?: number }) {
    const at = new Date(clock()).toISOString();
    run("INSERT OR IGNORE INTO source_state (source) VALUES (?)", key(site));
    if (fields.cursor !== undefined) run("UPDATE source_state SET cursor = ? WHERE source = ?", fields.cursor, key(site));
    run("UPDATE source_state SET last_at = ?, error = ? WHERE source = ?", at, fields.error ?? null, key(site));
    if (fields.ok) run("UPDATE source_state SET last_ok_at = ?, read = read + ? WHERE source = ?", at, fields.read ?? 0, key(site));
  }

  /** Adds one visit to its person: fetched with everything it sent, each event once however often it is read. */
  async function importVisit(c: Client, site: string, v: AnalyticsVisit, profile: string, changed: Set<string>) {
    const r = await c.call("GET", `/api/v1/visits/${encodeURIComponent(v.id)}`, { site });
    if (r.status === 404) return 0;
    const detail = r.body as AnalyticsVisit & { timeline: AnalyticsEvent[] };
    let n = 0;
    a.tx(() => {
      const who = a.current(profile);
      if (!who) return;
      run("INSERT OR IGNORE INTO analytics_visitors (site, visitor, profile) VALUES (?, ?, ?)", site, v.visitor, who);
      for (const e of visitEvents(site, detail, detail.timeline ?? [])) if (a.addEvent(who, e) !== null) n++;
      changed.add(who);
    });
    return n;
  }

  async function site(c: Client, name: string, changed: Set<string>) {
    const cursor = one<{ cursor: string | null }>("SELECT cursor FROM source_state WHERE source = ?", key(name))?.cursor ?? null;
    // The first read goes back as far as events are kept.
    const floor = cursor ?? new Date(clock() - a.config().keepDays * DAY).toISOString();
    let newest = cursor;
    let page: string | undefined;
    let read = 0;
    const seenVisitors = new Set<string>();
    for (let n = 0; n < 500; n++) {
      const r = await analyticsVisits(c, name, { cursor: page });
      let done = false;
      for (const v of r.visits) {
        if (v.lastAt <= floor) {
          done = true;
          break;
        }
        if (!newest || v.lastAt > newest) newest = v.lastAt;
        let profile: string | null = null;
        if (v.user) {
          const res = a.resolve({ email: null, phone: null, userId: v.user, name: null }, "analytics", v.startedAt);
          profile = res.profile;
          for (const m of res.merged) changed.add(m);
        } else profile = one<{ profile: string }>("SELECT profile FROM analytics_visitors WHERE site = ? AND visitor = ?", name, v.visitor)?.profile ?? null;
        if (!profile) continue;
        const known = !!one("SELECT 1 FROM analytics_visitors WHERE site = ? AND visitor = ?", name, v.visitor);
        read += await importVisit(c, name, v, profile, changed);
        // A visitor seen identified for the first time brings their earlier visits, before they signed in.
        if (!known && !seenVisitors.has(v.visitor)) {
          seenVisitors.add(v.visitor);
          let vc: string | undefined;
          for (let m = 0; m < 20; m++) {
            const earlier = await analyticsVisits(c, name, { visitor: v.visitor, cursor: vc });
            for (const x of earlier.visits)
              if (x.id !== v.id && x.lastAt > new Date(clock() - a.config().keepDays * DAY).toISOString())
                read += await importVisit(c, name, x, profile, changed);
            if (!earlier.nextCursor) break;
            vc = earlier.nextCursor;
          }
        }
      }
      if (done || !r.nextCursor) break;
      page = r.nextCursor;
    }
    setState(name, { cursor: newest, ok: true, read });
    return read;
  }

  /** Reads every site once; at most one read at a time. */
  async function tick({ force = false } = {}): Promise<number> {
    const link = links.link("analytics");
    if (!link) return 0;
    if (!force && clock() - lastRun < link.pull * 60_000) return 0;
    if (running) return running;
    lastRun = clock();
    running = (async () => {
      let total = 0;
      const changed = new Set<string>();
      for (const name of link.sites) {
        try {
          if (!a.config().matchBy.includes("user_id"))
            throw new LinkError("match_by leaves out user_id, so Analytics' visitors cannot be matched to anyone.", null, true);
          total += await site(links.client("analytics"), name, changed);
        } catch (err) {
          const message = err instanceof LinkError ? err.message : String(err);
          setState(name, { error: message });
          log("warn", "analytics not read", { site: name, error: message });
        }
      }
      a.hooks.changed(changed);
      return total;
    })().finally(() => (running = null));
    return running;
  }

  function status() {
    const link = links.link("analytics");
    if (!link) return [];
    return link.sites.map((s) => {
      const r = all<{ last_at: string | null; last_ok_at: string | null; error: string | null; read: number }>(
        "SELECT last_at, last_ok_at, error, read FROM source_state WHERE source = ?",
        key(s),
      )[0];
      return { site: s, lastAt: r?.last_at ?? null, lastOkAt: r?.last_ok_at ?? null, error: r?.error ?? null, events: r?.read ?? 0 };
    });
  }

  return { tick, status };
}

export type Pull = ReturnType<typeof createPull>;
