// Prometheus text exposition, written by hand: a few lines, no client library needed.
const requests = new Map<string, number>();

export function countRequest(method: string, route: string, status: number) {
  const key = `method="${method}",route="${route}",status="${status}"`;
  requests.set(key, (requests.get(key) ?? 0) + 1);
}

export interface Gauges {
  profiles: number;
  events: number;
  segments: number;
  /** Deletions with a linked product's part in each state: pending, waiting, done, failed. */
  deletions: Partial<Record<string, number>>;
  /** Analytics sites whose last read failed. */
  sourceErrors: number;
  /** 1 when the file on disk could not be applied and an older version is in use. */
  fileError: boolean;
}

export function renderMetrics(version: string, g: Gauges): string {
  const lines = [
    "# HELP openasy_build_info Build information.",
    "# TYPE openasy_build_info gauge",
    `openasy_build_info{product="audience",version="${version}"} 1`,
    "# HELP openasy_http_requests_total HTTP requests handled.",
    "# TYPE openasy_http_requests_total counter",
    ...[...requests].map(([labels, n]) => `openasy_http_requests_total{${labels}} ${n}`),
    "# HELP openasy_audience_profiles Profiles, one per person.",
    "# TYPE openasy_audience_profiles gauge",
    `openasy_audience_profiles ${g.profiles}`,
    "# HELP openasy_audience_events Events on the timelines.",
    "# TYPE openasy_audience_events gauge",
    `openasy_audience_events ${g.events}`,
    "# HELP openasy_audience_segments Segments.",
    "# TYPE openasy_audience_segments gauge",
    `openasy_audience_segments ${g.segments}`,
    "# HELP openasy_audience_deletion_tasks Deletions with a linked product's part in each state.",
    "# TYPE openasy_audience_deletion_tasks gauge",
    ...["pending", "waiting", "done", "failed"].map((s) => `openasy_audience_deletion_tasks{state="${s}"} ${g.deletions[s] ?? 0}`),
    "# HELP openasy_audience_source_errors Linked sources whose last read failed.",
    "# TYPE openasy_audience_source_errors gauge",
    `openasy_audience_source_errors ${g.sourceErrors}`,
    "# HELP openasy_audience_config_error 1 when the file could not be applied and its last good version is in use.",
    "# TYPE openasy_audience_config_error gauge",
    `openasy_audience_config_error ${g.fileError ? 1 : 0}`,
    "# HELP process_uptime_seconds Seconds since the process started.",
    "# TYPE process_uptime_seconds gauge",
    `process_uptime_seconds ${process.uptime().toFixed(0)}`,
  ];
  return lines.join("\n") + "\n";
}
