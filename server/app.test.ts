import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FILE, startApp } from "./test-app.ts";

let app: Awaited<ReturnType<typeof startApp>>;
beforeAll(async () => {
  app = await startApp({ file: FILE.replace("{sources}", "sources:\n  forms: true\n  crm: true") });
});
afterAll(() => app.close());

const json = async (res: Response) => (await res.json()) as any;
const post = (path: string, body: unknown) => app.admin(path, { method: "POST", body: JSON.stringify(body) });

describe("the event API that Forms, CRM, Messages and your applications post to", () => {
  it("records events, makes and matches people, and sets traits", async () => {
    const res = await post("/api/v1/events", {
      events: [
        {
          source: "forms",
          type: "form_submitted",
          id: "forms:answer:1",
          at: "2026-11-06T16:20:00Z",
          person: { email: "Okan@TekinYapi.example.com", name: "Okan Tekin" },
          traits: { city: "İzmir", sector: "Construction", colour: "red" },
          properties: { form: "contact-sales", seats: 12 },
          text: "Sent Contact sales: 12 people",
        },
        {
          source: "crm",
          type: "deal_opened",
          id: "crm:deal:7",
          person: { email: "okan@tekinyapi.example.com", phone: "0532 000 00 12" },
          properties: { status: "open" },
        },
      ],
    });
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body).toMatchObject({ recorded: 2, duplicates: 0 });
    expect(body.results[0]).toMatchObject({ created: true, duplicate: false, ignoredTraits: [{ trait: "colour", reason: "not in audience.yaml" }] });
    expect(body.results[1]).toMatchObject({ profile: body.results[0].profile, created: false });
    const p = await json(await app.admin(`/api/v1/people/${body.results[0].profile}`));
    expect(p).toMatchObject({
      name: "Okan Tekin",
      email: "okan@tekinyapi.example.com",
      phone: "+905320000012",
      traits: { city: "İzmir", sector: "Construction" },
      sources: ["forms", "crm"],
      eventCount: 2,
      segments: [],
    });
    expect(p.events[1]).toMatchObject({
      source: "forms",
      type: "form_submitted",
      text: "Sent Contact sales: 12 people",
      properties: { form: "contact-sales", seats: 12 },
    });
  });

  it("keeps an event once, however often it is sent", async () => {
    const e = { source: "forms", type: "form_submitted", id: "forms:answer:1", person: { email: "okan@tekinyapi.example.com" } };
    expect(await json(await post("/api/v1/events", { events: [e] }))).toMatchObject({
      recorded: 0,
      duplicates: 1,
      results: [{ duplicate: true, event: null }],
    });
  });

  it("checks the whole batch before recording any of it", async () => {
    const bad = await post("/api/v1/events", {
      events: [
        { type: "ok", person: { email: "first@example.com" } },
        { type: "ok", person: { name: "No identifier" } },
      ],
    });
    expect(bad.status).toBe(422);
    expect((await json(bad)).detail).toMatch(/events\[1\].person needs email, phone, userId/);
    expect((await json(await app.admin("/api/v1/people?email=first@example.com"))).total).toBe(0);
    const cases: Array<[unknown, RegExp]> = [
      [{ events: [] }, /1 to 1000 events/],
      [{ events: [{ source: "messages", type: "message_opened", person: { email: "a@example.com" } }] }, /messages is not linked/],
      [{ events: [{ source: "analytics", type: "x", person: { email: "a@example.com" } }] }, /Analytics and imports are read by Audience itself/],
      [{ events: [{ type: "Page View", person: { email: "a@example.com" } }] }, /type is the kind of event/],
      [{ events: [{ type: "x", at: "2099-01-01T00:00:00Z", person: { email: "a@example.com" } }] }, /more than a day ahead/],
      [{ events: [{ type: "x", person: { email: "a@example.com", fingerprint: "abc" } }] }, /unknown fingerprint/],
      [{ events: [{ type: "x", person: { phone: "0505 *** ** 88" } }] }, /not a phone number/],
      [{ events: [{ type: "x", person: { email: "a@example.com" }, properties: { big: "x".repeat(5000) } }] }, /at most 4096 bytes/],
    ];
    for (const [body, message] of cases) {
      const res = await post("/api/v1/events", body);
      expect(res.status, JSON.stringify(body)).toBe(422);
      expect((await json(res)).detail).toMatch(message);
    }
    expect((await app.admin("/api/v1/events", { method: "POST", body: "{nope" })).status).toBe(400);
  });

  it("adds a person without an event", async () => {
    const res = await post("/api/v1/profiles", {
      person: { email: "seda@polatgida.example.com", userId: "u-1188", name: "Seda Polat" },
      traits: { plan: "pro" },
    });
    expect(await json(res)).toMatchObject({ created: true, person: { userId: "u-1188", traits: { plan: "Pro" } } });
  });

  it("needs a token, and the editor role to write", async () => {
    expect((await fetch(`${app.base}/api/v1/people`)).status).toBe(401);
    expect((await fetch(`${app.base}/api/v1/events`, { method: "POST", body: "{}" })).status).toBe(401);
    expect((await json(await fetch(`${app.base}/api/v1/version`))).product).toBe("audience");
  });
});

