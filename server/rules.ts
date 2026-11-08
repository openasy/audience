// The rules of a segment, and how they become one SQL condition on a profile. A person is in a segment while the
// condition holds: it is evaluated by SQLite over the profiles, their traits and their events, with the indexes the
// schema keeps for it (traits by profile and key, events by profile, type and time), so a segment of tens of
// thousands of people is counted in one query.
import type { SQLInputValue } from "node:sqlite";
import { ID_KINDS, SOURCES, type Config, type IdKind, type Source, type TraitType } from "./config.ts";
import { fold } from "./identity.ts";

export const TRAIT_OPS = [
  "is",
  "is_not",
  "in",
  "not_in",
  "contains",
  "exists",
  "missing",
  "gt",
  "gte",
  "lt",
  "lte",
  "before",
  "after",
  "within_last",
  "within_next",
] as const;
export type TraitOp = (typeof TRAIT_OPS)[number];
export const EVENT_OPS = ["at_least", "at_most", "exactly", "none"] as const;
export type EventOp = (typeof EVENT_OPS)[number];

/** Which comparisons each type of trait takes. */
export const OPS_BY_TYPE: Record<TraitType, readonly TraitOp[]> = {
  string: ["is", "is_not", "in", "not_in", "contains", "exists", "missing"],
  number: ["is", "is_not", "gt", "gte", "lt", "lte", "exists", "missing"],
  boolean: ["is", "is_not", "exists", "missing"],
  date: ["is", "before", "after", "within_last", "within_next", "exists", "missing"],
};

export type Scalar = string | number | boolean;

export type Condition =
  | { all: Condition[] }
  | { any: Condition[] }
  /** A trait compared with a value; `days` for within_last and within_next. */
  | { trait: string; op: TraitOp; value?: Scalar | Scalar[]; days?: number }
  /** How many events of a type the person has, ever or in the last `days` days, from one source and with properties if given. */
  | { event: string; op: EventOp; count?: number; days?: number | null; source?: Source; where?: Record<string, Scalar> }
  /** Whether the person has an email, a phone number or a user id. */
  | { identifier: IdKind; op: "exists" | "missing" };

export const EVENT_TYPE = /^[a-z0-9][a-z0-9_.:-]{0,63}$/;
const PROP = /^[A-Za-z0-9_]{1,40}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_DEPTH = 4;
const MAX_CONDITIONS = 50;
const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const isScalar = (v: unknown): v is Scalar => typeof v === "string" || typeof v === "boolean" || (typeof v === "number" && Number.isFinite(v));

export class RuleError extends Error {}

