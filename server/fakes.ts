// Fake Analytics, Consent and a product that takes erasures (Forms, CRM, Messages), for tests. Each answers the routes
// Audience calls, in the shapes their openapi.json documents, and checks the token it was given.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { AnalyticsEvent, AnalyticsVisit, ConsentPerson } from "./links.ts";

async function listen(handle: (req: IncomingMessage, res: ServerResponse, url: URL, body: string) => void, token: string) {
  const calls: Array<{ method: string; path: string; query: string; body: string }> = [];
  let failNext = 0;
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req as AsyncIterable<Buffer>) chunks.push(c);
    const body = Buffer.concat(chunks).toString("utf8");
    const url = new URL(req.url ?? "/", "http://localhost");
    calls.push({ method: req.method ?? "GET", path: url.pathname, query: url.search, body });
    const json = (status: number, data: unknown) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(data));
    if (req.headers.authorization !== `Bearer ${token}`) return json(401, { code: "unauthenticated", detail: "Sign in or send an API token." });
    if (failNext > 0) {
      failNext--;
      return json(503, { code: "internal-error", detail: "down for a moment" });
    }
    handle(req, res, url, body);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    url,
    calls,
    fail: (n: number) => void (failNext = n),
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

const send = (res: ServerResponse, status: number, data?: unknown) =>
  data === undefined ? res.writeHead(status).end() : res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(data));

export interface FakeVisit extends AnalyticsVisit {
  timeline: AnalyticsEvent[];
}

/** Analytics: GET /api/v1/visits (newest activity first, paged), GET /api/v1/visits/{id}, DELETE /api/v1/visitors/{id}. */
export async function fakeAnalytics(token = "analytics-token", sites = ["shop"]) {
  const visits: FakeVisit[] = [];
  const deleted: string[] = [];
  const pageSize = 2;
  const srv = await listen((req, res, url) => {
    const site = url.searchParams.get("site") ?? "";
    if (!sites.includes(site)) return send(res, 404, { code: "not-found", detail: "The site does not exist." });
    const visit = /^\/api\/v1\/visits\/([^/]+)$/.exec(url.pathname);
    const visitor = /^\/api\/v1\/visitors\/([^/]+)$/.exec(url.pathname);
    if (req.method === "GET" && url.pathname === "/api/v1/visits") {
      const user = url.searchParams.get("user");
      const who = url.searchParams.get("visitor");
      const list = visits
        .filter((v) => v.site === site && (!user || v.user === user) && (!who || v.visitor === who))
        .sort((a, b) => (a.lastAt < b.lastAt ? 1 : -1));
      const offset = Number(url.searchParams.get("cursor") ?? 0);
      const page = list.slice(offset, offset + pageSize).map(({ timeline: _t, ...v }) => v);
      return send(res, 200, { visits: page, ...(offset + pageSize < list.length && { nextCursor: String(offset + pageSize) }) });
    }
    if (req.method === "GET" && visit) {
      const v = visits.find((x) => x.id === decodeURIComponent(visit[1]!) && x.site === site);
      return v ? send(res, 200, v) : send(res, 404, { code: "not-found" });
    }
    if (req.method === "DELETE" && visitor) {
      const id = decodeURIComponent(visitor[1]!);
      const before = visits.length;
      for (let i = visits.length - 1; i >= 0; i--) if (visits[i]!.visitor === id && visits[i]!.site === site) visits.splice(i, 1);
      if (before === visits.length) return send(res, 404, { code: "not-found", detail: "The visitor does not exist." });
      deleted.push(`${site}:${id}`);
      return send(res, 204);
    }
    send(res, 404, { code: "not-found" });
  }, token);

  let n = 0;
  /** Adds a visit with its page views, as Analytics keeps it. */
  function visit(v: { site?: string; visitor: string; user?: string | null; at: string; pages?: string[]; events?: AnalyticsEvent[]; source?: string }) {
    const start = Date.parse(v.at);
    const timeline: AnalyticsEvent[] = [
      ...(v.pages ?? ["/"]).map((path, i) => ({
        type: "pageview" as const,
        at: new Date(start + i * 60_000).toISOString(),
        path,
        title: null,
        name: null,
        props: null,
        form: null,
        action: null,
      })),
      ...(v.events ?? []),
    ];
    const last = timeline
      .map((e) => e.at)
      .sort()
      .at(-1)!;
    const x: FakeVisit = {
      id: `visit-${++n}`,
      site: v.site ?? "shop",
      visitor: v.visitor,
      user: v.user ?? null,
      startedAt: v.at,
      lastAt: last,
      entry: v.pages?.[0] ?? "/",
      source: v.source ?? null,
      referrer: null,
      utm: { source: null, medium: null, campaign: null },
      device: "desktop",
      timeline,
    };
    visits.push(x);
    return x;
  }
  return { ...srv, visits, deleted, visit };
}

