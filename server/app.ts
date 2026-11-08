import { timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extname, join, normalize } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { AuthError, identityOrigin, mergeOpenApi, sendProblem, type Auth, type Principal, type Role } from "@openasy/auth";
import type { Audience } from "./audience.ts";
import type { Deletions } from "./deletions.ts";
import { AudienceError, bad, notFound, parseLimit, type ProblemCode } from "./errors.ts";
import { MAX_BYTES, type Imports } from "./imports.ts";
import { consentPeople, LinkError, type Links } from "./links.ts";
import { log } from "./log.ts";
import { countRequest, renderMetrics } from "./metrics.ts";
import type { ProductLink } from "./products.ts";
import type { Pull } from "./pull.ts";
import type { Segments } from "./segments.ts";

export interface AppOptions {
  db: DatabaseSync;
  audience: Audience;
  segments: Segments;
  imports: Imports;
  deletions: Deletions;
  links: Links;
  pull: Pull;
  version: string;
  /** Sign-in, sessions, members and API tokens (ADR 0002, 0003). */
  auth: Auth;
  /** For tests and local scripts: one shared token with the admin role. main.ts never sets it. */
  adminToken?: string;
  /** Built web UI; omit to run headless (ADR 0018). */
  webDir?: string;
  /** Built API reference (Swagger UI), served at /api/docs. */
  docsDir?: string;
  /** The OpenAPI description, served at /api/openapi.json with this release's version. */
  openapi?: Record<string, unknown>;
  /** false when /metrics is served on its own port instead (ADR 0026). */
  serveMetrics?: boolean;
  /** The install's OpenAsy products and their addresses, from OPENASY_PRODUCTS, for the product switcher. */
  products?: ProductLink[];
}

type Parts = Pick<AppOptions, "audience" | "segments" | "deletions" | "pull">;

function metricsText({ audience, segments, deletions, pull }: Parts, version: string) {
  return renderMetrics(version, {
    ...audience.gauges(),
    segments: segments.count(),
    deletions: deletions.counts(),
    sourceErrors: pull.status().filter((s) => s.error).length,
    fileError: !!audience.fileState()?.error,
  });
}

/** Serves only /metrics, for a port that is not exposed with the rest (AUDIENCE_METRICS_PORT). */
export function createMetricsHandler(parts: Parts, version: string) {
  return (req: IncomingMessage, res: ServerResponse) => {
    if (new URL(req.url ?? "/", "http://localhost").pathname !== "/metrics") return problem(res, 404, "not-found");
    send(res, 200, metricsText(parts, version), "text/plain; version=0.0.4");
  };
}

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".json": "application/json",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

// Identity keeps people's theme and language when they sign in through it; the pages read them there (ADR 0033).
const IDENTITY = identityOrigin(process.env);

/** The pages run nothing from elsewhere. */
const SECURITY_HEADERS = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "x-frame-options": "DENY",
  "content-security-policy": `default-src 'self'; connect-src 'self'${IDENTITY ? ` ${IDENTITY}` : ""}; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; font-src 'self' data:; frame-ancestors 'none'`,
};

/** Largest JSON body: a batch of 1000 events with their properties is under 5 MiB. */
const API_LIMIT = 5 * 1024 * 1024;

function send(res: ServerResponse, status: number, body: string | Buffer, type = "application/json", headers: Record<string, string> = {}) {
  res.writeHead(status, { ...SECURITY_HEADERS, ...headers, "content-type": type, "content-length": Buffer.byteLength(body) });
  res.end(body);
}

const json = (res: ServerResponse, status: number, data: unknown) => send(res, status, JSON.stringify(data));

const TITLES: Record<ProblemCode, string> = {
  "invalid-json": "Invalid JSON",
  "invalid-body": "Invalid request body",
  "not-found": "Not found",
  conflict: "Conflict",
  "not-configured": "Not configured",
  "payload-too-large": "Payload too large",
  "upstream-error": "A linked product did not answer",
  "internal-error": "Internal error",
};