describe("people", () => {
  it("are found by part of a name or identifier, exactly by one, or by a trait", async () => {
    const find = async (q: string) => (await json(await app.admin(`/api/v1/people?${q}`))).people.map((p: any) => p.email);
    expect(await find("q=tekin")).toEqual(["okan@tekinyapi.example.com"]);
    expect(await find("q=Seda")).toEqual(["seda@polatgida.example.com"]);
    expect(await find("phone=05320000012")).toEqual(["okan@tekinyapi.example.com"]);
    expect(await find("userId=u-1188")).toEqual(["seda@polatgida.example.com"]);
    expect(await find("trait=plan:pro")).toEqual(["seda@polatgida.example.com"]);
    expect((await app.admin("/api/v1/people?trait=plan")).status).toBe(422);
  });

  it("export everything kept about a person", async () => {
    const id = (await json(await app.admin("/api/v1/people?userId=u-1188"))).people[0].id;
    const e = await json(await app.admin(`/api/v1/people/${id}/export`));
    expect(e).toMatchObject({ person: { id }, events: [], analyticsVisitors: [] });
    expect(await json(await app.admin(`/api/v1/people/${id}/consent`))).toEqual({ linked: false, people: [], error: null });
  });
});

describe("segments over HTTP", () => {
  it("are made, read by products page by page, exported and deleted", async () => {
    const created = await post("/api/v1/segments", {
      name: "Construction in İzmir",
      rules: {
        all: [
          { trait: "sector", op: "is", value: "construction" },
          { trait: "city", op: "is", value: "izmir" },
        ],
      },
    });
    expect(created.status).toBe(201);
    const s = await json(created);
    expect(s).toMatchObject({ size: 1, owner: "admin token", history: expect.any(Array) });
    expect(s.history).toHaveLength(90);
    const members = await json(await app.admin(`/api/v1/segments/${s.id}/members?limit=1`));
    expect(members).toMatchObject({
      segment: s.id,
      name: "Construction in İzmir",
      members: [{ email: "okan@tekinyapi.example.com", traits: { city: "İzmir" } }],
    });
    const csv = await app.admin(`/api/v1/segments/${s.id}/export`);
    expect(csv.headers.get("content-type")).toBe("text/csv; charset=utf-8");
    expect(csv.headers.get("content-disposition")).toBe(`attachment; filename="segment.csv"; filename*=UTF-8''construction-in-izmir.csv`);
    expect((await csv.text()).split("\r\n")[1]).toContain("okan@tekinyapi.example.com");
    const changes = await json(await app.admin(`/api/v1/segments/${s.id}/changes`));
    expect(changes.changes).toEqual([{ profile: expect.any(String), change: "joined", at: expect.any(String) }]);
    expect((await json(await app.admin(`/api/v1/segments/${s.id}/changes?cursor=${changes.cursor}`))).changes).toEqual([]);
    expect((await post("/api/v1/segments/preview", { rules: { trait: "plan", op: "exists" } })).status).toBe(200);
    expect((await app.admin(`/api/v1/segments/${s.id}`, { method: "PUT", body: JSON.stringify({ name: "Renamed" }) })).status).toBe(200);
    expect((await app.admin(`/api/v1/segments/${s.id}`, { method: "DELETE" })).status).toBe(204);
    expect((await app.admin(`/api/v1/segments/${s.id}`)).status).toBe(404);
  });
});

describe("imports over HTTP", () => {
  it("take a CSV as text/csv", async () => {
    const up = await app.admin("/api/v1/imports?file=fair.csv", {
      method: "POST",
      body: "email;Şehir\nnew@example.com;Bursa\n",
      headers: { "content-type": "text/csv" },
    });
    expect(up.status).toBe(201);
    const { id } = await json(up);
    const done = await json(await post(`/api/v1/imports/${id}/run`, { mapping: { email: "email", Şehir: "trait:city" } }));
    expect(done).toMatchObject({ created: 1, matched: 0, skipped: 0 });
    expect((await app.admin("/api/v1/imports", { method: "POST", body: "{}", headers: { "content-type": "application/json" } })).status).toBe(422);
  });
});

describe("the overview", () => {
  it("counts profiles, events by source and where people came from", async () => {
    const s = await json(await app.admin("/api/v1/summary"));
    expect(s.profiles).toBe(3);
    expect(s.trend).toHaveLength(14);
    expect(s.trend.at(-1)).toBe(3);
    expect(s.firstSources).toEqual([
      { source: "api", profiles: 1 },
      { source: "forms", profiles: 1 },
      { source: "import", profiles: 1 },
    ]);
    expect(s.events.at(-1).sources).toMatchObject({ crm: 1, import: 1 });
    expect(s.knownBy).toEqual({ email: 3, phone: 1, userId: 1 });
  });

  it("serves health, readiness and metrics", async () => {
    expect((await fetch(`${app.base}/healthz`)).status).toBe(200);
    expect((await fetch(`${app.base}/readyz`)).status).toBe(200);
    const m = await (await fetch(`${app.base}/metrics`)).text();
    expect(m).toContain('openasy_build_info{product="audience",version="0.1.0"} 1');
    expect(m).toContain("openasy_audience_profiles 3");
  });
});
