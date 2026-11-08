import { describe, expect, it } from "vitest";
import type { Ids } from "./audience.ts";
import { FILE, startCore } from "./test-app.ts";

const who = (x: Partial<Ids>): Ids => ({ email: null, phone: null, userId: null, name: null, ...x });

describe("one profile per person", () => {
  it("matches by email, phone or user id, and nothing else", () => {
    const { audience } = startCore();
    const a = audience.resolve(who({ email: "ayse@example.com" }), "forms", "2026-11-01T10:00:00Z");
    expect(a.created).toBe(true);
    expect(audience.resolve(who({ email: "AYSE@example.com " }), "crm", "2026-11-01T11:00:00Z")).toMatchObject({ profile: a.profile, created: false });
    // Same name, different email: a different person.
    const b = audience.resolve(who({ email: "ayse.k@example.com", name: "Ayşe Kaya" }), "api", "2026-11-01T12:00:00Z");
    expect(b.profile).not.toBe(a.profile);
    expect(audience.personOf(a.profile)!.sources).toEqual(["forms", "crm"]);
  });

  it("adds what a record brings to the person it matched", () => {
    const { audience } = startCore();
    const a = audience.resolve(who({ email: "ayse@example.com" }), "forms", "2026-11-01T10:00:00Z");
    audience.resolve(who({ email: "ayse@example.com", phone: "0555 111 22 33", userId: "u-1" }), "api", "2026-11-02T10:00:00Z");
    expect(audience.resolve(who({ phone: "+905551112233" }), "messages", "2026-11-03T10:00:00Z").profile).toBe(a.profile);
    expect(audience.resolve(who({ userId: "u-1" }), "analytics", "2026-11-03T10:00:00Z").profile).toBe(a.profile);
    expect(audience.personOf(a.profile)).toMatchObject({ email: "ayse@example.com", phone: "+905551112233", userId: "u-1" });
  });

  it("joins two profiles that turn out to be one person, with their events and the newer traits", () => {
    const { audience } = startCore();
    const byEmail = audience.resolve(who({ email: "okan@example.com" }), "forms", "2026-10-01T10:00:00Z").profile;
    const byPhone = audience.resolve(who({ phone: "05321234512" }), "import", "2026-09-01T10:00:00Z").profile;
    audience.setTraits(byEmail, { city: "İzmir", plan: "Free" }, "forms", "2026-10-01T10:00:00Z");
    audience.setTraits(byPhone, { city: "Ankara", sector: "Construction" }, "import", "2026-11-01T10:00:00Z");
    audience.addEvent(byEmail, { source: "forms", type: "form_submitted", at: "2026-10-01T10:00:00Z", text: null, props: null, external: null });
    audience.addEvent(byPhone, { source: "import", type: "imported", at: "2026-09-01T10:00:00Z", text: null, props: null, external: null });
    const r = audience.resolve(who({ email: "okan@example.com", phone: "+90 532 123 45 12" }), "api", "2026-11-05T10:00:00Z");
    expect(r).toMatchObject({ profile: byEmail, merged: [byPhone], conflicts: 0 });
    const p = audience.person(byEmail);
    expect(p.traits).toEqual({ city: "Ankara", plan: "Free", sector: "Construction" });
    expect(p.events.map((e) => e.type)).toEqual(["form_submitted", "imported"]);
    expect(p).toMatchObject({ firstSource: "import", createdAt: "2026-09-01T10:00:00Z", mergedFrom: [byPhone] });
    // The old id still finds the person.
    expect(audience.current(byPhone)).toBe(byEmail);
    expect(audience.person(byPhone).id).toBe(byEmail);
  });

  it("never joins two people with different user ids, whatever else they share", () => {
    const { audience } = startCore();
    const one = audience.resolve(who({ userId: "u-1", email: "shared@example.com" }), "api", "2026-11-01T10:00:00Z").profile;
    // The shared family address arrives with another user id: a second person, and the email stays with the first.
    const two = audience.resolve(who({ userId: "u-2", email: "shared@example.com" }), "api", "2026-11-02T10:00:00Z");
    expect(two.profile).not.toBe(one);
    expect(two).toMatchObject({ created: true, conflicts: 1, merged: [] });
    expect(audience.personOf(two.profile)).toMatchObject({ userId: "u-2", email: null });
    // Without a user id, the email decides.
    expect(audience.resolve(who({ email: "shared@example.com" }), "forms", "2026-11-03T10:00:00Z").profile).toBe(one);
    // A record naming both people's ids does not join them.
    const both = audience.resolve(who({ userId: "u-2", email: "shared@example.com" }), "api", "2026-11-04T10:00:00Z");
    expect(both).toMatchObject({ profile: two.profile, conflicts: 1, merged: [] });
    expect(audience.people({}, undefined, 10).total).toBe(2);
  });

  it("keeps one user id per profile", () => {
    const { audience } = startCore();
    const a = audience.resolve(who({ email: "x@example.com", userId: "u-1" }), "api", "2026-11-01T10:00:00Z").profile;
    // A user id unknown here, on a record whose email is someone else's with another user id: a new person.
    const r = audience.resolve(who({ email: "x@example.com", userId: "u-9" }), "api", "2026-11-02T10:00:00Z");
    expect(r.profile).not.toBe(a);
    expect(audience.personOf(a)!.userId).toBe("u-1");
  });

  it("joins people transitively, in one step", () => {
    const { audience } = startCore();
    const e = audience.resolve(who({ email: "a@example.com" }), "api", "2026-11-01T10:00:00Z").profile;
    const p = audience.resolve(who({ phone: "05551112233" }), "api", "2026-11-01T10:00:00Z").profile;
    const u = audience.resolve(who({ userId: "u-7" }), "api", "2026-11-01T10:00:00Z").profile;
    const r = audience.resolve(who({ email: "a@example.com", phone: "05551112233", userId: "u-7" }), "api", "2026-11-02T10:00:00Z");
    expect(r.profile).toBe(u);
    expect(r.merged.sort()).toEqual([e, p].sort());
    expect(audience.people({}, undefined, 10).total).toBe(1);
    expect(audience.summary().mergedThisMonth).toBe(2);
  });

  it("matches only by the kinds the file names", () => {
    const { audience } = startCore(FILE.replace("match_by: [email, phone, user_id]", "match_by: [user_id]").replace("{sources}", ""));
    const a = audience.resolve(who({ userId: "u-1", email: "same@example.com" }), "api", "2026-11-01T10:00:00Z").profile;
    const b = audience.resolve(who({ userId: "u-2", email: "same@example.com" }), "api", "2026-11-01T10:00:00Z").profile;
    expect(a).not.toBe(b);
    // Both keep the email, since emails are not compared.
    expect(audience.personOf(b)!.email).toBe("same@example.com");
  });
});

