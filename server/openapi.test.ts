import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Ajv2020 } from "ajv/dist/2020.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ADMIN_TOKEN, startApp } from "./test-app.ts";

// Contract tests (ADR 0024): every response the API sends must match openapi.json.

type Spec = {
  info: { version: string };
  paths: Record<string, Record<string, { responses: Record<string, { $ref?: string; content?: Record<string, { schema: object }> }> }>>;
  components: { responses: Record<string, { content: Record<string, { schema: object }> }>; schemas: Record<string, object> };
  webhooks: Record<string, Record<string, { requestBody: { content: Record<string, { schema: object }> } }>>;
};

const spec = JSON.parse(readFileSync(new URL("../openapi.json", import.meta.url), "utf8")) as Spec;
const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };

const ajv = new Ajv2020({ strict: false, validateFormats: false });
ajv.addSchema(spec, "openapi");

const docsDir = mkdtempSync(join(tmpdir(), "audience-docs-"));
writeFileSync(join(docsDir, "index.html"), "<!doctype html><title>API</title>");

let app: Awaited<ReturnType<typeof startApp>>;
let base: string;
const covered = new Set<string>();

beforeAll(async () => {
  app = await startApp({ version, openapi: spec, docsDir, linked: true });
  base = app.base;
});

afterAll(() => app.close());

/** Calls the API and checks status, content type and body against the description. */
async function call(method: string, path: string, init: RequestInit = {}, concrete = path) {
  const res = await fetch(base + concrete, { ...init, method });
  const operation = spec.paths[path]?.[method.toLowerCase()];
  expect(operation, `${method} ${path} is not in openapi.json`).toBeDefined();
  covered.add(`${method} ${path}`);

  const declared = operation!.responses[String(res.status)];
  expect(declared, `${method} ${concrete} answered ${res.status}, which openapi.json does not list`).toBeDefined();
  const shared = declared!.$ref?.split("/").pop();
  const response = shared ? spec.components.responses[shared]! : declared!;
  const at = shared
    ? `openapi#/components/responses/${shared}`
    : `openapi#/paths/${path.replaceAll("/", "~1").replaceAll("{", "%7B").replaceAll("}", "%7D")}/${method.toLowerCase()}/responses/${res.status}`;

  if (!response.content) {
    expect(res.headers.get("content-length") ?? "0", `${method} ${path} ${res.status} should have no body`).toBe("0");
    return { res, body: undefined };
  }
  const type = res.headers.get("content-type")!.split(";")[0]!;
  expect(response.content?.[type], `${method} ${path} ${res.status} sent ${type}, which openapi.json does not list`).toBeDefined();

  const body = type.endsWith("json") ? await res.json() : await res.text();
  const schema = `${at}/content/${type.replace("/", "~1")}/schema`;
  const validate = ajv.getSchema(schema)!;
  expect(validate(body), JSON.stringify(validate.errors)).toBe(true);
  return { res, body: body as any };
}

const admin = (body?: unknown, type = "application/json") => ({
  headers: { authorization: `Bearer ${ADMIN_TOKEN}`, ...(body !== undefined && { "content-type": type }) },
  ...(body !== undefined && { body: typeof body === "string" ? body : JSON.stringify(body) }),
});

describe("openapi.json", () => {
  it("has the version of this release", () => {
    expect(spec.info.version).toBe(version);
  });

  it("is served with the running version", async () => {
    const served = (await (await fetch(`${base}/api/openapi.json`)).json()) as Spec;
    expect(served.info.version).toBe(version);
    expect(Object.keys(served.paths).filter((p) => !p.startsWith("/api/v1/auth/"))).toEqual(Object.keys(spec.paths));
    expect(served.paths["/api/v1/auth/login"]).toBeDefined();
  });

  it("serves the API reference at /api/docs/", async () => {
    expect((await fetch(`${base}/api/docs`, { redirect: "manual" })).headers.get("location")).toBe("/api/docs/");
    const res = await fetch(`${base}/api/docs/`);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect((await fetch(`${base}/api/docs/../../package.json`)).status).not.toBe(200);
  });

  it("documents the erasure call Audience makes, as the fake CRM takes it", async () => {
    const validate = ajv.getSchema("openapi#/components/schemas/ErasureRequest")!;
    await fetch(`${base}/api/v1/deletions`, { method: "POST", ...admin({ reference: "REF-1", person: { email: "e@example.com" } }) });
    await app.deletions.tick();
    expect(app.fakes.crm!.received.length).toBeGreaterThan(0);
    for (const r of app.fakes.crm!.received) expect(validate(r), JSON.stringify(validate.errors)).toBe(true);
  });
});

