// The UI is an ordinary client of the public API (ADR 0014, 0018). Types follow openapi.json.

/** Another OpenAsy product of this install, from OPENASY_PRODUCTS. */
export interface ProductLink {
  id: string;
  url: string;
}

export type Source = "analytics" | "forms" | "crm" | "messages" | "import" | "api";
export const SOURCES: Source[] = ["analytics", "forms", "crm", "messages", "import", "api"];
export type TraitValue = string | number | boolean;

export type ConfigFile = { path: string; appliedAt: string | null; traits: number; sources: number; error: string | null } | null;

export interface LinkedSource {
  id: "analytics" | "consent" | "forms" | "crm" | "messages";
  url: string | null;
  token: { variable: string; set: boolean } | null;
  delete: boolean;
  pull?: number;
  sites?: Array<{ site: string; lastAt: string | null; lastOkAt: string | null; error: string | null; events: number }>;
  events7d: number;
}

export interface Trait {
  key: string;
  type: "string" | "number" | "boolean" | "date";
  values: string[] | null;
  from: Source[] | null;
}

export interface Config {
  file: ConfigFile;
  text: string;
  matchBy: Array<"email" | "phone" | "user_id">;
  phoneCountry: string;
  traits: Trait[];
  keepDays: number;
  recountMinutes: number;
  sources: LinkedSource[];
}

export interface Summary {
  profiles: number;
  new30d: number;
  trend: number[];
  knownBy: { email: number; phone: number; userId: number };
  mergedThisMonth: number;
  eventsToday: number;
  events: Array<{ day: string; sources: Record<Source, number> }>;
  firstSources: Array<{ source: Source; profiles: number }>;
  file: ConfigFile;
  segments: Array<{ id: string; name: string; size: number; change30d: number; usedBy: string[] }>;
  deletions: Partial<Record<"pending" | "waiting" | "done" | "failed", number>>;
  sources: LinkedSource[];
}

export interface Person {
  id: string;
  name: string | null;
  email: string | null;
  phone: string | null;
  userId: string | null;
  emails: string[];
  phones: string[];
  traits: Record<string, TraitValue>;
  sources: Source[];
  firstSource: Source;
  createdAt: string;
  lastAt: string | null;
}

export interface TimelineEvent {
  id: number;
  source: Source;
  type: string;
  at: string;
  text: string | null;
  properties: Record<string, unknown> | null;
}

export interface PersonDetail extends Person {
  mergedFrom: string[];
  events: TimelineEvent[];
  nextCursor?: string;
  eventCount: number;
  segments: Array<{ id: string; name: string }>;
}

export interface ConsentOfPerson {
  linked: boolean;
  people: Array<{
    id: string;
    standing: Array<{ purpose: string; channel: string; status: string; allowed: boolean; version: number | null; at: string | null }>;
  }>;
  error: string | null;
}

export type Scalar = string | number | boolean;
export type Condition =
  | { all: Condition[] }
  | { any: Condition[] }
  | { trait: string; op: string; value?: Scalar | Scalar[]; days?: number }
  | { event: string; op: "at_least" | "at_most" | "exactly" | "none"; count?: number; days?: number | null; source?: Source; where?: Record<string, Scalar> }
  | { identifier: "email" | "phone" | "user_id"; op: "exists" | "missing" };

export interface Segment {
  id: string;
  name: string;
  description: string | null;
  rules: Condition;
  owner: string;
  createdAt: string;
  updatedAt: string;
  size: number;
  change30d: number;
  countedAt: string | null;
  period: boolean;
  usedBy: string[];
}

export interface SegmentDetail extends Segment {
  history: Array<{ day: string; size: number }>;
  readers: Array<{ actor: string; lastAt: string; reads: number }>;
}

export interface Member {
  id: string;
  name: string | null;
  email: string | null;
  phone: string | null;
  userId: string | null;
  traits: Record<string, TraitValue>;
}

export interface Preview {
  size: number;
  sample: Member[];
  ms: number;
}

export interface Import {
  id: string;
  file: string;
  actor: string;
  uploadedAt: string;
  rows: number;
  state: "uploaded" | "done" | "discarded";
  columns: Array<{ name: string; sample: string; suggested: string }>;
  mapping: Record<string, string> | null;
  created: number | null;
  matched: number | null;
  skipped: number | null;
  doneAt: string | null;
}

export interface ImportPreview {
  rows: number;
  created: number;
  matched: number;
  skipped: number;
  problems: Array<{ row: number; reason: string }>;
}

export interface Deletion {
  id: string;
  reference: string;
  at: string;
  actor: string;
  profiles: number;
  events: number;
  state: "pending" | "waiting" | "done" | "failed";
  products: Array<{
    product: string;
    state: "pending" | "waiting" | "done" | "failed";
    attempts: number;
    detail: string | null;
    deleted: number | null;
    doneAt: string | null;
    nextAt: string | null;
  }>;
}

export class Unauthorized extends Error {}
/** The signed-in owner or admin has no second factor yet; the sign-in gate asks for one. */
export class MfaSetupRequired extends Error {}
export class ApiError extends Error {}

// The session is an HttpOnly cookie set by sign-in (@openasy/auth); the browser sends it, nothing is stored here.
export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(path, {
    ...init,
    credentials: "same-origin",
    headers: { ...(init.body && typeof init.body === "string" ? { "content-type": "application/json" } : {}), ...init.headers },
  });
  if (!res.ok) {
    const problem = (await res.json().catch(() => ({}))) as { code?: string; detail?: string };
    if (res.status === 401) throw new Unauthorized(problem.detail);
    if (problem.code === "mfa-setup-required") throw new MfaSetupRequired(problem.detail);
    throw new ApiError(problem.detail ?? `${path}: ${res.status}`);
  }
  return (res.status === 204 ? undefined : await res.json()) as T;
}
