// What the pages share: data loading with the session, formatting and the names of sources.
import { useAuth } from "@openasy/auth/react";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { api, MfaSetupRequired, Unauthorized, type Source, type TraitValue } from "./api.ts";
import type { Key, T } from "./i18n.ts";

/** Data loading with the session; when it ends, the sign-in screen comes back. */
export function useApi() {
  const { expired, refresh } = useAuth();
  return useCallback(
    async <R,>(path: string, init?: RequestInit): Promise<R> => {
      try {
        return await api<R>(path, init);
      } catch (err) {
        if (err instanceof Unauthorized) expired();
        if (err instanceof MfaSetupRequired) void refresh();
        throw err;
      }
    },
    [expired, refresh],
  );
}
export type Call = ReturnType<typeof useApi>;

/** Loads a path, again whenever `key` changes; undefined while loading, null when it failed. */
export function useLoad<R>(call: Call, path: string | null, key: unknown = 0) {
  const [data, setData] = useState<R | null>();
  useEffect(() => {
    if (!path) return;
    let live = true;
    setData(undefined);
    void call<R>(path).then(
      (d) => live && setData(d),
      () => live && setData(null),
    );
    return () => void (live = false);
  }, [call, path, key]);
  return data;
}

export function Code({ children, label }: { children: ReactNode; label?: string }) {
  return (
    <pre aria-label={label} className="m-0 overflow-x-auto rounded-md bg-canvas px-2.5 py-2 font-mono text-2xs leading-relaxed text-fg">
      {children}
    </pre>
  );
}

/** A status line under a page header, for what the last action did. */
export function Notice({ children, tone = "success" }: { children: ReactNode; tone?: "success" | "danger" }) {
  return (
    <div role="status" className={`mb-2.5 rounded-md px-3 py-2 text-sm text-fg ${tone === "success" ? "bg-success-soft" : "bg-danger-soft"}`}>
      {children}
    </div>
  );
}

export const fmt = (n: number) => n.toLocaleString();
export const time = (iso: string | null) => (iso ? new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "–");
export const shortDay = (d: string) => new Date(`${d}T00:00:00Z`).toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" });
export const traitText = (v: TraitValue | undefined) => (v === undefined ? "–" : String(v));

export const SOURCE_TONE: Record<Source, "neutral" | "info" | "success" | "warning"> = {
  analytics: "info",
  forms: "success",
  crm: "warning",
  messages: "neutral",
  import: "neutral",
  api: "neutral",
};

export const sourceName = (t: T, s: string) => t(`source.${s}` as Key);

/** Saves text as a file in the browser. */
export function download(name: string, text: string, type = "application/json") {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name;
  a.click();
  URL.revokeObjectURL(a.href);
}
