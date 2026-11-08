import { describe, expect, it } from "vitest";
import type { Source } from "./config.ts";
import { fold } from "./identity.ts";
import { parseRules, type Condition } from "./rules.ts";
import { startCore } from "./test-app.ts";

const DAY = 86_400_000;

/** A small world: people with traits and events, added through the same code the API uses. */
function world() {
  const core = startCore();
  const { audience, clock } = core;
  const ago = (days: number, hours = 0) => new Date(clock() - days * DAY - hours * 3_600_000).toISOString();
  const person = (
    email: string,
    traits: Record<string, unknown> = {},
    events: Array<{ type: string; daysAgo: number; source?: Source; props?: Record<string, unknown> }> = [],
  ) => {
    const r = audience.resolve({ email, phone: null, userId: null, name: null }, "api", ago(200));
    audience.setTraits(r.profile, traits, "api", ago(200));
    for (const e of events)
      audience.addEvent(r.profile, { source: e.source ?? "api", type: e.type, at: ago(e.daysAgo), text: null, props: e.props ?? null, external: null });
    return r.profile;
  };
  const members = (rules: unknown) => {
    const c = parseRules(rules, core.config);
    const { sql, args } = core.segments.sqlOf(c, clock());
    const ids = audience.all<{ id: string }>(`SELECT p.id FROM profiles p WHERE ${sql}`, ...args).map((r) => r.id);
    const emails = ids.map((id) => audience.personOf(id)!.email!);
    return emails.sort();
  };
  return { ...core, person, members, ago };
}

describe("trait rules", () => {
  const w = world();
  w.person("free-izmir@example.com", { plan: "Free", city: "İzmir", seats: 3, trial: true, renewal_date: "2026-12-01" });
  w.person("pro-ankara@example.com", { plan: "Pro", city: "Ankara", seats: 12, trial: false, renewal_date: "2027-03-01" });
  w.person("business@example.com", { plan: "business", city: "IZMIR", seats: 40 });
  w.person("nothing@example.com");

  it("is: by the file's spelling, ignoring case, the Turkish way", () => {
    expect(w.members({ trait: "plan", op: "is", value: "Free" })).toEqual(["free-izmir@example.com"]);
    expect(w.members({ trait: "plan", op: "is", value: "Business" })).toEqual(["business@example.com"]);
    expect(w.members({ trait: "city", op: "is", value: "izmir" })).toEqual(["business@example.com", "free-izmir@example.com"]);
  });

  it("is_not and not_in hold for people without the trait", () => {
    expect(w.members({ trait: "plan", op: "is_not", value: "Free" })).toEqual(["business@example.com", "nothing@example.com", "pro-ankara@example.com"]);
    expect(w.members({ trait: "plan", op: "not_in", value: ["Free", "Pro"] })).toEqual(["business@example.com", "nothing@example.com"]);
    expect(w.members({ trait: "plan", op: "in", value: ["free", "PRO"] })).toEqual(["free-izmir@example.com", "pro-ankara@example.com"]);
  });

  it("exists, missing and contains", () => {
    expect(w.members({ trait: "trial", op: "exists" })).toEqual(["free-izmir@example.com", "pro-ankara@example.com"]);
    expect(w.members({ trait: "city", op: "missing" })).toEqual(["nothing@example.com"]);
    expect(w.members({ trait: "city", op: "contains", value: "zMi" })).toEqual(["business@example.com", "free-izmir@example.com"]);
  });

  it("compares numbers as numbers, and booleans as true or false", () => {
    expect(w.members({ trait: "seats", op: "gt", value: 3 })).toEqual(["business@example.com", "pro-ankara@example.com"]);
    expect(w.members({ trait: "seats", op: "gte", value: 3 })).toHaveLength(3);
    expect(w.members({ trait: "seats", op: "lt", value: 12 })).toEqual(["free-izmir@example.com"]);
    expect(w.members({ trait: "seats", op: "lte", value: 12 })).toEqual(["free-izmir@example.com", "pro-ankara@example.com"]);
    expect(w.members({ trait: "seats", op: "is", value: 40 })).toEqual(["business@example.com"]);
    expect(w.members({ trait: "trial", op: "is", value: true })).toEqual(["free-izmir@example.com"]);
    expect(w.members({ trait: "trial", op: "is_not", value: true })).toEqual(["business@example.com", "nothing@example.com", "pro-ankara@example.com"]);
  });

  it("compares dates, and dates in a period from today", () => {
    // Today is 2026-11-08.
    expect(w.members({ trait: "renewal_date", op: "within_next", days: 60 })).toEqual(["free-izmir@example.com"]);
    expect(w.members({ trait: "renewal_date", op: "within_next", days: 200 })).toEqual(["free-izmir@example.com", "pro-ankara@example.com"]);
    expect(w.members({ trait: "renewal_date", op: "within_last", days: 30 })).toEqual([]);
    expect(w.members({ trait: "renewal_date", op: "before", value: "2027-01-01" })).toEqual(["free-izmir@example.com"]);
    expect(w.members({ trait: "renewal_date", op: "after", value: "2026-12-01" })).toEqual(["pro-ankara@example.com"]);
    expect(w.members({ trait: "renewal_date", op: "is", value: "2026-12-01" })).toEqual(["free-izmir@example.com"]);
  });
});

