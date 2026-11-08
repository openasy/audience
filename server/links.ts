// Calls to the linked OpenAsy products, over their public APIs with the tokens the file names (ADR 0014, 0023). The
// address is the file's url, or the product's entry in OPENASY_PRODUCTS; the token is read from the environment
// variable the file names, never from the file itself. Calls give up after 10 seconds and never follow a redirect,
// which could take the token elsewhere.
import type { Link, LinkedProduct } from "./config.ts";
import type { ProductLink } from "./products.ts";

export class LinkError extends Error {
  /** The product's HTTP status, or null when it could not be reached. */
  readonly status: number | null;
  /** True when trying again will not help until someone changes something: a refused token, a wrong address. */
  readonly permanent: boolean;
  constructor(message: string, status: number | null, permanent: boolean) {
    super(message);
    this.status = status;
    this.permanent = permanent;
  }
}

export interface Linked {
  id: LinkedProduct;
  url: string | null;
  /** The variable the token is read from, and whether it is set. */
  tokenVariable: string | null;
  tokenSet: boolean;
  link: Link;
}

const NAMES: Record<LinkedProduct, string> = { analytics: "Analytics", consent: "Consent", forms: "Forms", crm: "CRM", messages: "Messages" };

export interface Client {
  id: LinkedProduct;
  call(method: string, path: string, query?: Record<string, string>, body?: unknown): Promise<{ status: number; body: unknown }>;
}

export function createLinks({
  env,
  products,
  fetch: http = fetch,
}: {
  env: Record<string, string | undefined>;
  products: ProductLink[];
  fetch?: typeof fetch;
}) {
  let links: Link[] = [];

  const urlOf = (l: Link) => l.url ?? products.find((p) => p.id === l.id)?.url ?? null;

  function state(): Linked[] {
    return links.map((l) => ({ id: l.id, url: urlOf(l), tokenVariable: l.token, tokenSet: !!(l.token && env[l.token]), link: l }));
  }

  /** A client for a product, or a LinkError that says what is missing. */
  function client(id: LinkedProduct): Client {
    const l = links.find((x) => x.id === id);
    const name = NAMES[id];
    if (!l) throw new LinkError(`${name} is not linked in audience.yaml.`, null, true);
    const base = urlOf(l);
    if (!base) throw new LinkError(`${name} has no address: set sources.${id}.url in audience.yaml, or ${id} in OPENASY_PRODUCTS.`, null, true);
    const token = l.token ? env[l.token] : undefined;
    if (!token) throw new LinkError(l.token ? `${l.token} is not set, so Audience has no token for ${name}.` : `sources.${id} has no token.`, null, true);
    return {
      id,
      async call(method, path, query, body) {
        const url = new URL(base + path);
        for (const [k, v] of Object.entries(query ?? {})) url.searchParams.set(k, v);
        let res: Response;
        try {
          res = await http(url, {
            method,
            headers: {
              authorization: `Bearer ${token}`,
              accept: "application/json",
              "user-agent": "openasy-audience",
              ...(body !== undefined && { "content-type": "application/json" }),
            },
            ...(body !== undefined && { body: JSON.stringify(body) }),
            redirect: "error",
            signal: AbortSignal.timeout(10_000),
          });
        } catch (err) {
          const e = err as Error;
          throw new LinkError(
            e.name === "TimeoutError"
              ? `${name} did not answer within 10 seconds.`
              : `${name} could not be reached: ${String((e.cause as Error)?.message ?? e.message)}`,
            null,
            false,
          );
        }
        const text = await res.text();
        let parsed: unknown = null;
        try {
          parsed = text ? JSON.parse(text) : null;
        } catch {
          // not JSON; the status says enough
        }
        if (res.ok || res.status === 404) return { status: res.status, body: parsed };
        const detail = typeof (parsed as { detail?: unknown } | null)?.detail === "string" ? `: ${(parsed as { detail: string }).detail}` : ".";
        if (res.status === 401) throw new LinkError(`${name} refused the token: make a new one under Settings, API tokens in ${name}.`, 401, true);
        if (res.status === 403) throw new LinkError(`The token may not do this in ${name}${detail}`, 403, true);
        throw new LinkError(`${name} answered ${res.status}${detail}`, res.status, res.status < 500 && res.status !== 429);
      },
    };
  }

  return {
    setLinks(l: Link[]) {
      links = l;
    },
    state,
    client,
    has: (id: LinkedProduct) => links.some((l) => l.id === id),
    link: (id: LinkedProduct) => links.find((l) => l.id === id) ?? null,
  };
}

export type Links = ReturnType<typeof createLinks>;

// ---------------------------------------------------------------- What the products answer

/** A visit as Analytics lists it (its openapi.json, Visit). */
export interface AnalyticsVisit {
  id: string;
  site: string;
  visitor: string;
  user: string | null;
  startedAt: string;
  lastAt: string;
  entry: string | null;
  source: string | null;
  referrer: string | null;
  utm: { source: string | null; medium: string | null; campaign: string | null };
  device: string;
}

/** One thing a visit sent (its openapi.json, VisitEvent). */
export interface AnalyticsEvent {
  type: "pageview" | "leave" | "click" | "event" | "form";
  at: string;
  path: string | null;
  title: string | null;
  name: string | null;
  props: Record<string, unknown> | null;
  form: string | null;
  action: string | null;
}

/** Visits of a site, newest activity first. */
export async function analyticsVisits(c: Client, site: string, q: { user?: string; visitor?: string; cursor?: string }) {
  const r = await c.call("GET", "/api/v1/visits", {
    site,
    limit: "200",
    ...(q.user && { user: q.user }),
    ...(q.visitor && { visitor: q.visitor }),
    ...(q.cursor && { cursor: q.cursor }),
  });
  if (r.status === 404) throw new LinkError(`Analytics has no site ${site}: check sources.analytics.sites in audience.yaml.`, 404, true);
  return r.body as { visits: AnalyticsVisit[]; nextCursor?: string };
}

/** Every visitor id Analytics has for a user id of the site. */
export async function analyticsVisitorsOf(c: Client, site: string, user: string): Promise<string[]> {
  const out = new Set<string>();
  let cursor: string | undefined;
  for (let page = 0; page < 100; page++) {
    const r = await analyticsVisits(c, site, { user, cursor });
    for (const v of r.visits) out.add(v.visitor);
    if (!r.nextCursor) break;
    cursor = r.nextCursor;
  }
  return [...out];
}

/** A person in Consent (its openapi.json, PersonSummary and Person). */
export interface ConsentPerson {
  id: string;
  emails: string[];
  phones: string[];
  ids: string[];
  standing?: Array<{ purpose: string; channel: string; status: string; allowed: boolean; version: number | null; at: string | null; source: string | null }>;
}

/** The people Consent keeps by exactly these identifiers; its search finds parts, so each hit is checked. */
export async function consentPeople(c: Client, who: { emails: string[]; phones: string[]; userIds: string[] }): Promise<ConsentPerson[]> {
  const found = new Map<string, ConsentPerson>();
  const look = async (value: string, has: (p: ConsentPerson) => boolean) => {
    const r = await c.call("GET", "/api/v1/people", { q: value, limit: "50" });
    for (const p of (r.body as { people?: ConsentPerson[] } | null)?.people ?? []) if (has(p)) found.set(p.id, p);
  };
  for (const e of who.emails) await look(e, (p) => p.emails.includes(e));
  for (const ph of who.phones) await look(ph, (p) => p.phones.includes(ph));
  for (const u of who.userIds) await look(u, (p) => p.ids.includes(u));
  return [...found.values()];
}
