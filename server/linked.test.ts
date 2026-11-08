import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startApp } from "./test-app.ts";

let app: Awaited<ReturnType<typeof startApp>>;
beforeAll(async () => {
  app = await startApp({ linked: true });
});
afterAll(() => app.close());

const json = async (res: Response) => (await res.json()) as any;

describe("Analytics", () => {
  it("brings identified visitors in as profiles, with their visits before and after they signed in", async () => {
    const a = app.fakes.analytics!;
    a.visit({ visitor: "v-okan", at: "2026-11-01T09:00:00.000Z", pages: ["/", "/blog"], source: "google.com" });
    a.visit({ visitor: "v-okan", user: "u-1042", at: "2026-11-07T10:00:00.000Z", pages: ["/pricing", "/signup"] });
    a.visit({ visitor: "v-anon", at: "2026-11-07T11:00:00.000Z", pages: ["/"] });
    a.visit({
      visitor: "v-kerem",
      user: "u-1201",
      at: "2026-11-07T12:00:00.000Z",
      pages: ["/pricing"],
      events: [
        { type: "event", at: "2026-11-07T12:00:30.000Z", path: "/pricing", title: null, name: "Plan Chosen", props: { plan: "pro" }, form: null, action: null },
      ],
    });
    const res = await json(await app.admin("/api/v1/sources/analytics/pull", { method: "POST" }));
    expect(res.sites).toEqual([expect.objectContaining({ site: "shop", error: null })]);
    const okan = (await json(await app.admin("/api/v1/people?userId=u-1042"))).people[0];
    expect(okan).toMatchObject({ userId: "u-1042", sources: ["analytics"], firstSource: "analytics" });
    const timeline = (await json(await app.admin(`/api/v1/people/${okan.id}/events?limit=50`))).events;
    expect(timeline.map((e: any) => [e.type, e.properties.path ?? e.properties.entry])).toEqual([
      ["page_viewed", "/signup"],
      ["page_viewed", "/pricing"],
      ["visit_started", "/pricing"],
      ["page_viewed", "/blog"],
      ["page_viewed", "/"],
      ["visit_started", "/"],
    ]);
    expect(timeline.at(-1).text).toBe("Visited shop from google.com");
    const kerem = (await json(await app.admin("/api/v1/people?userId=u-1201"))).people[0];
    const kt = (await json(await app.admin(`/api/v1/people/${kerem.id}/events`))).events;
    expect(kt[0]).toMatchObject({ type: "plan_chosen", text: "Plan Chosen on /pricing", properties: { plan: "pro", path: "/pricing" } });
    // Nobody is made from a visitor who never signed in.
    expect((await json(await app.admin("/api/v1/people"))).total).toBe(2);
  });

  it("reads only what is new, and each event once", async () => {
    const before = (await json(await app.admin("/api/v1/people?userId=u-1042"))).people[0];
    const count = async () => (await json(await app.admin(`/api/v1/people/${before.id}`))).eventCount;
    const n = await count();
    await app.admin("/api/v1/sources/analytics/pull", { method: "POST" });
    expect(await count()).toBe(n);
    // A later visit of the same visitor, not signed in this time, is still theirs.
    app.fakes.analytics!.visit({ visitor: "v-okan", at: "2026-11-08T08:00:00.000Z", pages: ["/pricing"] });
    const calls = app.fakes.analytics!.calls.length;
    await app.admin("/api/v1/sources/analytics/pull", { method: "POST" });
    expect(await count()).toBe(n + 2);
    // One page of visits up to the last one read, and the new visit's details.
    expect(app.fakes.analytics!.calls.slice(calls).map((c) => c.path)).toEqual(["/api/v1/visits", "/api/v1/visits/visit-5"]);
  });

  it("says when it cannot read", async () => {
    app.fakes.analytics!.fail(1);
    const res = await json(await app.admin("/api/v1/sources/analytics/pull", { method: "POST" }));
    expect(res.sites[0].error).toBe("Analytics answered 503: down for a moment");
    const sources = (await json(await app.admin("/api/v1/sources"))).sources;
    expect(sources.map((s: any) => [s.id, s.token?.set ?? null, s.delete])).toEqual([
      ["analytics", true, true],
      ["consent", true, true],
      ["crm", true, true],
      ["forms", null, false],
    ]);
  });
});

describe("Consent", () => {
  it("shows on a profile what the person agreed to there", async () => {
    app.fakes.consent!.person({ emails: ["ayse@example.com"] });
    const r = await json(
      await app.admin("/api/v1/events", { method: "POST", body: JSON.stringify({ events: [{ type: "signed_up", person: { email: "ayse@example.com" } }] }) }),
    );
    const consent = await json(await app.admin(`/api/v1/people/${r.results[0].profile}/consent`));
    expect(consent).toMatchObject({
      linked: true,
      error: null,
      people: [{ standing: [{ purpose: "marketing", channel: "email", status: "granted", version: 3 }] }],
    });
  });
});