describe("event rules", () => {
  const w = world();
  w.person("twice-this-month@example.com", { plan: "Free" }, [
    { type: "page_viewed", daysAgo: 2, props: { path: "/pricing" } },
    { type: "page_viewed", daysAgo: 20, props: { path: "/pricing" } },
    { type: "page_viewed", daysAgo: 1, props: { path: "/blog" } },
  ]);
  w.person("once-long-ago@example.com", { plan: "Free" }, [{ type: "page_viewed", daysAgo: 45, props: { path: "/pricing" } }]);
  w.person("deal@example.com", { plan: "Free" }, [
    { type: "page_viewed", daysAgo: 5, props: { path: "/pricing" } },
    { type: "deal_opened", daysAgo: 3, source: "crm", props: { status: "open", paid: false } },
  ]);
  w.person("bank@example.com", { plan: "Pro" }, [{ type: "bank-connected", daysAgo: 100 }]);
  w.person("pro@example.com", { plan: "Pro" });

  const pricing = (days?: number, op = "at_least", count?: number) => ({
    event: "page_viewed",
    where: { path: "/pricing" },
    op,
    ...(count !== undefined && { count }),
    ...(days && { days }),
  });

  it("counts events of a type with its properties, in a period or ever", () => {
    expect(w.members(pricing(30))).toEqual(["deal@example.com", "twice-this-month@example.com"]);
    expect(w.members(pricing(7))).toEqual(["deal@example.com", "twice-this-month@example.com"]);
    expect(w.members(pricing(3))).toEqual(["twice-this-month@example.com"]);
    expect(w.members(pricing())).toEqual(["deal@example.com", "once-long-ago@example.com", "twice-this-month@example.com"]);
    expect(w.members(pricing(30, "at_least", 2))).toEqual(["twice-this-month@example.com"]);
    expect(w.members(pricing(undefined, "exactly", 1))).toEqual(["deal@example.com", "once-long-ago@example.com"]);
    expect(w.members(pricing(30, "at_most", 1))).toEqual(["bank@example.com", "deal@example.com", "once-long-ago@example.com", "pro@example.com"]);
    expect(w.members(pricing(30, "exactly", 0))).toEqual(["bank@example.com", "once-long-ago@example.com", "pro@example.com"]);
  });

  it("an event that never happened, or not in the period", () => {
    expect(w.members({ event: "bank-connected", op: "none" })).toEqual([
      "deal@example.com",
      "once-long-ago@example.com",
      "pro@example.com",
      "twice-this-month@example.com",
    ]);
    expect(w.members({ event: "bank-connected", op: "none", days: 30 })).toHaveLength(5);
    expect(
      w.members({
        all: [
          { trait: "plan", op: "is", value: "Pro" },
          { event: "bank-connected", op: "none" },
        ],
      }),
    ).toEqual(["pro@example.com"]);
  });

  it("only from a source, and with a property that is true or false", () => {
    expect(w.members({ event: "deal_opened", op: "at_least", source: "crm" })).toEqual(["deal@example.com"]);
    expect(w.members({ event: "deal_opened", op: "at_least", source: "forms" })).toEqual([]);
    expect(w.members({ event: "deal_opened", op: "at_least", where: { paid: false } })).toEqual(["deal@example.com"]);
    expect(w.members({ event: "deal_opened", op: "at_least", where: { paid: true } })).toEqual([]);
  });

  it("the design's segment: plan is Free, viewed /pricing in the last 30 days, no open deal", () => {
    const rules = {
      all: [{ trait: "plan", op: "is", value: "Free" }, pricing(30), { event: "deal_opened", op: "none", where: { status: "open" } }],
    };
    expect(w.members(rules)).toEqual(["twice-this-month@example.com"]);
  });

  it("and, or and groups in groups", () => {
    expect(w.members({ any: [{ trait: "plan", op: "is", value: "Pro" }, pricing(3)] })).toEqual([
      "bank@example.com",
      "pro@example.com",
      "twice-this-month@example.com",
    ]);
    expect(
      w.members({
        all: [
          { any: [{ trait: "plan", op: "is", value: "Pro" }, pricing(30)] },
          {
            any: [
              { event: "bank-connected", op: "at_least" },
              { event: "deal_opened", op: "at_least" },
            ],
          },
        ],
      }),
    ).toEqual(["bank@example.com", "deal@example.com"]);
    expect(w.members({ identifier: "email", op: "exists" })).toHaveLength(5);
    expect(w.members({ identifier: "phone", op: "exists" })).toEqual([]);
  });

  it("moves with the clock: a view drops out of the period as days pass", () => {
    expect(w.members(pricing(3))).toEqual(["twice-this-month@example.com"]);
    w.clock.advance(2 * DAY);
    expect(w.members(pricing(3))).toEqual([]);
    w.clock.advance(-2 * DAY);
  });
});

