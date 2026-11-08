import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { createAuth, oidcFromEnv, readSecretsKey } from "@openasy/auth";
import { createApp, createMetricsHandler } from "./app.ts";
import { createAudience } from "./audience.ts";
import { watchConfig } from "./config.ts";
import { openDb } from "./db.ts";
import { createDeletions } from "./deletions.ts";
import { createImports } from "./imports.ts";
import { createLinks } from "./links.ts";
import { log } from "./log.ts";
import { parseProducts } from "./products.ts";
import { createPull } from "./pull.ts";
import { createSegments } from "./segments.ts";

const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
const port = Number(process.env.PORT ?? 8080);
const dbPath = process.env.AUDIENCE_DB ?? "/data/audience.db";
const configPath = process.env.AUDIENCE_CONFIG?.trim() || "/config/audience.yaml";
const webDir = new URL("../dist/web", import.meta.url).pathname;
const docsDir = new URL("../dist/docs", import.meta.url).pathname;
const openapi = JSON.parse(readFileSync(new URL("../openapi.json", import.meta.url), "utf8")) as Record<string, unknown>;
const headless = process.env.AUDIENCE_HEADLESS === "true";
// Set it to keep /metrics off the port that is published or behind an ingress (ADR 0026).
const metricsPort = process.env.AUDIENCE_METRICS_PORT ? Number(process.env.AUDIENCE_METRICS_PORT) : undefined;

const db = openDb(dbPath);
// The address people open Audience at, behind the TLS proxy (ADR 0026). Cookies, passkeys and OIDC redirects use it.
const publicUrl = (process.env.AUDIENCE_PUBLIC_URL ?? `http://localhost:${port}`).replace(/\/$/, "");
const secretsKeyFile = process.env.AUDIENCE_SECRETS_KEY_FILE ?? "/run/secrets/openasy-kek";
const auth = createAuth({
  db,
  product: "audience",
  productName: "OpenAsy Audience",
  origin: publicUrl,
  trustedOrigins: publicUrl.startsWith("http://localhost:") ? [publicUrl.replace("localhost", "127.0.0.1")] : [],
  passwords: process.env.AUDIENCE_PASSWORD_SIGN_IN !== "false",
  oidc: oidcFromEnv(process.env, "AUDIENCE_"),
  secretsKey: readSecretsKey(secretsKeyFile),
  // Audit log (ADR 0013): every sign-in, failure and change to members and tokens.
  onEvent: (event) => log(event.type === "sign-in-failed" ? "warn" : "info", "auth", { event }),
});
const products = parseProducts(process.env.OPENASY_PRODUCTS);
if (products.invalid.length) log("warn", "OPENASY_PRODUCTS: left out entries that are not id=https://address", { entries: products.invalid });

let file: ReturnType<typeof watchConfig> | undefined;
const audience = createAudience(db, { fileState: () => file?.state ?? null });
const segments = createSegments(audience);
const imports = createImports(audience);
const links = createLinks({ env: process.env, products: products.products });
const deletions = createDeletions(audience, links);
const pull = createPull(audience, links);
// Matching, traits and the linked products come from the file and only from it; a file with a mistake keeps the last
// good one in place.
file = watchConfig(
  configPath,
  (config) => {
    audience.setConfig(config);
    links.setLinks(config.links);
  },
  {
    onChange: (state) =>
      state.error
        ? log("warn", "audience file not applied: the last good version stays until it is fixed", { file: state.path, error: state.error })
        : log("info", "audience file applied", { file: state.path, traits: state.traits, sources: state.sources }),
  },
);
for (const l of links.state())
  if (l.tokenVariable && !l.tokenSet) log("warn", "a linked product's token is not set", { product: l.id, variable: l.tokenVariable });

const server = createServer(
  createApp({
    db,
    audience,
    segments,
    imports,
    deletions,
    links,
    pull,
    version,
    auth,
    webDir: !headless && existsSync(webDir) ? webDir : undefined,
    docsDir: existsSync(docsDir) ? docsDir : undefined,
    openapi,
    serveMetrics: metricsPort === undefined,
    products: products.products,
  }),
);
const metricsServer = metricsPort !== undefined ? createServer(createMetricsHandler({ audience, segments, deletions, pull }, version)) : undefined;
metricsServer?.listen(metricsPort, () => log("info", "metrics on their own port", { port: metricsPort }));

server.listen(port, () => log("info", "audience started", { version, port, db: dbPath, config: configPath, headless }));
if (!publicUrl.startsWith("https://") && !/^http:\/\/(localhost|127\.0\.0\.1)(:|$)/.test(publicUrl)) {
  log("warn", "AUDIENCE_PUBLIC_URL is not https: browsers will not keep secure cookies or allow passkeys. Put Audience behind TLS (ADR 0026)", {
    url: publicUrl,
  });
}
if (auth.secretsInClear)
  log("warn", "no secrets key: TOTP secrets are stored unencrypted. Mount a 32-byte key (openssl rand -hex 32)", { file: secretsKeyFile });
const setup = auth.setupLink();
// No default password (ADR 0013): the first person to open this link becomes the owner.
if (setup) log("info", "no owner yet: open this link once to create the owner account", { url: setup });

// Segments are counted in full at start and then every recount minutes (or once a night), for rules with a period.
let lastRecount = 0;
let lastPurge = "";
function housekeeping() {
  const now = new Date();
  const every = audience.config().recountMinutes;
  const due = every >= 1440 ? now.getHours() === 3 && now.getTime() - lastRecount > 3_600_000 : now.getTime() - lastRecount >= every * 60_000;
  if (!lastRecount || due) {
    const started = performance.now();
    const changes = segments.recount();
    lastRecount = now.getTime();
    log("info", "segments counted", { segments: segments.count(), changes, ms: Math.round(performance.now() - started) });
  }
  const day = now.toISOString().slice(0, 10);
  if (day !== lastPurge) {
    lastPurge = day;
    const events = audience.purge();
    segments.purge();
    if (events) log("info", "old events deleted", { events, keepDays: audience.config().keepDays });
  }
}
housekeeping();
void pull.tick();
void deletions.tick();
const timers: NodeJS.Timeout[] = [
  setInterval(() => auth.purge(), 5 * 60_000),
  setInterval(housekeeping, 60_000),
  setInterval(() => void pull.tick(), 30_000),
  setInterval(() => void deletions.tick(), 60_000),
];

function shutdown(signal: string) {
  log("info", "shutting down", { signal });
  for (const t of timers) clearInterval(t);
  file?.stop();
  metricsServer?.close();
  server.close(() => {
    db.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