/** RFC 9457 Problem Details (ADR 0024). `code` is the stable part clients match on. */
function problem(res: ServerResponse, status: number, code: ProblemCode, detail?: string) {
  const body = { type: `https://openasy.github.io/problems/${code}`, title: TITLES[code], status, code, ...(detail && { detail }) };
  send(res, status, JSON.stringify(body), "application/problem+json");
}

/** Serves a file from dir, or returns false when the path is outside it or missing. */
async function serveFile(res: ServerResponse, dir: string, relative: string): Promise<boolean> {
  const file = normalize(join(dir, relative));
  if (!file.startsWith(normalize(dir)) || !extname(file)) return false;
  try {
    send(res, 200, await readFile(file), TYPES[extname(file)] ?? "application/octet-stream");
    return true;
  } catch {
    return false;
  }
}

async function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  const tooLarge = () => new AudienceError(413, "payload-too-large", `The body must be at most ${Math.round(limit / 1024 / 1024)} MiB.`);
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    // A body a little too large is read to its end and dropped, so the client gets the answer; a far larger one is cut.
    if (size > 2 * limit) throw tooLarge();
    if (size <= limit) chunks.push(chunk);
  }
  if (size > limit) throw tooLarge();
  return Buffer.concat(chunks);
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const body = await readBody(req, API_LIMIT);
  try {
    return JSON.parse(body.toString("utf8"));
  } catch {
    throw new AudienceError(400, "invalid-json", "The body must be a JSON object.");
  }
}