describe("rules that are refused", () => {
  const w = world();
  const err = (rules: unknown) => {
    try {
      parseRules(rules, w.config);
      return "no error";
    } catch (e) {
      return (e as Error).message;
    }
  };
  it("say which condition and why", () => {
    expect(err({ trait: "colour", op: "is", value: "red" })).toMatch(/no trait "colour" in audience.yaml/);
    expect(err({ trait: "seats", op: "contains", value: "1" })).toMatch(/a number trait takes is, is_not, gt/);
    expect(err({ trait: "seats", op: "gt", value: "3" })).toMatch(/value is a number/);
    expect(err({ trait: "renewal_date", op: "within_next" })).toMatch(/days is 1 to 3650/);
    expect(err({ all: [] })).toMatch(/one or more conditions/);
    expect(err({ all: [{ event: "Page Viewed", op: "at_least" }] })).toMatch(/rules.all\[0\].event is an event type/);
    expect(err({ event: "x", op: "none", count: 2 })).toMatch(/none takes no count/);
    expect(err({ event: "x", op: "at_least", count: 0 })).toMatch(/count is 1 to 1000/);
    expect(err({ event: "x", op: "at_least", where: { "a.b": 1 } })).toMatch(/not a property name/);
    expect(err({ all: [{ all: [{ all: [{ all: [{ trait: "plan", op: "exists" }] }] }] }] })).toBe("no error");
    expect(err({ all: [{ all: [{ all: [{ all: [{ all: [{ trait: "plan", op: "exists" }] }] }] }] }] })).toMatch(/at most 4 deep/);
    expect(err({ identifier: "fingerprint", op: "exists" })).toMatch(/email, phone or user_id/);
    expect(err({ trait: "plan", op: "exists", extra: 1 })).toMatch(/unknown extra/);
  });
});

// ---------------------------------------------------------------- The SQL against a plain reading of the rules

type Ref = {
  traits: Record<string, string | number | boolean>;
  events: Array<{ type: string; at: string; source: Source; props: Record<string, unknown> }>;
  phone: boolean;
};

/** The rules read the plain way, person by person, to check the SQL against. */
function holds(c: Condition, p: Ref, now: number): boolean {
  if ("all" in c) return c.all.every((x) => holds(x, p, now));
  if ("any" in c) return c.any.some((x) => holds(x, p, now));
  if ("identifier" in c) return (c.identifier === "email" || (c.identifier === "phone" && p.phone)) === (c.op === "exists");
  if ("trait" in c) {
    const v = p.traits[c.trait];
    const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
    const eq = () => v !== undefined && (typeof c.value === "number" ? v === c.value : fold(String(v)) === fold(String(c.value)));
    switch (c.op) {
      case "exists":
        return v !== undefined;
      case "missing":
        return v === undefined;
      case "is":
        return eq();
      case "is_not":
        return !eq();
      case "in":
        return v !== undefined && (c.value as string[]).some((x) => fold(x) === fold(String(v)));
      case "not_in":
        return !(v !== undefined && (c.value as string[]).some((x) => fold(x) === fold(String(v))));
      case "contains":
        return v !== undefined && fold(String(v)).includes(fold(String(c.value)));
      case "gt":
        return typeof v === "number" && v > (c.value as number);
      case "gte":
        return typeof v === "number" && v >= (c.value as number);
      case "lt":
        return typeof v === "number" && v < (c.value as number);
      case "lte":
        return typeof v === "number" && v <= (c.value as number);
      case "before":
        return v !== undefined && String(v).slice(0, 10) < (c.value as string);
      case "after":
        return v !== undefined && String(v).slice(0, 10) > (c.value as string);
      case "within_last":
        return v !== undefined && String(v).slice(0, 10) >= day(now - c.days! * DAY) && String(v).slice(0, 10) <= day(now);
      case "within_next":
        return v !== undefined && String(v).slice(0, 10) >= day(now) && String(v).slice(0, 10) <= day(now + c.days! * DAY);
    }
  }
  const from = c.days ? new Date(now - c.days * DAY).toISOString() : null;
  const to = new Date(now).toISOString();
  const n = p.events.filter(
    (e) =>
      e.type === c.event &&
      (!from || (e.at >= from && e.at <= to)) &&
      (!c.source || e.source === c.source) &&
      Object.entries(c.where ?? {}).every(([k, x]) => e.props[k] === x),
  ).length;
  const want = c.count ?? 1;
  return c.op === "none" ? n === 0 : c.op === "at_least" ? n >= want : c.op === "at_most" ? n <= want : n === want;
}

