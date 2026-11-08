// How people are matched, the traits kept about them, the products Audience is linked to, how long events are kept
// and how often segments are counted, from one YAML file (AUDIENCE_CONFIG). As with every OpenAsy product set in a
// file, the file is the only way in: no screen or API route changes it. It is applied whole or not at all, read again
// within a minute of a change, and a file with a mistake leaves the last good version in place.
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { parse } from "yaml";
import { COUNTRIES } from "./identity.ts";

/** The ways a person is known. Nothing else, such as a device fingerprint or an IP address, ever matches two records. */
export const ID_KINDS = ["email", "phone", "user_id"] as const;
export type IdKind = (typeof ID_KINDS)[number];

/** Where events and traits come from: the linked products, Audience's own CSV imports, and the API. */
export const SOURCES = ["analytics", "forms", "crm", "messages", "import", "api"] as const;
export type Source = (typeof SOURCES)[number];

/** The OpenAsy products Audience links to. Consent sends no events; Audience reads what people agreed to there. */
export const PRODUCTS = ["analytics", "consent", "forms", "crm", "messages"] as const;
export type LinkedProduct = (typeof PRODUCTS)[number];

export const TRAIT_TYPES = ["string", "number", "boolean", "date"] as const;
export type TraitType = (typeof TRAIT_TYPES)[number];

export interface Trait {
  /** The trait's name in the API, the file and the rules of segments. */
  key: string;
  type: TraitType;
  /** For a string trait, the only values it takes; any value when null. */
  values: string[] | null;
  /** The sources that may set it; any source when null. */
  from: Source[] | null;
}

export interface Link {
  id: LinkedProduct;
  /** Where Audience calls the product; from OPENASY_PRODUCTS when not set in the file. */
  url: string | null;
  /** The environment variable that holds the product's API token, never the token itself. Null when only events come in. */
  token: string | null;
  /** A person deleted on request here is deleted there too. */
  delete: boolean;
  /** Analytics only: the sites whose identified visitors become profiles. */
  sites: string[];
  /** Analytics only: minutes between two reads of its visits. */
  pull: number;
}

export interface Config {
  /** The identifiers that make two records one person. */
  matchBy: IdKind[];
  /** Phone numbers written without a country code are taken to be in this country. */
  phoneCountry: keyof typeof COUNTRIES;
  traits: Trait[];
  links: Link[];
  /** Events older than this are deleted; the profile stays. */
  keepDays: number;
  /** Minutes between two full counts of every segment, or 1440 for once a night. */
  recountMinutes: number;
  /** The text of the file as applied, for the Settings page. */
  text: string;
}

const TOP_KEYS = ["match_by", "phone_country", "traits", "sources", "events", "segments"];
const TRAIT_KEYS = ["type", "values", "from"];
const LINK_KEYS: Record<LinkedProduct, string[]> = {
  analytics: ["url", "token", "sites", "pull", "delete"],
  consent: ["url", "token", "delete"],
  forms: ["url", "token", "delete"],
  crm: ["url", "token", "delete"],
  messages: ["url", "token", "delete"],
};
const TRAIT_KEY = /^[a-z][a-z0-9_]{0,39}$/;
const ENV = /^[A-Z][A-Z0-9_]{0,63}$/;
const SITE = /^[^\s]{1,128}$/;
const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const list = (v: unknown) => (Array.isArray(v) ? v : [v]);

function minutes(v: unknown, at: string, nightly: boolean): number {
  if (nightly && v === "nightly") return 1440;
  const m = typeof v === "number" ? [String(v), String(v), "m"] : typeof v === "string" ? /^(\d+)\s*(m|h)?$/.exec(v.trim()) : null;
  const n = m ? Number(m[1]) * (m[2] === "h" ? 60 : 1) : NaN;
  if (!Number.isInteger(n) || n < 1 || n > 1440) throw new Error(`${at} is 1 minute to 24 hours, such as 15m or 1h${nightly ? ", or nightly" : ""}.`);
  return n;
}

/** 25mo, 24 months, 2y and 400d are all fine; at least 30 days, at most 10 years. */
function keep(v: unknown): number {
  const m = typeof v === "string" ? /^(\d+)\s*(d|days?|mo|months?|y|years?)$/.exec(v.trim()) : null;
  const n = m ? Number(m[1]) : NaN;
  const days = !m ? NaN : m[2]!.startsWith("d") ? n : m[2]!.startsWith("m") ? Math.round(n * 30.44) : n * 365;
  if (!Number.isInteger(days) || days < 30 || days > 3650) throw new Error("events.keep is 30 days to 10 years, such as 25mo, 2y or 400d.");
  return days;
}