function tokenMatches(header: string | undefined, expected: string | undefined): boolean {
  if (!expected || !header?.startsWith("Bearer ")) return false;
  const a = Buffer.from(header.slice(7));
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** The role a route needs (ADR 0003); "none" for the version. */
type Access = "none" | Role;
interface Ctx {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  params: string[];
  /** Who called, as segments and deletions record them: a member's email or an API token's name. */
  actor: string;
}
interface Route {
  method: string;
  /** Path pattern; each `:name` matches one segment. */
  path: string;
  auth: Access;
  handle: (ctx: Ctx) => unknown;
}

const actorOf = (p: Principal | null) => (!p ? "admin token" : p.kind === "session" ? p.user.email : `token:${p.name}`);

export function createApp({
  db,
  audience,
  segments,
  imports,
  deletions,
  links,
  pull,
  version,
  auth,
  adminToken,
  webDir,
  docsDir,
  openapi,
  serveMetrics = true,
  products = [],
}: AppOptions) {
  // The served description includes /api/v1/auth from @openasy/auth, so the API reference documents sign-in too.
  const spec = openapi && JSON.stringify({ ...mergeOpenApi(openapi), info: { ...(openapi.info as object), version } });
  const q = (url: URL, k: string) => url.searchParams.get(k) ?? undefined;
  const cursor = (url: URL) => q(url, "cursor");
  const limit = (url: URL, max = 500) => parseLimit(url.searchParams.get("limit"), max);
  const page = <K extends string, T>(key: K, p: { items: T[]; nextCursor?: string }) =>
    ({ [key]: p.items, ...(p.nextCursor && { nextCursor: p.nextCursor }) }) as Record<K, T[]> & { nextCursor?: string };
  const status = (res: ServerResponse, code: number, data: unknown) => json(res, code, data);
  const noContent = (res: ServerResponse) => void res.writeHead(204, SECURITY_HEADERS).end();
  const person = (id: string) => {
    const now = audience.current(id);
    if (!now) throw notFound("The person");
    return now;
  };

  function sources() {
    const pulls = pull.status();
    return links.state().map((l) => ({
      id: l.id,
      url: l.url,
      token: l.tokenVariable ? { variable: l.tokenVariable, set: l.tokenSet } : null,
      delete: l.link.delete,
      ...(l.id === "analytics" && { pull: l.link.pull, sites: pulls }),
      events7d: audience.one<{ n: number }>(
        "SELECT COALESCE(SUM(events), 0) AS n FROM daily WHERE source = ? AND day >= ?",
        l.id,
        new Date(audience.clock() - 6 * 86_400_000).toISOString().slice(0, 10),
      )!.n,
    }));
  }

  /** What the person agreed to in Consent, when it is linked; a Consent that cannot be reached says so. */
  async function consentOf(id: string) {
    const p = audience.personOf(person(id))!;
    if (!links.has("consent")) return { linked: false, people: [], error: null };
    try {
      const c = links.client("consent");
      const found = await consentPeople(c, { emails: p.emails, phones: p.phones, userIds: p.userId ? [p.userId] : [] });
      const people = [];
      for (const f of found.slice(0, 5)) {
        const r = await c.call("GET", `/api/v1/people/${encodeURIComponent(f.id)}`);
        if (r.status === 404) continue;
        const standing = ((r.body as { standing?: NonNullable<typeof f.standing> }).standing ?? []).filter((s) => s.status !== "none");
        people.push({ id: f.id, standing });
      }
      return { linked: true, people, error: null };
    } catch (err) {
      return { linked: true, people: [], error: err instanceof LinkError ? err.message : String(err) };
    }
  }

  const routes: Route[] = [
    { method: "GET", path: "/api/v1/version", auth: "none", handle: () => ({ product: "audience", version }) },
    { method: "GET", path: "/api/v1/products", auth: "viewer", handle: () => ({ products }) },
    {
      method: "GET",
      path: "/api/v1/summary",
      auth: "viewer",
      handle: () => ({
        ...audience.summary(),
        segments: segments.list().map((s) => ({ id: s.id, name: s.name, size: s.size, change30d: s.change30d, usedBy: s.usedBy })),
        deletions: deletions.counts(),
        sources: sources(),
      }),
    },
    {
      method: "GET",
      path: "/api/v1/config",
      auth: "viewer",
      handle: () => {
        const c = audience.config();
        return {
          file: audience.fileState(),
          text: c.text,
          matchBy: c.matchBy,
          phoneCountry: c.phoneCountry,
          traits: c.traits,
          keepDays: c.keepDays,
          recountMinutes: c.recountMinutes,
          sources: sources(),
        };
      },
    },

    // What comes in: events from Forms, CRM, Messages and your applications, and people with their traits.
    { method: "POST", path: "/api/v1/events", auth: "editor", handle: async ({ req }) => audience.ingest(await readJson(req)) },
    { method: "POST", path: "/api/v1/profiles", auth: "editor", handle: async ({ req }) => audience.upsert(await readJson(req)) },

    // People.
    {
      method: "GET",
      path: "/api/v1/people",
      auth: "viewer",
      handle: ({ url }) => {
        const p = audience.people(
          { q: q(url, "q"), email: q(url, "email"), phone: q(url, "phone"), userId: q(url, "userId"), trait: q(url, "trait"), segment: q(url, "segment") },
          cursor(url),
          limit(url),
        );
        return { ...page("people", p), total: p.total };
      },
    },
    {
      method: "GET",
      path: "/api/v1/people/:id",
      auth: "viewer",
      handle: ({ params }) => {
        const p = audience.person(params[0]!);
        return { ...p, segments: segments.forProfile(p.id) };
      },
    },
    {
      method: "GET",
      path: "/api/v1/people/:id/events",
      auth: "viewer",
      handle: ({ url, params }) => page("events", audience.timeline(person(params[0]!), cursor(url), limit(url))),
    },
    { method: "GET", path: "/api/v1/people/:id/consent", auth: "viewer", handle: ({ params }) => consentOf(params[0]!) },
    { method: "GET", path: "/api/v1/people/:id/export", auth: "admin", handle: ({ params }) => audience.exportPerson(params[0]!) },
    // Deletion on request (KVKK Art. 7 and 11, GDPR Art. 17), here and in every linked product, logged in /api/v1/deletions.
    {
      method: "DELETE",
      path: "/api/v1/people/:id",
      auth: "admin",
      handle: ({ res, url, params, actor }) =>
        status(res, 202, deletions.request({ reference: url.searchParams.get("reference") ?? "", profile: params[0] }, actor)),
    },

    // Segments, and what Messages and Campaigns read of them.
    { method: "GET", path: "/api/v1/segments", auth: "viewer", handle: () => ({ segments: segments.list() }) },
    {
      method: "POST",
      path: "/api/v1/segments",
      auth: "editor",
      handle: async ({ req, res, actor }) => status(res, 201, segments.create(await readJson(req), actor)),
    },
    { method: "POST", path: "/api/v1/segments/preview", auth: "viewer", handle: async ({ req }) => segments.preview(await readJson(req)) },
    { method: "GET", path: "/api/v1/segments/:id", auth: "viewer", handle: ({ params }) => segments.get(params[0]!) },
    { method: "PUT", path: "/api/v1/segments/:id", auth: "editor", handle: async ({ req, params }) => segments.update(params[0]!, await readJson(req)) },
    { method: "DELETE", path: "/api/v1/segments/:id", auth: "editor", handle: ({ res, params }) => (segments.remove(params[0]!), noContent(res)) },
    {
      method: "GET",
      path: "/api/v1/segments/:id/members",
      auth: "viewer",
      handle: ({ url, params, actor }) => {
        const m = segments.members(params[0]!, cursor(url), limit(url, 1000), actor);
        return { segment: m.segment, name: m.name, ...page("members", m) };
      },
    },
    {
      method: "GET",
      path: "/api/v1/segments/:id/export",
      auth: "viewer",
      handle: ({ res, params, actor }) => {
        const s = segments.get(params[0]!);
        const chunks = segments.csv(s.id, actor);
        const file = `${
          s.name
            .replace(/[^\p{L}\p{N}]+/gu, "-")
            .replace(/^-|-$/g, "")
            .toLocaleLowerCase("tr") || "segment"
        }.csv`;
        res.writeHead(200, {
          ...SECURITY_HEADERS,
          "content-type": "text/csv; charset=utf-8",
          "content-disposition": `attachment; filename="segment.csv"; filename*=UTF-8''${encodeURIComponent(file)}`,
        });
        for (const c of chunks) res.write(c);
        res.end();
      },
    },
    {
      method: "GET",
      path: "/api/v1/segments/:id/changes",
      auth: "viewer",
      handle: ({ url, params }) => segments.changes(params[0]!, cursor(url), limit(url, 1000)),
    },
    {
      method: "POST",
      path: "/api/v1/segments/:id/recount",
      auth: "editor",
      handle: ({ params }) => {
        segments.get(params[0]!);
        segments.recount(params[0]!);
        return segments.get(params[0]!);
      },
    },

    // Imports from a CSV.
    { method: "GET", path: "/api/v1/imports", auth: "viewer", handle: () => ({ imports: imports.list() }) },
    {
      method: "POST",
      path: "/api/v1/imports",
      auth: "editor",
      handle: async ({ req, res, url, actor }) => {
        const type = (req.headers["content-type"] ?? "").split(";")[0]!.trim();
        if (type !== "text/csv" && type !== "text/plain") throw bad("Send the file as text/csv.");
        const text = (await readBody(req, MAX_BYTES)).toString("utf8");
        return status(res, 201, imports.upload(text, url.searchParams.get("file"), actor));
      },
    },
    { method: "GET", path: "/api/v1/imports/:id", auth: "viewer", handle: ({ params }) => imports.get(params[0]!) },
    {
      method: "POST",
      path: "/api/v1/imports/:id/preview",
      auth: "editor",
      handle: async ({ req, params }) => imports.preview(params[0]!, await readJson(req)),
    },
    { method: "POST", path: "/api/v1/imports/:id/run", auth: "editor", handle: async ({ req, params }) => imports.run(params[0]!, await readJson(req)) },
    { method: "DELETE", path: "/api/v1/imports/:id", auth: "editor", handle: ({ res, params }) => (imports.discard(params[0]!), noContent(res)) },

    // The deletion log: references, times and how much was deleted where, never who.
    { method: "GET", path: "/api/v1/deletions", auth: "viewer", handle: ({ url }) => page("deletions", deletions.list(cursor(url), limit(url))) },
    {
      method: "POST",
      path: "/api/v1/deletions",
      auth: "admin",
      handle: async ({ req, res, actor }) => status(res, 202, deletions.request(await readJson(req), actor)),
    },
    { method: "GET", path: "/api/v1/deletions/:id", auth: "viewer", handle: ({ params }) => deletions.get(params[0]!) },
    { method: "POST", path: "/api/v1/deletions/:id/retry", auth: "admin", handle: ({ params }) => deletions.retry(params[0]!) },

    // The linked products.
    { method: "GET", path: "/api/v1/sources", auth: "viewer", handle: () => ({ sources: sources() }) },
    {
      method: "POST",
      path: "/api/v1/sources/analytics/pull",
      auth: "admin",
      handle: async () => {
        if (!links.has("analytics")) throw new AudienceError(409, "not-configured", "Analytics is not linked in audience.yaml.");
        const events = await pull.tick({ force: true });
        return { events, sites: pull.status() };
      },
    },
  ];

  const compiled = routes.map((r) => ({ ...r, re: new RegExp(`^${r.path.replace(/:[a-z]+/g, "([^/]+)")}$`) }));

  function authorize(req: IncomingMessage, access: Access): Principal | null {
    if (access === "none") return null;
    if (tokenMatches(req.headers.authorization, adminToken)) return null;
    return auth.authorize(req, access);
  }

  async function route(req: IncomingMessage, res: ServerResponse): Promise<string> {
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname;

    if (path === "/healthz") return (json(res, 200, { status: "ok" }), "/healthz");

    if (path === "/readyz") {
      try {
        db.prepare("SELECT 1").get();
        json(res, 200, { status: "ready" });
      } catch {
        json(res, 503, { status: "database unavailable" });
      }
      return "/readyz";
    }

    if (path === "/metrics") {
      if (serveMetrics) send(res, 200, metricsText({ audience, segments, deletions, pull }, version), "text/plain; version=0.0.4");
      else problem(res, 404, "not-found");
      return "/metrics";
    }

    if (path === "/api/openapi.json" && spec) return (send(res, 200, spec), "/api/openapi.json");

    if (docsDir && (path === "/api/docs" || path.startsWith("/api/docs/"))) {
      if (path === "/api/docs") {
        res.writeHead(301, { ...SECURITY_HEADERS, location: "/api/docs/" }).end();
        return "/api/docs";
      }
      const relative = path.slice("/api/docs/".length) || "index.html";
      if (!(await serveFile(res, docsDir, relative))) problem(res, 404, "not-found");
      return "/api/docs";
    }

    if (await auth.handle(req, res)) return auth.routeName(req) ?? "/api/v1/auth/*";

    for (const r of compiled) {
      const m = path.match(r.re);
      if (!m || r.method !== req.method) continue;
      try {
        const principal = authorize(req, r.auth);
        const params = m.slice(1).map(decodeURIComponent);
        const result = await r.handle({ req, res, url, params, actor: actorOf(principal) });
        if (!res.headersSent && result !== undefined) json(res, 200, result);
      } catch (err) {
        if (err instanceof AuthError) {
          sendProblem(res, err);
          if (!req.complete) req.resume();
          return r.path;
        }
        if (!(err instanceof AudienceError)) throw err;
        problem(res, err.status, err.code, err.message);
        // Unread request bodies would otherwise hold the connection.
        if (!req.complete) req.resume();
      }
      return r.path;
    }

    if (path.startsWith("/api/")) return (problem(res, 404, "not-found"), "/api/*");

    if (webDir && (req.method === "GET" || req.method === "HEAD")) {
      // Unknown paths fall back to the single-page app.
      if (!(await serveFile(res, webDir, path === "/" ? "index.html" : path))) send(res, 200, await readFile(join(webDir, "index.html")), TYPES[".html"]);
      return "/web";
    }

    problem(res, 404, "not-found");
    return "unmatched";
  }

  return async (req: IncomingMessage, res: ServerResponse) => {
    const started = performance.now();
    let routeName = "error";
    try {
      routeName = await route(req, res);
    } catch (err) {
      log("error", "request failed", { error: String(err), stack: (err as Error).stack, path: pathOf(req) });
      if (!res.headersSent) problem(res, 500, "internal-error");
    }
    countRequest(req.method ?? "GET", routeName, res.statusCode);
    if (!["/healthz", "/metrics"].includes(routeName)) {
      log("info", "request", { method: req.method, path: pathOf(req), status: res.statusCode, ms: Math.round(performance.now() - started) });
    }
  };
}

/** The path without the query string, which may name people. */
const pathOf = (req: IncomingMessage) => (req.url ?? "/").split("?")[0];