/** Checks a rule tree against the file's traits; throws a RuleError that names the condition at fault. */
export function parseRules(v: unknown, config: Pick<Config, "traits">): Condition {
  let count = 0;
  const traitType = (key: string) => config.traits.find((t) => t.key === key);
  const walk = (c: unknown, at: string, depth: number): Condition => {
    if (++count > MAX_CONDITIONS) throw new RuleError(`A segment has at most ${MAX_CONDITIONS} conditions.`);
    if (!isObj(c)) throw new RuleError(`${at} is a condition: all, any, trait, event or identifier.`);
    const keys = Object.keys(c);
    if ("all" in c || "any" in c) {
      const k = "all" in c ? "all" : "any";
      if (keys.length !== 1) throw new RuleError(`${at}: a group has ${k} and nothing else.`);
      if (depth >= MAX_DEPTH) throw new RuleError(`${at}: groups go at most ${MAX_DEPTH} deep.`);
      const items = c[k];
      if (!Array.isArray(items) || !items.length) throw new RuleError(`${at}.${k} is a list of one or more conditions.`);
      const parsed = items.map((x, i) => walk(x, `${at}.${k}[${i}]`, depth + 1));
      return k === "all" ? { all: parsed } : { any: parsed };
    }
    if ("trait" in c) {
      const extra = keys.filter((x) => !["trait", "op", "value", "days"].includes(x));
      if (extra.length) throw new RuleError(`${at}: unknown ${extra.join(", ")}; a trait condition takes trait, op, value and days.`);
      const t = typeof c.trait === "string" ? traitType(c.trait) : undefined;
      if (!t) throw new RuleError(`${at}.trait: no trait ${JSON.stringify(c.trait)} in audience.yaml.`);
      const ops = OPS_BY_TYPE[t.type];
      if (!ops.includes(c.op as TraitOp)) throw new RuleError(`${at}.op: a ${t.type} trait takes ${ops.join(", ")}.`);
      const op = c.op as TraitOp;
      const out: Condition = { trait: t.key, op };
      if (op === "exists" || op === "missing") {
        if (c.value !== undefined || c.days !== undefined) throw new RuleError(`${at}: ${op} takes no value.`);
        return out;
      }
      if (op === "within_last" || op === "within_next") {
        if (!Number.isInteger(c.days) || (c.days as number) < 1 || (c.days as number) > 3650) throw new RuleError(`${at}.days is 1 to 3650.`);
        if (c.value !== undefined) throw new RuleError(`${at}: ${op} takes days, not a value.`);
        return { ...out, days: c.days as number };
      }
      if (c.days !== undefined) throw new RuleError(`${at}.days is only for within_last and within_next.`);
      if (op === "in" || op === "not_in") {
        if (!Array.isArray(c.value) || !c.value.length || c.value.length > 100 || !c.value.every((x) => typeof x === "string" && x.length <= 200))
          throw new RuleError(`${at}.value is a list of 1 to 100 texts.`);
        return { ...out, value: c.value as string[] };
      }
      const value = c.value;
      if (!isScalar(value)) throw new RuleError(`${at}.value is required.`);
      if (t.type === "number" && typeof value !== "number") throw new RuleError(`${at}.value is a number.`);
      if (t.type === "boolean" && typeof value !== "boolean") throw new RuleError(`${at}.value is true or false.`);
      if (t.type === "date" && (typeof value !== "string" || !DATE.test(value) || Number.isNaN(Date.parse(value))))
        throw new RuleError(`${at}.value is a date, such as 2026-12-31.`);
      if (t.type === "string" && (typeof value !== "string" || !value.length || value.length > 200))
        throw new RuleError(`${at}.value is a text of up to 200 characters.`);
      return { ...out, value };
    }
    if ("event" in c) {
      const extra = keys.filter((x) => !["event", "op", "count", "days", "source", "where"].includes(x));
      if (extra.length) throw new RuleError(`${at}: unknown ${extra.join(", ")}; an event condition takes event, op, count, days, source and where.`);
      if (typeof c.event !== "string" || !EVENT_TYPE.test(c.event))
        throw new RuleError(`${at}.event is an event type: lowercase letters, digits, _ . : and -, such as page_viewed.`);
      if (!(EVENT_OPS as readonly unknown[]).includes(c.op)) throw new RuleError(`${at}.op is ${EVENT_OPS.join(", ")}.`);
      const op = c.op as EventOp;
      let n = 1;
      if (op === "none") {
        if (c.count !== undefined) throw new RuleError(`${at}: none takes no count.`);
      } else if (c.count !== undefined) {
        if (!Number.isInteger(c.count) || (c.count as number) < (op === "at_least" ? 1 : 0) || (c.count as number) > 1000)
          throw new RuleError(`${at}.count is ${op === "at_least" ? 1 : 0} to 1000.`);
        n = c.count as number;
      }
      const out: Condition = { event: c.event, op, ...(op !== "none" && { count: n }) };
      if (c.days !== undefined && c.days !== null) {
        if (!Number.isInteger(c.days) || (c.days as number) < 1 || (c.days as number) > 3650)
          throw new RuleError(`${at}.days is 1 to 3650, or left out for ever.`);
        out.days = c.days as number;
      }
      if (c.source !== undefined) {
        if (!(SOURCES as readonly unknown[]).includes(c.source)) throw new RuleError(`${at}.source is one of ${SOURCES.join(", ")}.`);
        out.source = c.source as Source;
      }
      if (c.where !== undefined) {
        if (!isObj(c.where) || !Object.keys(c.where).length || Object.keys(c.where).length > 5)
          throw new RuleError(`${at}.where is a map of 1 to 5 properties and their values, such as path: /pricing.`);
        for (const [k, x] of Object.entries(c.where)) {
          if (!PROP.test(k)) throw new RuleError(`${at}.where: ${k} is not a property name.`);
          if (!isScalar(x) || (typeof x === "string" && x.length > 200)) throw new RuleError(`${at}.where.${k} is a text, a number, true or false.`);
        }
        out.where = c.where as Record<string, Scalar>;
      }
      return out;
    }
    if ("identifier" in c) {
      if (keys.some((x) => x !== "identifier" && x !== "op")) throw new RuleError(`${at}: an identifier condition takes identifier and op.`);
      if (!(ID_KINDS as readonly unknown[]).includes(c.identifier)) throw new RuleError(`${at}.identifier is email, phone or user_id.`);
      if (c.op !== "exists" && c.op !== "missing") throw new RuleError(`${at}.op is exists or missing.`);
      return { identifier: c.identifier as IdKind, op: c.op };
    }
    throw new RuleError(`${at} is a condition: all, any, trait, event or identifier.`);
  };
  return walk(v, "rules", 0);
}

const DAY = 86_400_000;
const isoDay = (t: number) => new Date(t).toISOString().slice(0, 10);

/** The canonical text of a trait value, as stored in traits.value. */
export function traitText(v: Scalar): string {
  return typeof v === "string" ? v : String(v);
}

