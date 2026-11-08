import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseConfig, watchConfig } from "./config.ts";

const err = (text: string) => {
  try {
    parseConfig(text);
  } catch (e) {
    return (e as Error).message;
  }
  return "no error";
};

describe("the file", () => {
  it("reads the example in config/", () => {
    const c = parseConfig(readFileSync(new URL("../config/audience.yaml", import.meta.url), "utf8"));
    expect(c.matchBy).toEqual(["email", "phone", "user_id"]);
    expect(c.phoneCountry).toBe("TR");
    expect(c.traits.map((t) => t.key)).toEqual(["plan", "city", "sector", "company", "renewal_date"]);
    expect(c.traits[0]).toEqual({ key: "plan", type: "string", values: ["Free", "Pro", "Business"], from: ["api", "crm", "import"] });
    expect(c.links).toEqual([
      { id: "analytics", url: null, token: "AUDIENCE_ANALYTICS_TOKEN", delete: true, sites: ["shop"], pull: 5 },
      { id: "consent", url: null, token: "AUDIENCE_CONSENT_TOKEN", delete: true, sites: [], pull: 5 },
    ]);
    expect(c.keepDays).toBe(761);
    expect(c.recountMinutes).toBe(15);
  });

  it("has defaults for an empty file", () => {
    expect(parseConfig("")).toMatchObject({
      matchBy: ["email", "phone", "user_id"],
      phoneCountry: "TR",
      traits: [],
      links: [],
      keepDays: 761,
      recountMinutes: 15,
    });
  });

  it("reads the linked products, with tokens named, not given", () => {
    const c = parseConfig(`sources:
  forms: true
  crm: { url: "http://crm:8080/", token: AUDIENCE_CRM_TOKEN }
  messages: { token: AUDIENCE_MESSAGES_TOKEN, delete: false }
segments: { recount: nightly }
events: { keep: 2y }`);
    expect(c.links).toEqual([
      { id: "forms", url: null, token: null, delete: false, sites: [], pull: 5 },
      { id: "crm", url: "http://crm:8080", token: "AUDIENCE_CRM_TOKEN", delete: true, sites: [], pull: 5 },
      { id: "messages", url: null, token: "AUDIENCE_MESSAGES_TOKEN", delete: false, sites: [], pull: 5 },
    ]);
    expect(c.recountMinutes).toBe(1440);
    expect(c.keepDays).toBe(730);
  });

  it("says what to fix", () => {
    expect(err("traits: [")).toMatch(/Not valid YAML/);
    expect(err("other: 1")).toMatch(/Unknown other/);
    expect(err("match_by: [email, fingerprint]")).toMatch(/no device fingerprints/);
    expect(err("phone_country: XX")).toMatch(/phone_country is one of TR/);
    expect(err("traits: { Plan: {} }")).toMatch(/lowercase letters/);
    expect(err("traits: { email: {} }")).toMatch(/part of every profile/);
    expect(err("traits: { plan: { type: colour } }")).toMatch(/type is string, number, boolean, date/);
    expect(err("traits: { seats: { type: number, values: [1] } }")).toMatch(/only for string traits/);
    expect(err("traits: { plan: { from: [twitter] } }")).toMatch(/from is one or more of analytics/);
    expect(err("sources: { analytics: { token: hunter2, sites: [shop] } }")).toMatch(/name of an environment variable/);
    expect(err("sources: { analytics: { token: T } }")).toMatch(/sites is a list/);
    expect(err("sources: { consent: true }")).toMatch(/consent is a map with at least token/);
    expect(err("sources: { crm: { delete: true } }")).toMatch(/delete needs token/);
    expect(err("sources: { slack: true }")).toMatch(/Audience links to analytics, consent/);
    expect(err("events: { keep: 1d }")).toMatch(/30 days to 10 years/);
    expect(err("segments: { recount: 2d }")).toMatch(/1 minute to 24 hours/);
  });
});

describe("watching the file", () => {
  it("applies changes and keeps the last good version on a mistake", () => {
    const dir = mkdtempSync(join(tmpdir(), "audience-"));
    const path = join(dir, "audience.yaml");
    writeFileSync(path, "traits: { plan: {} }");
    const applied: string[][] = [];
    const w = watchConfig(path, (c) => void applied.push(c.traits.map((t) => t.key)), { everyMs: 60_000 });
    expect(w.state).toMatchObject({ traits: 1, error: null });
    writeFileSync(path, "traits: [");
    w.read();
    expect(w.state.error).toMatch(/Not valid YAML/);
    writeFileSync(path, "traits: { plan: {}, city: {} }");
    w.read();
    expect(w.state).toMatchObject({ traits: 2, error: null });
    expect(applied).toEqual([["plan"], ["plan", "city"]]);
    w.stop();
  });
});