/** Consent: GET /api/v1/people?q=, GET /api/v1/people/{id}, DELETE /api/v1/people/{id}?reason=. */
export async function fakeConsent(token = "consent-token") {
  const people: Array<ConsentPerson & { standing: NonNullable<ConsentPerson["standing"]> }> = [];
  const erased: Array<{ id: string; reason: string }> = [];
  const srv = await listen((req, res, url) => {
    const one = /^\/api\/v1\/people\/([^/]+)$/.exec(url.pathname);
    if (req.method === "GET" && url.pathname === "/api/v1/people") {
      const q = (url.searchParams.get("q") ?? "").toLowerCase();
      const found = people.filter((p) => [...p.emails, ...p.phones, ...p.ids].some((x) => x.toLowerCase().includes(q)));
      return send(res, 200, { people: found.map(({ standing: _s, ...p }) => p) });
    }
    if (one) {
      const id = decodeURIComponent(one[1]!);
      const i = people.findIndex((p) => p.id === id);
      if (i < 0) return send(res, 404, { code: "not-found", detail: "The person does not exist." });
      if (req.method === "GET") return send(res, 200, people[i]);
      if (req.method === "DELETE") {
        const reason = url.searchParams.get("reason") ?? "";
        if (reason.length < 3) return send(res, 422, { code: "invalid-body", detail: "reason says why" });
        people.splice(i, 1);
        erased.push({ id, reason });
        return send(res, 200, { id: 1, person: id, at: new Date().toISOString(), actor: "token:audience", reason, answers: 1, identifiers: 1, iysRefusals: 0 });
      }
    }
    send(res, 404, { code: "not-found" });
  }, token);
  let n = 0;
  function person(p: { emails?: string[]; phones?: string[]; ids?: string[]; granted?: boolean }) {
    const x = {
      id: `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`,
      emails: p.emails ?? [],
      phones: p.phones ?? [],
      ids: p.ids ?? [],
      standing: [
        {
          purpose: "marketing",
          channel: "email",
          status: p.granted === false ? "withdrawn" : "granted",
          allowed: p.granted !== false,
          version: 3,
          at: "2026-11-01T10:00:00.000Z",
          source: "form",
        },
        { purpose: "marketing", channel: "sms", status: "none", allowed: false, version: null, at: null, source: null },
      ],
    };
    people.push(x);
    return x;
  }
  return { ...srv, people, erased, person };
}

/** A product that takes POST /api/v1/erasures, as Forms, CRM and Messages will: done, or waiting with a reason. */
export async function fakeErasures(token = "crm-token") {
  const received: Array<{ reference: string; people: { emails: string[]; phones: string[]; userIds: string[] } }> = [];
  let answer: { status: number; body: unknown } = { status: 200, body: { status: "done", deleted: 1 } };
  const srv = await listen((req, res, url, body) => {
    if (req.method === "POST" && url.pathname === "/api/v1/erasures") {
      received.push(JSON.parse(body));
      return send(res, answer.status, answer.body);
    }
    send(res, 404, { code: "not-found" });
  }, token);
  return { ...srv, received, answer: (status: number, body: unknown) => void (answer = { status, body }) };
}