function traitOf(key: string, v: unknown): Trait {
  if (!TRAIT_KEY.test(key)) throw new Error(`traits.${key}: a trait's name is up to 40 lowercase letters, digits and _, starting with a letter.`);
  if (["email", "phone", "user_id", "name", "id"].includes(key))
    throw new Error(`traits.${key}: ${key} is part of every profile already; traits are what else you keep, such as plan or city.`);
  const t = v ?? {};
  if (!isObj(t)) throw new Error(`traits.${key} is a map with type, values and from, or empty: {}.`);
  const extra = Object.keys(t).filter((k) => !TRAIT_KEYS.includes(k));
  if (extra.length) throw new Error(`traits.${key}: unknown ${extra.join(", ")}; a trait takes ${TRAIT_KEYS.join(", ")}.`);
  const type = (t.type ?? "string") as TraitType;
  if (!(TRAIT_TYPES as readonly unknown[]).includes(type)) throw new Error(`traits.${key}.type is ${TRAIT_TYPES.join(", ")}.`);
  let values: string[] | null = null;
  if (t.values !== undefined) {
    if (type !== "string") throw new Error(`traits.${key}.values is only for string traits.`);
    if (!Array.isArray(t.values) || !t.values.length || t.values.length > 200 || t.values.some((x) => typeof x !== "string" || !x.trim() || x.length > 200))
      throw new Error(`traits.${key}.values is a list of 1 to 200 texts.`);
    values = [...new Set((t.values as string[]).map((x) => x.trim()))];
  }
  let from: Source[] | null = null;
  if (t.from !== undefined) {
    const f = list(t.from);
    if (!f.length || f.some((x) => !(SOURCES as readonly unknown[]).includes(x)))
      throw new Error(`traits.${key}.from is one or more of ${SOURCES.join(", ")}.`);
    from = [...new Set(f as Source[])];
  }
  return { key, type, values, from };
}

function linkOf(id: string, v: unknown): Link {
  if (!(PRODUCTS as readonly string[]).includes(id)) throw new Error(`sources.${id}: Audience links to ${PRODUCTS.join(", ")}.`);
  const p = id as LinkedProduct;
  const needsToken = p === "analytics" || p === "consent";
  if (v === true && !needsToken) return { id: p, url: null, token: null, delete: false, sites: [], pull: 5 };
  if (!isObj(v))
    throw new Error(
      needsToken
        ? `sources.${id} is a map with at least token.`
        : `sources.${id} is true (its events come in) or a map with token, to delete people there too.`,
    );
  const extra = Object.keys(v).filter((k) => !LINK_KEYS[p].includes(k));
  if (extra.length) throw new Error(`sources.${id}: unknown ${extra.join(", ")}; it takes ${LINK_KEYS[p].join(", ")}.`);
  let url: string | null = null;
  if (v.url !== undefined) {
    const u = typeof v.url === "string" ? URL.parse(v.url.trim()) : null;
    if (!u || (u.protocol !== "https:" && u.protocol !== "http:") || u.search)
      throw new Error(`sources.${id}.url is the product's address, such as http://${id}:8080.`);
    url = u.origin + u.pathname.replace(/\/$/, "");
  }
  let token: string | null = null;
  if (v.token !== undefined) {
    if (typeof v.token !== "string" || !ENV.test(v.token))
      throw new Error(`sources.${id}.token is the name of an environment variable, such as AUDIENCE_${id.toUpperCase()}_TOKEN, never the token itself.`);
    token = v.token;
  } else if (needsToken) throw new Error(`sources.${id}.token is required: the environment variable that holds ${id}'s API token.`);
  if (v.delete !== undefined && typeof v.delete !== "boolean") throw new Error(`sources.${id}.delete is true or false.`);
  const del = v.delete ?? token !== null;
  if (del && !token) throw new Error(`sources.${id}.delete needs token: Audience calls ${id} with it to delete a person.`);
  let sites: string[] = [];
  let pull = 5;
  if (p === "analytics") {
    if (!Array.isArray(v.sites) || !v.sites.length || v.sites.length > 50 || v.sites.some((s) => typeof s !== "string" || !SITE.test(s)))
      throw new Error("sources.analytics.sites is a list of the sites, by their names in Analytics' file, whose identified visitors become profiles.");
    sites = [...new Set(v.sites as string[])];
    if (v.pull !== undefined) pull = minutes(v.pull, "sources.analytics.pull", false);
  }
  return { id: p, url, token, delete: del, sites, pull };
}