describe("deletion on request", () => {
  it("deletes here at once and in every linked product, and the log keeps no one's data", async () => {
    const { consent, crm, analytics } = app.fakes;
    const okan = (await json(await app.admin("/api/v1/people?userId=u-1042"))).people[0];
    await app.admin("/api/v1/events", {
      method: "POST",
      body: JSON.stringify({
        events: [{ source: "forms", type: "form_submitted", person: { userId: "u-1042", email: "okan@tekinyapi.example.com", phone: "0532 000 00 12" } }],
      }),
    });
    consent!.person({ emails: ["okan@tekinyapi.example.com"], phones: ["+905320000012"] });
    consent!.person({ emails: ["someone.else@example.com"] });
    const res = await app.admin(`/api/v1/people/${okan.id}?reference=KVKK-2026-032`, { method: "DELETE" });
    expect(res.status).toBe(202);
    const d = await json(res);
    expect(d).toMatchObject({ reference: "KVKK-2026-032", actor: "admin token", profiles: 1 });
    expect(d.events).toBeGreaterThan(5);
    // Here: gone at once.
    expect((await app.admin(`/api/v1/people/${okan.id}`)).status).toBe(404);
    expect((await json(await app.admin("/api/v1/people?email=okan@tekinyapi.example.com"))).total).toBe(0);
    await app.deletions.tick();
    const log = await json(await app.admin(`/api/v1/deletions/${d.id}`));
    expect(log.state).toBe("done");
    expect(log.products.map((p: any) => [p.product, p.state, p.deleted])).toEqual([
      ["analytics", "done", 1],
      ["consent", "done", 1],
      ["crm", "done", 1],
    ]);
    expect(analytics!.deleted).toEqual(["shop:v-okan"]);
    expect(consent!.erased).toEqual([{ id: expect.any(String), reason: "KVKK-2026-032" }]);
    expect(consent!.people.map((p) => p.emails[0])).toEqual(["ayse@example.com", "someone.else@example.com"]);
    expect(crm!.received).toEqual([
      { reference: "KVKK-2026-032", product: "audience", people: { emails: ["okan@tekinyapi.example.com"], phones: ["+905320000012"], userIds: ["u-1042"] } },
    ]);
    // Nothing in the database names the person any more.
    const everything = JSON.stringify(
      ["deletions", "deletion_tasks", "identifiers", "events", "analytics_visitors", "merges", "segment_changes"].map((t) =>
        app.audience.all(`SELECT * FROM ${t}`),
      ),
    );
    expect(everything).not.toContain("okan@tekinyapi");
    expect(everything).not.toContain("u-1042");
    expect(everything).not.toContain("v-okan");
    expect(everything).not.toContain(okan.id);
  });

  it("waits while a product must keep the person, and fails with the product's message", async () => {
    const { crm } = app.fakes;
    crm!.answer(202, { status: "waiting", detail: "An open deal has an invoice not yet paid." });
    const d = await json(
      await app.admin("/api/v1/deletions", { method: "POST", body: JSON.stringify({ reference: "KVKK-2026-033", person: { email: "gizem@example.com" } }) }),
    );
    await app.deletions.tick();
    let log = await json(await app.admin(`/api/v1/deletions/${d.id}`));
    expect(log.state).toBe("waiting");
    expect(log.products.find((p: any) => p.product === "crm")).toMatchObject({ state: "waiting", detail: "An open deal has an invoice not yet paid." });
    // The invoice is paid; asked again an hour later, CRM is done.
    crm!.answer(200, { status: "done", deleted: 1 });
    app.clock.advance(61 * 60_000);
    await app.deletions.tick();
    log = await json(await app.admin(`/api/v1/deletions/${d.id}`));
    expect(log.state).toBe("done");
    expect(crm!.received.filter((r) => r.reference === "KVKK-2026-033")).toHaveLength(2);

    crm!.answer(404, { code: "not-found" });
    const f = await json(
      await app.admin("/api/v1/deletions", { method: "POST", body: JSON.stringify({ reference: "KVKK-2026-034", person: { phone: "05550000000" } }) }),
    );
    await app.deletions.tick();
    log = await json(await app.admin(`/api/v1/deletions/${f.id}`));
    expect(log.products.find((p: any) => p.product === "crm")).toMatchObject({
      state: "failed",
      detail: expect.stringMatching(/does not take POST \/api\/v1\/erasures/),
    });
    crm!.answer(200, { status: "done", deleted: 0 });
    const retried = await json(await app.admin(`/api/v1/deletions/${f.id}/retry`, { method: "POST" }));
    expect(retried.state).toBe("done");
    expect((await app.admin(`/api/v1/deletions/${f.id}/retry`, { method: "POST" })).status).toBe(409);
  });

  it("tries again later when a product is away", async () => {
    app.fakes.consent!.fail(1);
    const d = await json(
      await app.admin("/api/v1/deletions", { method: "POST", body: JSON.stringify({ reference: "KVKK-2026-035", person: { userId: "u-9" } }) }),
    );
    await app.deletions.tick();
    let log = await json(await app.admin(`/api/v1/deletions/${d.id}`));
    expect(log.products.find((p: any) => p.product === "consent")).toMatchObject({
      state: "pending",
      attempts: 1,
      detail: "Consent answered 503: down for a moment",
    });
    app.clock.advance(2 * 60_000);
    await app.deletions.tick();
    log = await json(await app.admin(`/api/v1/deletions/${d.id}`));
    expect(log.state).toBe("done");
  });

  it("needs a reference, and someone to delete", async () => {
    expect((await app.admin("/api/v1/people/nobodyhere00?reference=KVKK-1", { method: "DELETE" })).status).toBe(404);
    expect(
      (await app.admin("/api/v1/deletions", { method: "POST", body: JSON.stringify({ reference: "x", person: { email: "a@example.com" } }) })).status,
    ).toBe(422);
    expect((await app.admin("/api/v1/deletions", { method: "POST", body: JSON.stringify({ reference: "KVKK-1" }) })).status).toBe(422);
  });
});
