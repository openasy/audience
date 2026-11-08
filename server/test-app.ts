// Starts the app on a random port for tests, with fake linked products when asked.
import { createServer, type RequestListener, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createAuth } from "@openasy/auth";
import { createApp, type AppOptions } from "./app.ts";
import { createAudience } from "./audience.ts";
import { parseConfig } from "./config.ts";
import { openDb } from "./db.ts";
import { createDeletions } from "./deletions.ts";
import { fakeAnalytics, fakeConsent, fakeErasures } from "./fakes.ts";
import { createImports } from "./imports.ts";
import { createLinks } from "./links.ts";
import { createPull } from "./pull.ts";
import { createSegments } from "./segments.ts";

export const ADMIN_TOKEN = "test-admin-token";

/** The file the tests start with; {sources} is replaced with the fakes' addresses, or nothing. */
export const FILE = `
match_by: [email, phone, user_id]
phone_country: TR
traits:
  plan: { values: [Free, Pro, Business] }
  city: {}
  sector: { from: [crm, forms, import, api] }
  seats: { type: number }
  trial: { type: boolean }
  renewal_date: { type: date }
{sources}
`;

/** A clock the test moves by hand. */
export function fakeClock(start = Date.parse("2026-11-08T09:00:00Z")) {
  let t = start;
  return Object.assign(() => t, { advance: (ms: number) => void (t += ms), set: (iso: string) => void (t = Date.parse(iso)) });
}

/** The core without HTTP: profiles, segments, imports, for tests of the rules. */
export function startCore(file = FILE.replace("{sources}", "")) {
  const db = openDb(":memory:");
  const clock = fakeClock();
  const audience = createAudience(db, { clock });
  const config = parseConfig(file);
  audience.setConfig(config);
  const segments = createSegments(audience);
  const imports = createImports(audience);
  return { db, clock, audience, segments, imports, config };
}

export async function startApp(opts: Partial<AppOptions> & { version?: string; file?: string; linked?: boolean } = {}) {
  const { file, linked = false, version = "0.1.0", ...rest } = opts;
  const analytics = linked ? await fakeAnalytics() : null;
  const consent = linked ? await fakeConsent() : null;
  const crm = linked ? await fakeErasures() : null;
  const sources = linked
    ? `sources:
  analytics: { url: ${analytics!.url}, token: T_ANALYTICS, sites: [shop] }
  consent: { url: ${consent!.url}, token: T_CONSENT }
  crm: { url: ${crm!.url}, token: T_CRM }
  forms: true`
    : "";
  const env = { T_ANALYTICS: "analytics-token", T_CONSENT: "consent-token", T_CRM: "crm-token" };
  const core = startCore((file ?? FILE).replace("{sources}", sources));
  const links = createLinks({ env, products: [] });
  links.setLinks(core.config.links);
  const deletions = createDeletions(core.audience, links);
  const pull = createPull(core.audience, links);
  let handler: RequestListener = (_req, res) => res.writeHead(503).end();
  const server: Server = createServer((req, res) => handler(req, res));
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const base = `http://localhost:${(server.address() as AddressInfo).port}`;
  const auth = createAuth({ db: core.db, product: "audience", productName: "OpenAsy Audience", origin: base });
  handler = createApp({ ...core, links, deletions, pull, auth, version, adminToken: ADMIN_TOKEN, ...rest });
  const admin = (path: string, init: RequestInit = {}) =>
    fetch(base + path, { ...init, headers: { authorization: `Bearer ${ADMIN_TOKEN}`, "content-type": "application/json", ...init.headers } });
  const close = async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await Promise.all([analytics?.close(), consent?.close(), crm?.close()]);
  };
  return { ...core, links, deletions, pull, auth, base, admin, close, fakes: { analytics, consent, crm } };
}