/** Reads the file's text. Throws with the entry and field at fault, so one message says what to fix. */
export function parseConfig(text: string): Config {
  let doc: unknown;
  try {
    doc = parse(text);
  } catch (err) {
    throw new Error(`Not valid YAML: ${(err as Error).message.split("\n")[0]}`);
  }
  doc ??= {};
  if (!isObj(doc)) throw new Error(`The file is a map of ${TOP_KEYS.join(", ")}.`);
  const extra = Object.keys(doc).filter((k) => !TOP_KEYS.includes(k));
  if (extra.length) throw new Error(`Unknown ${extra.join(", ")}; the file holds ${TOP_KEYS.join(", ")}.`);

  let matchBy: IdKind[] = [...ID_KINDS];
  if (doc.match_by !== undefined) {
    const m = list(doc.match_by);
    if (!m.length || m.some((x) => !(ID_KINDS as readonly unknown[]).includes(x)))
      throw new Error("match_by is one or more of email, phone and user_id. Nothing else matches people: no device fingerprints, no IP addresses.");
    matchBy = ID_KINDS.filter((k) => m.includes(k));
  }

  const country = doc.phone_country ?? "TR";
  if (typeof country !== "string" || !(country in COUNTRIES)) throw new Error(`phone_country is one of ${Object.keys(COUNTRIES).join(", ")}.`);

  const rawTraits = doc.traits ?? {};
  if (!isObj(rawTraits) || Object.keys(rawTraits).length > 100) throw new Error("traits is a map of up to 100 traits, such as plan: { values: [Free, Pro] }.");
  const traits = Object.entries(rawTraits).map(([k, v]) => traitOf(k, v));

  const rawSources = doc.sources ?? {};
  if (!isObj(rawSources)) throw new Error(`sources is a map of the linked products: ${PRODUCTS.join(", ")}.`);
  const links = Object.entries(rawSources)
    .filter(([, v]) => v !== false && v !== null)
    .map(([k, v]) => linkOf(k, v));

  let keepDays = 761;
  if (doc.events !== undefined && doc.events !== null) {
    if (!isObj(doc.events) || Object.keys(doc.events).some((k) => k !== "keep")) throw new Error("events is a map with keep, such as keep: 25mo.");
    if (doc.events.keep !== undefined) keepDays = keep(doc.events.keep);
  }
  let recountMinutes = 15;
  if (doc.segments !== undefined && doc.segments !== null) {
    if (!isObj(doc.segments) || Object.keys(doc.segments).some((k) => k !== "recount"))
      throw new Error("segments is a map with recount, such as recount: 15m.");
    if (doc.segments.recount !== undefined) recountMinutes = minutes(doc.segments.recount, "segments.recount", true);
  }
  return { matchBy, phoneCountry: country as keyof typeof COUNTRIES, traits, links, keepDays, recountMinutes, text };
}

export interface ConfigFileState {
  path: string;
  /** When the file was last read and applied, or null if it never was. */
  appliedAt: string | null;
  traits: number;
  sources: number;
  /** Why the file on disk is not what is applied; the last good version stays until it is fixed. */
  error: string | null;
}

/**
 * Reads the file now and whenever it changes (checked every `everyMs`, by size, time and content), and hands each new
 * version to `apply`. A file that cannot be read or applied leaves the last good version in place. `stop()` ends it.
 */
export function watchConfig(
  path: string,
  apply: (config: Config) => void,
  { everyMs = 60_000, onChange }: { everyMs?: number; onChange?: (state: ConfigFileState) => void } = {},
) {
  const state: ConfigFileState = { path, appliedAt: null, traits: 0, sources: 0, error: null };
  let seen = "";
  const read = () => {
    let body: string;
    let stamp: string;
    try {
      const st = statSync(path);
      body = readFileSync(path, "utf8");
      stamp = `${st.size}:${st.mtimeMs}:${createHash("sha256").update(body).digest("hex")}`;
    } catch (err) {
      const error = `Cannot read ${path}: ${(err as NodeJS.ErrnoException).code ?? (err as Error).message}`;
      if (state.error !== error) ((state.error = error), onChange?.(state));
      return;
    }
    if (stamp === seen) return;
    seen = stamp;
    try {
      const config = parseConfig(body);
      apply(config);
      Object.assign(state, { appliedAt: new Date().toISOString(), traits: config.traits.length, sources: config.links.length, error: null });
    } catch (err) {
      state.error = (err as Error).message;
    }
    onChange?.(state);
  };
  read();
  const timer = setInterval(read, everyMs);
  timer.unref();
  return { state, read, stop: () => clearInterval(timer) };
}
