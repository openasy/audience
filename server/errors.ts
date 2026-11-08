// The errors the API answers with, as RFC 9457 Problem Details (ADR 0024), and the paging every list shares.

export type ProblemCode =
  "invalid-json" | "invalid-body" | "not-found" | "conflict" | "not-configured" | "payload-too-large" | "upstream-error" | "internal-error";

export class AudienceError extends Error {
  readonly status: number;
  readonly code: ProblemCode;
  constructor(status: number, code: ProblemCode, detail: string) {
    super(detail);
    this.status = status;
    this.code = code;
  }
}

export const bad = (detail: string) => new AudienceError(422, "invalid-body", detail);
export const notFound = (what: string) => new AudienceError(404, "not-found", `${what} does not exist.`);
export function fail(detail: string): never {
  throw bad(detail);
}

export interface Page<T> {
  items: T[];
  /** Opaque; pass it back as `cursor` for the next page. Absent on the last page (ADR 0024). */
  nextCursor?: string;
}

export const encodeCursor = (offset: number) => Buffer.from(JSON.stringify({ o: offset })).toString("base64url");
export function decodeCursor(cursor: string | undefined | null): number {
  if (!cursor) return 0;
  try {
    const o = (JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as { o?: unknown }).o;
    if (typeof o === "number" && Number.isInteger(o) && o >= 0) return o;
  } catch {
    // fall through
  }
  throw bad("cursor is not one this API returned.");
}

/** A cursor that names the last id of the page before, for lists walked in id order. */
export const encodeAfter = (id: string) => Buffer.from(JSON.stringify({ a: id })).toString("base64url");
export function decodeAfter(cursor: string | undefined | null): string {
  if (!cursor) return "";
  try {
    const a = (JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as { a?: unknown }).a;
    if (typeof a === "string") return a;
  } catch {
    // fall through
  }
  throw bad("cursor is not one this API returned.");
}

export function parseLimit(value: string | null, max = 500, fallback = 100): number {
  if (value === null) return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > max) throw bad(`limit must be between 1 and ${max}.`);
  return n;
}

export const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
export const DAY = 86_400_000;