describe("responses match openapi.json", () => {
  let person = "";
  let segment = "";
  let upload = "";

  it("product and health", async () => {
    await call("GET", "/api/v1/version");
    await call("GET", "/api/v1/products", admin());
    await call("GET", "/api/v1/products", {});
    await call("GET", "/healthz");
    await call("GET", "/readyz");
    await call("GET", "/metrics");
  });

  it("events and profiles", async () => {
    const events = [
      {
        source: "forms",
        type: "form_submitted",
        id: "f-1",
        person: { email: "contract@example.com", phone: "05551112233", name: "Ayşe" },
        traits: { plan: "Free", nope: 1 },
        properties: { form: "contact" },
      },
      { type: "page_viewed", person: { userId: "u-contract" }, properties: { path: "/pricing" } },
    ];
    const { body } = await call("POST", "/api/v1/events", admin({ events }));
    person = body.results[0].profile;
    await call("POST", "/api/v1/events", admin({ events: [{ type: "x", person: {} }] }));
    await call("POST", "/api/v1/events", admin("{nope"));
    await call("POST", "/api/v1/events", admin({ events: [{ type: "x", person: { email: "a@example.com" }, text: "x".repeat(6 * 1024 * 1024) }] }));
    await call("POST", "/api/v1/events", {});
    await call("POST", "/api/v1/profiles", admin({ person: { email: "contract@example.com", userId: "u-contract" }, traits: { city: "İzmir" } }));
    await call("POST", "/api/v1/profiles", admin({ person: {} }));
    await call("POST", "/api/v1/profiles", admin("{nope"));
    await call("POST", "/api/v1/profiles", admin({ pad: "x".repeat(6 * 1024 * 1024) }));
    await call("POST", "/api/v1/profiles", {});
  });

  it("people", async () => {
    await call("GET", "/api/v1/people", admin(), "/api/v1/people?q=contract&limit=1");
    await call("GET", "/api/v1/people", admin(), "/api/v1/people?limit=0");
    await call("GET", "/api/v1/people", {});
    await call("GET", "/api/v1/people/{id}", admin(), `/api/v1/people/${person}`);
    await call("GET", "/api/v1/people/{id}", admin(), "/api/v1/people/missing00000");
    await call("GET", "/api/v1/people/{id}", {}, `/api/v1/people/${person}`);
    await call("GET", "/api/v1/people/{id}/events", admin(), `/api/v1/people/${person}/events?limit=1`);
    await call("GET", "/api/v1/people/{id}/events", admin(), `/api/v1/people/${person}/events?limit=0`);
    await call("GET", "/api/v1/people/{id}/events", admin(), "/api/v1/people/missing00000/events");
    await call("GET", "/api/v1/people/{id}/events", {}, `/api/v1/people/${person}/events`);
    app.fakes.consent!.person({ emails: ["contract@example.com"] });
    await call("GET", "/api/v1/people/{id}/consent", admin(), `/api/v1/people/${person}/consent`);
    await call("GET", "/api/v1/people/{id}/consent", admin(), "/api/v1/people/missing00000/consent");
    await call("GET", "/api/v1/people/{id}/consent", {}, `/api/v1/people/${person}/consent`);
    await call("GET", "/api/v1/people/{id}/export", admin(), `/api/v1/people/${person}/export`);
    await call("GET", "/api/v1/people/{id}/export", admin(), "/api/v1/people/missing00000/export");
    await call("GET", "/api/v1/people/{id}/export", {}, `/api/v1/people/${person}/export`);
  });

  it("segments", async () => {
    const rules = {
      all: [
        { trait: "plan", op: "is", value: "Free" },
        { event: "form_submitted", op: "at_least", days: 30, where: { form: "contact" } },
      ],
    };
    const { body } = await call("POST", "/api/v1/segments", admin({ name: "Contract", rules }));
    segment = body.id;
    await call("POST", "/api/v1/segments", admin({ name: "Contract", rules }));
    await call("POST", "/api/v1/segments", admin({ name: "Bad", rules: { trait: "nope", op: "exists" } }));
    await call("POST", "/api/v1/segments", admin("{nope"));
    await call("POST", "/api/v1/segments", {});
    await call("GET", "/api/v1/segments", admin());
    await call("GET", "/api/v1/segments", {});
    await call("POST", "/api/v1/segments/preview", admin({ rules }));
    await call("POST", "/api/v1/segments/preview", admin({ rules: {} }));
    await call("POST", "/api/v1/segments/preview", admin("{nope"));
    await call("POST", "/api/v1/segments/preview", {});
    await call("GET", "/api/v1/segments/{id}", admin(), `/api/v1/segments/${segment}`);
    await call("GET", "/api/v1/segments/{id}", admin(), "/api/v1/segments/nope");
    await call("GET", "/api/v1/segments/{id}", {}, `/api/v1/segments/${segment}`);
    await call("PUT", "/api/v1/segments/{id}", admin({ description: "Free and wrote to us" }), `/api/v1/segments/${segment}`);
    await call("PUT", "/api/v1/segments/{id}", admin({ name: "" }), `/api/v1/segments/${segment}`);
    await call("PUT", "/api/v1/segments/{id}", admin("{nope"), `/api/v1/segments/${segment}`);
    await call("PUT", "/api/v1/segments/{id}", admin({ name: "x" }), "/api/v1/segments/nope");
    const other = (await fetch(`${base}/api/v1/segments`, { method: "POST", ...admin({ name: "Other", rules: { trait: "plan", op: "exists" } }) }).then((r) =>
      r.json(),
    )) as { id: string };
    await call("PUT", "/api/v1/segments/{id}", admin({ name: "Contract" }), `/api/v1/segments/${other.id}`);
    await call("PUT", "/api/v1/segments/{id}", {}, `/api/v1/segments/${segment}`);
    await call("GET", "/api/v1/segments/{id}/members", admin(), `/api/v1/segments/${segment}/members?limit=1`);
    await call("GET", "/api/v1/segments/{id}/members", admin(), `/api/v1/segments/${segment}/members?cursor=nope`);
    await call("GET", "/api/v1/segments/{id}/members", admin(), "/api/v1/segments/nope/members");
    await call("GET", "/api/v1/segments/{id}/members", {}, `/api/v1/segments/${segment}/members`);
    await call("GET", "/api/v1/segments/{id}/export", admin(), `/api/v1/segments/${segment}/export`);
    await call("GET", "/api/v1/segments/{id}/export", admin(), "/api/v1/segments/nope/export");
    await call("GET", "/api/v1/segments/{id}/export", {}, `/api/v1/segments/${segment}/export`);
    await call("GET", "/api/v1/segments/{id}/changes", admin(), `/api/v1/segments/${segment}/changes`);
    await call("GET", "/api/v1/segments/{id}/changes", admin(), `/api/v1/segments/${segment}/changes?limit=0`);
    await call("GET", "/api/v1/segments/{id}/changes", admin(), "/api/v1/segments/nope/changes");
    await call("GET", "/api/v1/segments/{id}/changes", {}, `/api/v1/segments/${segment}/changes`);
    await call("POST", "/api/v1/segments/{id}/recount", admin(), `/api/v1/segments/${segment}/recount`);
    await call("POST", "/api/v1/segments/{id}/recount", admin(), "/api/v1/segments/nope/recount");
    await call("POST", "/api/v1/segments/{id}/recount", {}, `/api/v1/segments/${segment}/recount`);
    await call("DELETE", "/api/v1/segments/{id}", admin(), `/api/v1/segments/${other.id}`);
    await call("DELETE", "/api/v1/segments/{id}", admin(), "/api/v1/segments/nope");
    await call("DELETE", "/api/v1/segments/{id}", {}, `/api/v1/segments/${segment}`);
  });

  it("imports", async () => {
    const { body } = await call(
      "POST",
      "/api/v1/imports",
      admin("E-posta;Şehir\nimport@example.com;Bursa\n;Bursa\n", "text/csv"),
      "/api/v1/imports?file=fair.csv",
    );
    upload = body.id;
    await call("POST", "/api/v1/imports", admin("only a header\n", "text/csv"));
    await call("POST", "/api/v1/imports", admin("x".repeat(21 * 1024 * 1024), "text/csv"));
    await call("POST", "/api/v1/imports", {});
    await call("GET", "/api/v1/imports", admin());
    await call("GET", "/api/v1/imports", {});
    await call("GET", "/api/v1/imports/{id}", admin(), `/api/v1/imports/${upload}`);
    await call("GET", "/api/v1/imports/{id}", admin(), "/api/v1/imports/nope");
    await call("GET", "/api/v1/imports/{id}", {}, `/api/v1/imports/${upload}`);
    const mapping = { "E-posta": "email", Şehir: "trait:city" };
    await call("POST", "/api/v1/imports/{id}/preview", admin({ mapping }), `/api/v1/imports/${upload}/preview`);
    await call("POST", "/api/v1/imports/{id}/preview", admin({ mapping: { Şehir: "trait:city" } }), `/api/v1/imports/${upload}/preview`);
    await call("POST", "/api/v1/imports/{id}/preview", admin("{nope"), `/api/v1/imports/${upload}/preview`);
    await call("POST", "/api/v1/imports/{id}/preview", admin({ mapping }), "/api/v1/imports/nope/preview");
    await call("POST", "/api/v1/imports/{id}/preview", {}, `/api/v1/imports/${upload}/preview`);
    await call("POST", "/api/v1/imports/{id}/run", admin({ mapping: {} }), `/api/v1/imports/${upload}/run`);
    await call("POST", "/api/v1/imports/{id}/run", admin("{nope"), `/api/v1/imports/${upload}/run`);
    await call("POST", "/api/v1/imports/{id}/run", admin({ mapping }), "/api/v1/imports/nope/run");
    await call("POST", "/api/v1/imports/{id}/run", {}, `/api/v1/imports/${upload}/run`);
    await call("POST", "/api/v1/imports/{id}/run", admin({ mapping }), `/api/v1/imports/${upload}/run`);
    await call("POST", "/api/v1/imports/{id}/run", admin({ mapping }), `/api/v1/imports/${upload}/run`);
    await call("POST", "/api/v1/imports/{id}/preview", admin({ mapping }), `/api/v1/imports/${upload}/preview`);
    await call("DELETE", "/api/v1/imports/{id}", admin(), `/api/v1/imports/${upload}`);
    const other = (await fetch(`${base}/api/v1/imports`, { method: "POST", ...admin("email\na@example.com\n", "text/csv") }).then((r) => r.json())) as {
      id: string;
    };
    await call("DELETE", "/api/v1/imports/{id}", {}, `/api/v1/imports/${other.id}`);
    await call("DELETE", "/api/v1/imports/{id}", admin(), `/api/v1/imports/${other.id}`);
    await call("DELETE", "/api/v1/imports/{id}", admin(), "/api/v1/imports/nope");
  });

  it("sources", async () => {
    await call("GET", "/api/v1/sources", admin());
    await call("GET", "/api/v1/sources", {});
    await call("POST", "/api/v1/sources/analytics/pull", admin());
    await call("POST", "/api/v1/sources/analytics/pull", {});
    const off = await startApp({ version, openapi: spec });
    const res = await fetch(`${off.base}/api/v1/sources/analytics/pull`, { method: "POST", ...admin() });
    expect(res.status).toBe(409);
    await off.close();
    await call("GET", "/api/v1/config", admin());
    await call("GET", "/api/v1/config", {});
    await call("GET", "/api/v1/summary", admin());
    await call("GET", "/api/v1/summary", {});
  });

  it("deletions", async () => {
    await call("DELETE", "/api/v1/people/{id}", admin(), `/api/v1/people/${person}`);
    await call("DELETE", "/api/v1/people/{id}", admin(), `/api/v1/people/${person}?reference=KVKK-2026-040`);
    await call("DELETE", "/api/v1/people/{id}", admin(), `/api/v1/people/${person}?reference=KVKK-2026-040`);
    await call("DELETE", "/api/v1/people/{id}", {}, `/api/v1/people/${person}?reference=KVKK-2026-040`);
    const { body } = await call("POST", "/api/v1/deletions", admin({ reference: "KVKK-2026-041", person: { phone: "05550001122" } }));
    await call("POST", "/api/v1/deletions", admin({ reference: "KVKK-2026-042", profile: "missing00000" }));
    await call("POST", "/api/v1/deletions", admin({ reference: "x", person: { email: "a@example.com" } }));
    await call("POST", "/api/v1/deletions", admin("{nope"));
    await call("POST", "/api/v1/deletions", {});
    await app.deletions.tick();
    await call("GET", "/api/v1/deletions", admin(), "/api/v1/deletions?limit=1");
    await call("GET", "/api/v1/deletions", admin(), "/api/v1/deletions?cursor=nope");
    await call("GET", "/api/v1/deletions", {});
    await call("GET", "/api/v1/deletions/{id}", admin(), `/api/v1/deletions/${body.id}`);
    await call("GET", "/api/v1/deletions/{id}", admin(), "/api/v1/deletions/nope");
    await call("GET", "/api/v1/deletions/{id}", {}, `/api/v1/deletions/${body.id}`);
    await call("POST", "/api/v1/deletions/{id}/retry", admin(), `/api/v1/deletions/${body.id}/retry`);
    app.fakes.crm!.answer(202, { status: "waiting", detail: "An invoice is open." });
    const waiting = (await fetch(`${base}/api/v1/deletions`, {
      method: "POST",
      ...admin({ reference: "KVKK-2026-043", person: { email: "w@example.com" } }),
    }).then((r) => r.json())) as { id: string };
    await app.deletions.tick();
    await call("POST", "/api/v1/deletions/{id}/retry", admin(), `/api/v1/deletions/${waiting.id}/retry`);
    await call("POST", "/api/v1/deletions/{id}/retry", admin(), "/api/v1/deletions/nope/retry");
    await call("POST", "/api/v1/deletions/{id}/retry", {}, `/api/v1/deletions/${body.id}/retry`);
  });

  it("covers every operation in openapi.json", () => {
    const all = Object.entries(spec.paths).flatMap(([path, ops]) => Object.keys(ops).map((m) => `${m.toUpperCase()} ${path}`));
    expect([...covered].sort()).toEqual(all.sort());
  });
});