describe("traits", () => {
  it("are what the file declares, from the sources it allows, in its types", () => {
    const { audience } = startCore();
    const p = audience.resolve(who({ email: "t@example.com" }), "api", "2026-11-01T10:00:00Z").profile;
    const ignored = audience.setTraits(
      p,
      { plan: "pro", seats: "12", trial: "true", renewal_date: "2027-01-31", colour: "red", sector: "Retail", city: "Ankara" },
      "messages",
      "2026-11-01T10:00:00Z",
    );
    expect(ignored).toEqual([
      { trait: "colour", reason: "not in audience.yaml" },
      { trait: "sector", reason: "set only from crm, forms, import, api" },
    ]);
    expect(audience.personOf(p)!.traits).toEqual({ city: "Ankara", plan: "Pro", renewal_date: "2027-01-31", seats: 12, trial: true });
    expect(audience.setTraits(p, { plan: "Gold", seats: "many" }, "api", "2026-11-02T10:00:00Z")).toEqual([
      { trait: "plan", reason: "is one of Free, Pro, Business" },
      { trait: "seats", reason: "is a number" },
    ]);
  });

  it("an older value does not replace a newer one; null removes", () => {
    const { audience } = startCore();
    const p = audience.resolve(who({ email: "t@example.com" }), "api", "2026-11-01T10:00:00Z").profile;
    audience.setTraits(p, { plan: "Pro" }, "api", "2026-11-05T10:00:00Z");
    audience.setTraits(p, { plan: "Free" }, "api", "2026-10-01T10:00:00Z");
    expect(audience.personOf(p)!.traits.plan).toBe("Pro");
    audience.setTraits(p, { plan: null }, "api", "2026-11-06T10:00:00Z");
    expect(audience.personOf(p)!.traits.plan).toBeUndefined();
  });
});

describe("events", () => {
  it("are kept once per source id, and old ones go after the file's period", () => {
    const { audience, clock } = startCore();
    const p = audience.resolve(who({ email: "e@example.com" }), "api", "2026-11-01T10:00:00Z").profile;
    const e = { source: "crm" as const, type: "deal_opened", at: "2026-11-01T10:00:00.000Z", text: "Deal", props: { stage: "Proposal" }, external: "deal-1" };
    expect(audience.addEvent(p, e)).not.toBeNull();
    expect(audience.addEvent(p, e)).toBeNull();
    expect(audience.addEvent(p, { ...e, source: "forms" })).not.toBeNull();
    audience.addEvent(p, { ...e, external: null, at: new Date(clock() - 800 * 86_400_000).toISOString() });
    expect(audience.person(p).eventCount).toBe(3);
    expect(audience.purge()).toBe(1);
    expect(audience.person(p).eventCount).toBe(2);
    expect(audience.person(p).lastAt).toBe("2026-11-01T10:00:00.000Z");
  });
});
