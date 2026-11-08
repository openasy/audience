// What the search window (Cmd+K) finds in Audience: people by part of a name, email, phone number or user id, and segments.
import type { SearchFn, SearchResult } from "@openasy/ui";
import { Filter, UserRound } from "lucide-react";
import type { Person, Segment } from "./api.ts";
import type { T } from "./i18n.ts";

type Call = <R>(path: string, init?: RequestInit) => Promise<R>;

export function search(call: Call, t: T): SearchFn {
  return async (q, signal) => {
    const [people, segments] = await Promise.all([
      q.length >= 2 ? call<{ people: Person[] }>(`/api/v1/people?${new URLSearchParams({ q, limit: "8" })}`, { signal }).catch(() => null) : null,
      call<{ segments: Segment[] }>("/api/v1/segments", { signal }).catch(() => null),
    ]);
    const found: SearchResult[] = (people?.people ?? []).map((p) => ({
      id: `person:${p.id}`,
      label: p.name ?? p.email ?? p.phone ?? p.userId ?? p.id,
      detail: [p.email, p.userId].filter(Boolean).join(" · "),
      kind: t("search.person"),
      icon: UserRound,
      href: `/people/${p.id}`,
    }));
    const named: SearchResult[] = (segments?.segments ?? [])
      .filter((s) => s.name.toLocaleLowerCase().includes(q.toLocaleLowerCase()))
      .slice(0, 6)
      .map((s) => ({
        id: `segment:${s.id}`,
        label: s.name,
        detail: t("search.segmentDetail", { count: s.size }),
        kind: t("search.segment"),
        icon: Filter,
        href: `/segments/${s.id}`,
      }));
    return [...found, ...named];
  };
}