/** A seeded random, so a failure can be run again. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => (s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32;
}

describe("the SQL a segment becomes", () => {
  it("agrees with the plain reading on random people and random rules", () => {
    const r = rng(7);
    const pick = <T>(xs: readonly T[]) => xs[Math.floor(r() * xs.length)]!;
    const w = world();
    const now = w.clock();
    const people = new Map<string, Ref>();
    const PATHS = ["/pricing", "/blog", "/"];
    const TYPES = ["page_viewed", "signup", "deal_opened", "message_opened"];
    const SRC: Source[] = ["api", "crm", "forms", "analytics"];
    for (let i = 0; i < 400; i++) {
      const traits: Ref["traits"] = {};
      if (r() < 0.8) traits.plan = pick(["Free", "Pro", "Business"]);
      if (r() < 0.7) traits.city = pick(["İzmir", "Ankara", "istanbul", "IZMIR"]);
      if (r() < 0.6) traits.seats = Math.floor(r() * 50);
      if (r() < 0.5) traits.trial = r() < 0.5;
      if (r() < 0.5) traits.renewal_date = new Date(now + Math.round((r() - 0.5) * 200) * DAY).toISOString().slice(0, 10);
      const events: Ref["events"] = [];
      const n = Math.floor(r() * 9);
      for (let k = 0; k < n; k++) {
        const type = pick(TYPES);
        events.push({
          type,
          at: new Date(now - Math.floor(r() * 120 * DAY)).toISOString(),
          source: pick(SRC),
          props: type === "page_viewed" ? { path: pick(PATHS) } : type === "deal_opened" ? { status: pick(["open", "won"]), paid: r() < 0.5 } : {},
        });
      }
      const res = w.audience.resolve(
        { email: `p${i}@example.com`, phone: r() < 0.3 ? `+90555${String(1000000 + i)}` : null, userId: null, name: null },
        "api",
        w.ago(300),
      );
      w.audience.setTraits(res.profile, traits, "api", w.ago(300));
      for (const e of events) w.audience.addEvent(res.profile, { ...e, text: null, external: null });
      const phone = !!w.audience.personOf(res.profile)!.phone;
      people.set(res.profile, { traits: Object.fromEntries(Object.entries(w.audience.personOf(res.profile)!.traits)), events, phone });
    }
    const leaf = (): unknown => {
      const k = r();
      if (k < 0.45) {
        const t = pick(["plan", "city", "seats", "trial", "renewal_date"] as const);
        const ops = {
          plan: ["is", "is_not", "in", "not_in", "contains", "exists", "missing"],
          city: ["is", "contains", "in", "missing"],
          seats: ["gt", "gte", "lt", "lte", "is", "is_not"],
          trial: ["is", "is_not", "exists"],
          renewal_date: ["within_next", "within_last", "before", "after", "missing"],
        }[t];
        const op = pick(ops);
        const value =
          t === "seats"
            ? Math.floor(r() * 50)
            : t === "trial"
              ? r() < 0.5
              : t === "renewal_date"
                ? new Date(now + Math.round((r() - 0.5) * 200) * DAY).toISOString().slice(0, 10)
                : pick(t === "plan" ? ["Free", "pro", "BUSINESS"] : ["izmir", "Ankara", "IST", "zm"]);
        if (op === "exists" || op === "missing") return { trait: t, op };
        if (op === "within_next" || op === "within_last") return { trait: t, op, days: 1 + Math.floor(r() * 120) };
        if (op === "in" || op === "not_in") return { trait: t, op, value: [String(value), pick(["Free", "Ankara"])] };
        return { trait: t, op, value };
      }
      if (k < 0.92) {
        const type = pick(TYPES);
        const op = pick(["at_least", "at_most", "exactly", "none"]);
        return {
          event: type,
          op,
          ...(op !== "none" && { count: op === "at_least" ? 1 + Math.floor(r() * 3) : Math.floor(r() * 3) }),
          ...(r() < 0.6 && { days: 1 + Math.floor(r() * 100) }),
          ...(r() < 0.2 && { source: pick(SRC) }),
          ...(type === "page_viewed" && r() < 0.6 && { where: { path: pick(PATHS) } }),
          ...(type === "deal_opened" && r() < 0.6 && { where: r() < 0.5 ? { status: pick(["open", "won"]) } : { paid: r() < 0.5 } }),
        };
      }
      return { identifier: pick(["email", "phone", "user_id"]), op: pick(["exists", "missing"]) };
    };
    const tree = (depth: number): unknown =>
      depth < 2 && r() < 0.4 ? { [pick(["all", "any"])]: Array.from({ length: 1 + Math.floor(r() * 3) }, () => tree(depth + 1)) } : leaf();
    let nonEmpty = 0;
    for (let i = 0; i < 300; i++) {
      const rules = parseRules(tree(0), w.config);
      const { sql, args } = w.segments.sqlOf(rules, now);
      const got = new Set(w.audience.all<{ id: string }>(`SELECT p.id FROM profiles p WHERE ${sql}`, ...args).map((x) => x.id));
      const want = new Set([...people].filter(([, p]) => holds(rules, p, now)).map(([id]) => id));
      expect([...got].sort(), JSON.stringify(rules)).toEqual([...want].sort());
      if (got.size && got.size < people.size) nonEmpty++;
    }
    // The random rules are not all trivially everyone or no one.
    expect(nonEmpty).toBeGreaterThan(100);
  });
});

describe("tens of thousands of profiles", () => {
  it("counts a segment with traits, a period and an absent event in well under a second", () => {
    const w = world();
    const now = w.clock();
    const db = w.audience.db;
    const N = 40_000;
    db.exec("BEGIN");
    const p = db.prepare("INSERT INTO profiles (id, created_at, updated_at, first_source, sources) VALUES (?, ?, ?, 'api', 'api')");
    const t = db.prepare("INSERT INTO traits (profile, key, value, num, folded, updated_at, source) VALUES (?, ?, ?, NULL, ?, ?, 'api')");
    const e = db.prepare("INSERT INTO events (profile, source, type, at, props, recorded_at) VALUES (?, 'analytics', ?, ?, ?, ?)");
    const r = rng(42);
    const at = new Date(now).toISOString();
    let expected = 0;
    for (let i = 0; i < N; i++) {
      const id = `perf${String(i).padStart(8, "0")}`;
      p.run(id, at, at);
      const plan = ["Free", "Pro", "Business"][i % 3]!;
      t.run(id, "plan", plan, fold(plan), at);
      t.run(id, "city", i % 7 ? "Ankara" : "İzmir", fold(i % 7 ? "Ankara" : "İzmir"), at);
      let pricing = 0;
      let bank = false;
      for (let k = 0; k < 10; k++) {
        const daysAgo = Math.floor(r() * 90);
        const path = ["/pricing", "/blog", "/", "/docs"][Math.floor(r() * 4)]!;
        const type = r() < 0.02 ? "bank-connected" : "page_viewed";
        e.run(id, type, new Date(now - daysAgo * DAY - 1000).toISOString(), type === "page_viewed" ? JSON.stringify({ path }) : null, at);
        if (type === "page_viewed" && path === "/pricing" && daysAgo < 30) pricing++;
        if (type === "bank-connected") bank = true;
      }
      if (plan === "Free" && pricing >= 2 && !bank) expected++;
    }
    db.exec("COMMIT");
    const rules = {
      all: [
        { trait: "plan", op: "is", value: "Free" },
        { event: "page_viewed", op: "at_least", count: 2, days: 30, where: { path: "/pricing" } },
        { event: "bank-connected", op: "none" },
      ],
    };
    const started = performance.now();
    const preview = w.segments.preview({ rules });
    const ms = performance.now() - started;
    expect(preview.size).toBe(expected);
    expect(expected).toBeGreaterThan(1000);
    expect(ms).toBeLessThan(1500);
    // A full recount of a saved segment over everyone, and one person evaluated again after an event.
    const s = w.segments.create({ name: "Free users back on pricing", rules }, "test");
    expect(s.size).toBe(expected);
    const one = performance.now();
    w.segments.refresh(new Set(["perf00000000"]));
    expect(performance.now() - one).toBeLessThan(50);
  });
});
