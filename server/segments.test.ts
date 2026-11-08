import { describe, expect, it } from "vitest";
import { parseCsv } from "./csv.ts";
import { startCore } from "./test-app.ts";

const DAY = 86_400_000;

function setup() {
  const core = startCore();
  const { audience, segments, clock } = core;
  const event = (email: string, type: string, props: Record<string, unknown> = {}, traits: Record<string, unknown> = {}, daysAgo = 0) =>
    audience.ingest({ events: [{ type, person: { email }, properties: props, traits, at: new Date(clock() - daysAgo * DAY).toISOString() }] });
  const rules = {
    all: [
      { trait: "plan", op: "is", value: "Free" },
      { event: "page_viewed", op: "at_least", days: 30, where: { path: "/pricing" } },
      { event: "deal_opened", op: "none" },
    ],
  };
  return { ...core, audience, segments, event, rules };
}

describe("membership", () => {
  it("follows people as they act: in when the rules hold, out as soon as they do not", () => {
    const { segments, event, rules, audience } = setup();
    const s = segments.create({ name: "Free users back on pricing", rules }, "selin@example.com");
    expect(s).toMatchObject({ size: 0, owner: "selin@example.com", period: true });
    event("okan@example.com", "signed_up", {}, { plan: "Free" });
    expect(segments.get(s.id).size).toBe(0);
    event("okan@example.com", "page_viewed", { path: "/pricing" });
    expect(segments.get(s.id).size).toBe(1);
    const okan = audience.people({ email: "okan@example.com" }, undefined, 1).items[0]!.id;
    expect(segments.forProfile(okan)).toEqual([{ id: s.id, name: "Free users back on pricing" }]);
    // CRM opens a deal: out at once.
    event("okan@example.com", "deal_opened", { stage: "Proposal" });
    expect(segments.get(s.id).size).toBe(0);
    expect(segments.changes(s.id, undefined, 10).changes.map((c) => c.change)).toEqual(["joined", "left"]);
  });

  it("people leave a period as days pass, counted again on the timer", () => {
    const { segments, event, rules, clock } = setup();
    event("a@example.com", "page_viewed", { path: "/pricing" }, { plan: "Free" }, 25);
    event("b@example.com", "page_viewed", { path: "/pricing" }, { plan: "Free" }, 1);
    const s = segments.create({ name: "Back on pricing", rules }, "test");
    expect(s.size).toBe(2);
    clock.advance(10 * DAY);
    // Members read now are always right, before the timer counts again.
    expect(segments.members(s.id, undefined, 10, "token:messages").items.map((m) => m.email)).toEqual(["b@example.com"]);
    expect(segments.get(s.id).size).toBe(2);
    expect(segments.recount()).toBe(1);
    const after = segments.get(s.id);
    expect(after.size).toBe(1);
    expect(after.history.at(-1)).toEqual({ day: "2026-11-18", size: 1 });
    expect(after.history.at(-11)).toEqual({ day: "2026-11-08", size: 2 });
    expect(after.history[0]!.size).toBe(0);
    expect(after.change30d).toBe(1);
  });

  it("a person joined into another, or deleted, leaves", () => {
    const { segments, audience } = setup();
    audience.ingest({ events: [{ type: "signed_up", person: { phone: "05551112233" }, traits: { plan: "Free" } }] });
    const s = segments.create({ name: "Free", rules: { trait: "plan", op: "is", value: "Free" } }, "test");
    expect(s.size).toBe(1);
    // The same person by email and phone: the phone's profile joins the email's, which is not Free.
    audience.ingest({ events: [{ type: "signed_up", person: { email: "x@example.com" }, traits: { plan: "Pro" } }] });
    audience.ingest({ events: [{ type: "linked", person: { email: "x@example.com", phone: "+905551112233" } }] });
    expect(segments.get(s.id).size).toBe(0);
    expect(segments.changes(s.id, undefined, 10).changes.map((c) => c.change)).toEqual(["joined", "left"]);
  });
});

describe("what products read", () => {
  it("members a page at a time, with who read them", () => {
    const { segments, audience } = setup();
    for (let i = 0; i < 25; i++)
      audience.ingest({
        events: [{ type: "signed_up", person: { email: `p${i}@example.com`, name: `P ${i}` }, traits: { plan: i % 2 ? "Pro" : "Free", city: "İzmir" } }],
      });
    const s = segments.create(
      {
        name: "Free in İzmir",
        rules: {
          all: [
            { trait: "plan", op: "is", value: "Free" },
            { trait: "city", op: "is", value: "izmir" },
          ],
        },
      },
      "test",
    );
    expect(s.size).toBe(13);
    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const page = segments.members(s.id, cursor, 5, "token:messages");
      seen.push(...page.items.map((m) => m.email!));
      expect(page.items[0]).toMatchObject({ traits: { plan: "Free", city: "İzmir" } });
      cursor = page.nextCursor;
    } while (cursor);
    expect(seen).toHaveLength(13);
    expect(new Set(seen).size).toBe(13);
    // One read of all pages is one read.
    expect(segments.get(s.id).readers).toEqual([{ actor: "token:messages", lastAt: expect.any(String), reads: 1 }]);
    expect(segments.list()[0]!.usedBy).toEqual(["token:messages"]);
  });

  it("the CSV, safe to open in a spreadsheet", () => {
    const { segments, audience } = setup();
    audience.ingest({
      events: [{ type: "x", person: { email: "a@example.com", name: '=HYPERLINK("http://evil")', phone: "05551112233" }, traits: { plan: "Free", seats: 3 } }],
    });
    const s = segments.create({ name: "Everyone with an email", rules: { identifier: "email", op: "exists" } }, "test");
    const rows = parseCsv([...segments.csv(s.id, "selin@example.com")].join(""));
    expect(rows[0]).toEqual(["id", "name", "email", "phone", "user_id", "plan", "city", "sector", "seats", "trial", "renewal_date"]);
    expect(rows[1]!.slice(1, 6)).toEqual(['\'=HYPERLINK("http://evil")', "a@example.com", "'+905551112233", "", "Free"]);
    expect(rows[1]![8]).toBe("3");
  });

  it("previews rules without saving, and refuses a second segment of the same name", () => {
    const { segments, audience } = setup();
    audience.ingest({ events: [{ type: "x", person: { email: "a@example.com" }, traits: { plan: "Free" } }] });
    expect(segments.preview({ rules: { trait: "plan", op: "is", value: "Free" } })).toMatchObject({ size: 1, sample: [{ email: "a@example.com" }] });
    segments.create({ name: "Free", rules: { trait: "plan", op: "exists" } }, "test");
    expect(() => segments.create({ name: "free", rules: { trait: "plan", op: "exists" } }, "test")).toThrow(/named free already/);
    expect(() => segments.create({ name: "Bad", rules: { trait: "nope", op: "exists" } }, "test")).toThrow(/no trait "nope"/);
  });

  it("is changed and counted again when its rules change", () => {
    const { segments, audience } = setup();
    audience.ingest({ events: [{ type: "x", person: { email: "a@example.com" }, traits: { plan: "Free" } }] });
    const s = segments.create({ name: "Pro", rules: { trait: "plan", op: "is", value: "Pro" } }, "test");
    expect(s.size).toBe(0);
    expect(segments.update(s.id, { rules: { trait: "plan", op: "is", value: "Free" }, description: "Now Free" })).toMatchObject({
      size: 1,
      description: "Now Free",
      name: "Pro",
    });
    segments.remove(s.id);
    expect(segments.list()).toEqual([]);
  });
});