/**
 * The condition as SQL over `profiles p`, with its arguments. `now` fixes the time for every period in it, so one
 * count sees one moment. Types come from the file; a trait no longer in it is compared as text.
 */
export function compile(c: Condition, now: number, types: (key: string) => TraitType = () => "string"): { sql: string; args: SQLInputValue[] } {
  const args: SQLInputValue[] = [];
  const nowIso = new Date(now).toISOString();
  const today = isoDay(now);
  const walk = (c: Condition): string => {
    if ("all" in c) return c.all.length ? `(${c.all.map(walk).join(" AND ")})` : "1";
    if ("any" in c) return c.any.length ? `(${c.any.map(walk).join(" OR ")})` : "0";
    if ("identifier" in c) {
      args.push(c.identifier);
      return `${c.op === "missing" ? "NOT " : ""}EXISTS (SELECT 1 FROM identifiers i WHERE i.profile = p.id AND i.kind = ?)`;
    }
    if ("trait" in c) {
      const has = (cond: string, ...a: SQLInputValue[]) => {
        args.push(c.trait, ...a);
        return `EXISTS (SELECT 1 FROM traits t WHERE t.profile = p.id AND t.key = ?${cond ? ` AND ${cond}` : ""})`;
      };
      const type = types(c.trait);
      const v = c.value as Scalar;
      const eq = () => (type === "number" ? has("t.num = ?", v as number) : has("t.folded = ?", fold(traitText(v))));
      switch (c.op) {
        case "exists":
          return has("");
        case "missing":
          return `NOT ${has("")}`;
        case "is":
          return type === "date" ? has("substr(t.value, 1, 10) = ?", v as string) : eq();
        case "is_not":
          return `NOT ${eq()}`;
        case "in":
        case "not_in": {
          const values = (c.value as string[]).map((x) => fold(x));
          const sql = has(`t.folded IN (${values.map(() => "?").join(", ")})`, ...values);
          return c.op === "in" ? sql : `NOT ${sql}`;
        }
        case "contains":
          return has("instr(t.folded, ?) > 0", fold(String(v)));
        case "gt":
          return has("t.num > ?", v as number);
        case "gte":
          return has("t.num >= ?", v as number);
        case "lt":
          return has("t.num < ?", v as number);
        case "lte":
          return has("t.num <= ?", v as number);
        case "before":
          return has("substr(t.value, 1, 10) < ?", v as string);
        case "after":
          return has("substr(t.value, 1, 10) > ?", v as string);
        case "within_last":
          return has("substr(t.value, 1, 10) BETWEEN ? AND ?", isoDay(now - c.days! * DAY), today);
        case "within_next":
          return has("substr(t.value, 1, 10) BETWEEN ? AND ?", today, isoDay(now + c.days! * DAY));
      }
    }
    // An event condition. With a period, only events from its start until now count.
    const where = ["e.profile = p.id", "e.type = ?"];
    const a: SQLInputValue[] = [c.event];
    if (c.days) (where.push("e.at >= ?", "e.at <= ?"), a.push(new Date(now - c.days * DAY).toISOString(), nowIso));
    if (c.source) (where.push("e.source = ?"), a.push(c.source));
    for (const [k, v] of Object.entries(c.where ?? {})) {
      where.push(`json_extract(e.props, ?) = ?`);
      a.push(`$.${k}`, typeof v === "boolean" ? (v ? 1 : 0) : v);
    }
    const from = `FROM events e WHERE ${where.join(" AND ")}`;
    const n = c.op === "none" ? 0 : (c.count ?? 1);
    args.push(...a);
    if (c.op === "none" || (n === 0 && c.op !== "at_least")) return `NOT EXISTS (SELECT 1 ${from})`;
    if (c.op === "at_least") {
      if (n === 1) return `EXISTS (SELECT 1 ${from})`;
      args.push(n, n);
      return `(SELECT COUNT(*) FROM (SELECT 1 ${from} LIMIT ?)) >= ?`;
    }
    // Counting stops one past the number, so a person with thousands of events costs no more than one with n + 1.
    args.push(n + 1, n);
    return `(SELECT COUNT(*) FROM (SELECT 1 ${from} LIMIT ?)) ${c.op === "at_most" ? "<=" : "="} ?`;
  };
  const sql = walk(c);
  return { sql, args };
}

/** Whether a rule tree has a period, so that its members change as days pass without anyone doing anything. */
export function hasPeriod(c: Condition): boolean {
  if ("all" in c) return c.all.some(hasPeriod);
  if ("any" in c) return c.any.some(hasPeriod);
  if ("event" in c) return !!c.days;
  if ("trait" in c) return c.op === "within_last" || c.op === "within_next";
  return false;
}
