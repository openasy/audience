// Imports, deletion requests, the linked products, the file as applied and the setup steps.
import {
  Badge,
  Button,
  Callout,
  DataTable,
  Dialog,
  EmptyState,
  PageHeader,
  Panel,
  SelectField,
  StatusBadge,
  TextField,
  useAgo,
  type Column,
} from "@openasy/ui";
import { useAuth } from "@openasy/auth/react";
import { FileCode, FileUp, RefreshCw, UserX } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { Config, Deletion, Import, ImportPreview, LinkedSource } from "./api.ts";
import { Code, fmt, Notice, time, useApi, useLoad, type Call } from "./common.tsx";
import { useT, type Key } from "./i18n.ts";

const NAMES: Record<string, string> = { audience: "Audience", analytics: "Analytics", consent: "Consent", forms: "Forms", crm: "CRM", messages: "Messages" };
const MATCH = ["email", "phone", "user_id"];

// ---------------------------------------------------------------- Imports

function MapColumns({ call, upload, config, onDone }: { call: Call; upload: Import; config?: Config; onDone: (message: string | null) => void }) {
  const t = useT();
  const [map, setMap] = useState<Record<string, string>>(Object.fromEntries(upload.columns.map((c) => [c.name, c.suggested])));
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const matchBy = config?.matchBy ?? MATCH;
  const keys = Object.values(map).filter((v) => matchBy.includes(v)).length;
  const targets = [
    ...MATCH.map((k) => ({ value: k, label: matchBy.includes(k) ? t(`imports.to.${k}Match` as Key) : t(`imports.to.${k}` as Key) })),
    { value: "name", label: t("imports.to.name") },
    ...(config?.traits ?? []).map((x) => ({ value: `trait:${x.key}`, label: t("imports.to.trait", { key: x.key }) })),
    { value: "skip", label: t("imports.to.skip") },
  ];
  useEffect(() => {
    if (!keys) return setPreview(null);
    let live = true;
    const timer = setTimeout(
      () =>
        void call<ImportPreview>(`/api/v1/imports/${upload.id}/preview`, { method: "POST", body: JSON.stringify({ mapping: map }) }).then(
          (r) => live && (setPreview(r), setError(null)),
          (err: Error) => live && setError(err.message),
        ),
      200,
    );
    return () => ((live = false), clearTimeout(timer));
  }, [call, upload.id, map, keys]);
  const run = () => {
    setBusy(true);
    void call<Import>(`/api/v1/imports/${upload.id}/run`, { method: "POST", body: JSON.stringify({ mapping: map }) }).then(
      (r) => onDone(t("imports.done", { created: fmt(r.created ?? 0), matched: fmt(r.matched ?? 0), skipped: fmt(r.skipped ?? 0) })),
      (err: Error) => (setBusy(false), setError(err.message)),
    );
  };
  return (
    <Panel
      aria-label={t("imports.map")}
      title={upload.file}
      description={t("imports.fileDetail", { rows: fmt(upload.rows), columns: upload.columns.length, by: upload.actor })}
    >
      <div className="flex flex-col gap-3">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <caption className="sr-only">{t("imports.columns")}</caption>
            <thead className="text-xs text-fg-muted">
              <tr>
                <th className="py-1 pr-2 font-semibold">{t("imports.column")}</th>
                <th className="py-1 pr-2 font-semibold">{t("imports.firstRow")}</th>
                <th className="py-1 font-semibold">{t("imports.goesTo")}</th>
              </tr>
            </thead>
            <tbody>
              {upload.columns.map((c) => (
                <tr key={c.name} className="border-t border-line">
                  <td className="py-1.5 pr-2 font-mono text-xs">{c.name}</td>
                  <td className="audience-wrap py-1.5 pr-2 text-xs text-fg-muted">{c.sample}</td>
                  <td className="py-1.5">
                    <SelectField
                      aria-label={t("imports.goesToLabel", { column: c.name })}
                      value={map[c.name]}
                      onChange={(e) => setMap({ ...map, [c.name]: e.target.value })}
                      options={targets}
                      className="w-48"
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {keys === 0 ? (
          <Callout tone="danger" title={t("imports.noKey")}>
            {t("imports.noKeyDetail")}
          </Callout>
        ) : preview ? (
          <div className="flex flex-col gap-1">
            <p className="text-xs text-fg-muted">
              {t("imports.expected", { created: fmt(preview.created), matched: fmt(preview.matched), skipped: fmt(preview.skipped) })}{" "}
              {config?.phoneCountry && t("imports.phoneCountry", { country: config.phoneCountry })}
            </p>
            {preview.problems.length > 0 && (
              <ul aria-label={t("imports.problems")} className="audience-list flex flex-col text-2xs text-warning-text">
                {preview.problems.slice(0, 5).map((p) => (
                  <li key={p.row}>{t("imports.problem", { row: p.row, reason: p.reason })}</li>
                ))}
              </ul>
            )}
          </div>
        ) : null}
        {error && <p className="text-xs text-danger-text">{error}</p>}
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="primary" icon={<FileUp />} disabled={keys === 0 || busy} loading={busy} onClick={run}>
            {t("imports.run", { rows: fmt(upload.rows) })}
          </Button>
          <Button
            variant="ghost"
            disabled={busy}
            onClick={() =>
              void call(`/api/v1/imports/${upload.id}`, { method: "DELETE" }).then(
                () => onDone(null),
                () => {},
              )
            }
          >
            {t("imports.discard")}
          </Button>
        </div>
      </div>
    </Panel>
  );
}

export function ImportsPage({ call, config, onChange }: { call: Call; config?: Config; onChange: () => void }) {
  const t = useT();
  const { can } = useAuth();
  const [version, setVersion] = useState(0);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const list = useLoad<{ imports: Import[] }>(call, "/api/v1/imports", version);
  const imports = list?.imports ?? [];
  const current = imports.find((i) => i.state === "uploaded");
  const past = imports.filter((i) => i.state === "done");
  const upload = async (file: File) => {
    setError(null);
    setNotice(null);
    try {
      await call<Import>(`/api/v1/imports?${new URLSearchParams({ file: file.name })}`, {
        method: "POST",
        body: await file.text(),
        headers: { "content-type": "text/csv" },
      });
      setVersion((v) => v + 1);
    } catch (err) {
      setError((err as Error).message);
    }
  };
  return (
    <>
      <PageHeader title={t("imports.title")} description={t("imports.description")} />
      {notice && <Notice>{notice}</Notice>}
      {error && <Notice tone="danger">{error}</Notice>}
      <div className="grid gap-2.5 xl:grid-cols-[minmax(0,1fr)_340px]">
        {current ? (
          <MapColumns
            key={current.id}
            call={call}
            upload={current}
            config={config}
            onDone={(m) => {
              setNotice(m);
              setVersion((v) => v + 1);
              onChange();
            }}
          />
        ) : (
          <Panel aria-label={t("imports.upload")} title={t("imports.upload")} description={t("imports.uploadDetail")}>
            {can("editor") ? (
              <div className="flex flex-col items-start gap-2">
                <input
                  ref={input}
                  type="file"
                  accept=".csv,text/csv"
                  className="sr-only"
                  aria-label={t("imports.choose")}
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) void upload(f);
                    e.target.value = "";
                  }}
                />
                <Button variant="primary" icon={<FileUp />} onClick={() => input.current?.click()}>
                  {t("imports.choose")}
                </Button>
                <p className="text-xs text-fg-muted">{t("imports.consentNote")}</p>
              </div>
            ) : (
              <p className="text-sm text-fg-muted">{t("imports.editorsOnly")}</p>
            )}
          </Panel>
        )}
        <Panel title={t("imports.earlier")} flush>
          {past.length ? (
            <ul aria-label={t("imports.earlier")} className="audience-list flex flex-col">
              {past.map((p) => (
                <li key={p.id} className="flex flex-col border-b border-subtle px-3 py-2 last:border-0">
                  <span className="truncate font-mono text-xs font-medium text-fg">{p.file}</span>
                  <span className="text-2xs text-fg-muted">
                    {t("imports.pastLine", { at: time(p.doneAt), by: p.actor, rows: fmt(p.rows), created: fmt(p.created ?? 0), matched: fmt(p.matched ?? 0) })}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="px-3 py-2 text-xs text-fg-muted">{t("imports.noneYet")}</p>
          )}
        </Panel>
      </div>
    </>
  );
}

// ---------------------------------------------------------------- Deletion requests

function RecordDialog({ open, onOpenChange, onDone }: { open: boolean; onOpenChange: (o: boolean) => void; onDone: (d: Deletion) => void }) {
  const t = useT();
  const call = useApi();
  const [f, setF] = useState({ reference: "", email: "", phone: "", userId: "" });
  const [error, setError] = useState<string | null>(null);
  const ok = f.reference.trim().length >= 3 && (f.email.trim() || f.phone.trim() || f.userId.trim());
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={t("requests.recordTitle")}
      description={t("requests.recordDetail")}
      iconTone="warning"
      onSubmit={(e) => {
        e.preventDefault();
        if (!ok) return;
        const person = Object.fromEntries(Object.entries({ email: f.email, phone: f.phone, userId: f.userId }).filter(([, v]) => v.trim()));
        void call<Deletion>("/api/v1/deletions", { method: "POST", body: JSON.stringify({ reference: f.reference.trim(), person }) }).then(
          (d) => (setF({ reference: "", email: "", phone: "", userId: "" }), onDone(d)),
          (err: Error) => setError(err.message),
        );
      }}
      footer={
        <>
          <Button type="button" onClick={() => onOpenChange(false)}>
            {t("common.cancel")}
          </Button>
          <Button type="submit" variant="danger" disabled={!ok}>
            {t("delete.submit")}
          </Button>
        </>
      }
    >
      <TextField label={t("delete.reference")} value={f.reference} maxLength={100} onChange={set("reference")} placeholder="KVKK-2026-031" />
      <div className="grid gap-3 sm:grid-cols-2">
        <TextField label={t("person.email")} value={f.email} onChange={set("email")} />
        <TextField label={t("person.phone")} value={f.phone} onChange={set("phone")} />
        <TextField label={t("person.userId")} value={f.userId} onChange={set("userId")} mono />
      </div>
      {error && <p className="text-xs text-danger-text">{error}</p>}
    </Dialog>
  );
}

const STATE_TONE = { done: "success", waiting: "warning", pending: "info", failed: "danger" } as const;

export function RequestsPage({ call, onChange }: { call: Call; onChange: () => void }) {
  const t = useT();
  const { can } = useAuth();
  const [version, setVersion] = useState(0);
  const [recording, setRecording] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const list = useLoad<{ deletions: Deletion[] }>(call, "/api/v1/deletions?limit=200", version);
  const rows = list?.deletions ?? [];
  const open = rows.filter((d) => d.state === "waiting" || d.state === "failed");
  const retry = (id: string) =>
    void call<Deletion>(`/api/v1/deletions/${id}/retry`, { method: "POST" }).then(
      (d) => (setNotice(t("requests.retried", { reference: d.reference })), setVersion((v) => v + 1), onChange()),
      (err: Error) => setNotice(err.message),
    );
  const cols: Column<Deletion>[] = [
    {
      id: "ref",
      header: t("requests.request"),
      sortValue: (d) => d.reference,
      cell: (d) => <span className="font-mono text-xs font-medium">{d.reference}</span>,
    },
    { id: "at", header: t("requests.asked"), sortValue: (d) => d.at, cell: (d) => <span className="text-xs whitespace-nowrap">{time(d.at)}</span> },
    { id: "by", header: t("requests.by"), cell: (d) => <span className="text-xs">{d.actor}</span> },
    {
      id: "products",
      header: t("requests.deletedIn"),
      cell: (d) => (
        <span className="flex flex-wrap gap-1">
          <StatusBadge tone="success">{t("requests.here", { events: fmt(d.events) })}</StatusBadge>
          {d.products.map((p) => (
            <StatusBadge key={p.product} tone={STATE_TONE[p.state]}>
              {p.state === "done" ? (NAMES[p.product] ?? p.product) : t(`requests.state.${p.state}`, { product: NAMES[p.product] ?? p.product })}
            </StatusBadge>
          ))}
        </span>
      ),
    },
    {
      id: "act",
      header: <span className="sr-only">{t("requests.actions")}</span>,
      label: t("requests.actions"),
      align: "right",
      cell: (d) =>
        can("admin") && d.state !== "done" ? (
          <Button size="xs" icon={<RefreshCw />} onClick={() => retry(d.id)}>
            {t("requests.retry")}
          </Button>
        ) : null,
    },
  ];
  return (
    <>
      <PageHeader
        title={t("requests.title")}
        description={t("requests.description")}
        actions={
          can("admin") && (
            <Button icon={<UserX />} onClick={() => setRecording(true)}>
              {t("requests.record")}
            </Button>
          )
        }
      />
      {notice && <Notice>{notice}</Notice>}
      {open.map((d) =>
        d.products
          .filter((p) => p.state === "waiting" || p.state === "failed")
          .map((p) => (
            <Callout
              key={`${d.id}-${p.product}`}
              tone={p.state === "failed" ? "danger" : "warning"}
              title={t(p.state === "failed" ? "requests.failedTitle" : "requests.waitingTitle", {
                reference: d.reference,
                product: NAMES[p.product] ?? p.product,
              })}
              className="mb-2.5"
            >
              {p.detail ?? t("requests.noDetail")}
            </Callout>
          )),
      )}
      <Panel flush title={t("requests.list")}>
        <DataTable
          label={t("requests.title")}
          columns={cols}
          rows={rows}
          loading={list === undefined}
          getRowId={(d) => d.id}
          minWidth={760}
          pageSize={50}
          empty={<EmptyState title={t("requests.none")}>{t("requests.noneDetail")}</EmptyState>}
        />
      </Panel>
      <RecordDialog
        open={recording}
        onOpenChange={setRecording}
        onDone={(d) => (
          setRecording(false),
          setNotice(t("requests.recorded", { reference: d.reference, profiles: d.profiles })),
          setVersion((v) => v + 1),
          onChange()
        )}
      />
    </>
  );
}

// ---------------------------------------------------------------- Integrations

function SourceCard({ s, onPull }: { s: LinkedSource; onPull?: () => void }) {
  const t = useT();
  const ago = useAgo();
  const error = s.sites?.find((x) => x.error)?.error;
  const ok = (!s.token || s.token.set) && !error && (s.url || !s.token);
  return (
    <section aria-label={NAMES[s.id]} className="flex flex-col gap-2 rounded-lg border border-line bg-surface p-3">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-sm font-semibold">{NAMES[s.id]}</h2>
        <StatusBadge tone={ok ? "success" : "danger"}>{ok ? t("integrations.linked") : t("integrations.needsAttention")}</StatusBadge>
      </div>
      <p className="text-xs text-fg-muted">{t(`integrations.how.${s.id}` as Key)}</p>
      <dl className="audience-facts grid gap-x-2 gap-y-1 text-xs">
        <dt className="text-fg-muted">{t("integrations.address")}</dt>
        <dd className="audience-wrap font-mono">{s.url ?? (s.token ? t("integrations.noAddress") : t("integrations.inbound"))}</dd>
        <dt className="text-fg-muted">{t("integrations.token")}</dt>
        <dd className="font-mono">{s.token ? `${s.token.variable} · ${s.token.set ? t("integrations.set") : t("integrations.notSet")}` : "–"}</dd>
        <dt className="text-fg-muted">{t("integrations.deletes")}</dt>
        <dd>{s.delete ? t("answer.yes") : t("answer.no")}</dd>
        {s.id !== "consent" && (
          <>
            <dt className="text-fg-muted">{t("integrations.events7d")}</dt>
            <dd className="font-mono">{fmt(s.events7d)}</dd>
          </>
        )}
        {s.sites?.map((x) => (
          <div key={x.site} className="contents">
            <dt className="text-fg-muted">{t("integrations.site", { site: x.site })}</dt>
            <dd className={x.error ? "text-danger-text" : undefined}>{x.error ?? t("integrations.read", { ago: ago(x.lastOkAt), every: s.pull ?? 5 })}</dd>
          </div>
        ))}
      </dl>
      {onPull && (
        <div className="mt-auto pt-1">
          <Button size="sm" icon={<RefreshCw />} onClick={onPull}>
            {t("integrations.pull")}
          </Button>
        </div>
      )}
    </section>
  );
}

export function IntegrationsPage({ call, config, onChange }: { call: Call; config?: Config; onChange: () => void }) {
  const t = useT();
  const { can } = useAuth();
  const [notice, setNotice] = useState<string | null>(null);
  const origin = window.location.origin;
  const linked = config?.sources ?? [];
  const missing = ["analytics", "consent", "forms", "crm", "messages"].filter((p) => !linked.some((s) => s.id === p));
  return (
    <>
      <PageHeader title={t("integrations.title")} description={t("integrations.description")} />
      {notice && <Notice>{notice}</Notice>}
      <div className="mb-2.5 grid gap-2.5 [grid-template-columns:repeat(auto-fill,minmax(240px,1fr))]">
        {linked.map((s) => (
          <SourceCard
            key={s.id}
            s={s}
            onPull={
              s.id === "analytics" && can("admin")
                ? () =>
                    void call<{ events: number }>("/api/v1/sources/analytics/pull", { method: "POST" }).then(
                      (r) => (setNotice(t("integrations.pulled", { count: fmt(r.events) })), onChange()),
                      (err: Error) => setNotice(err.message),
                    )
                : undefined
            }
          />
        ))}
        {missing.map((p) => (
          <section key={p} aria-label={NAMES[p]} className="flex flex-col gap-2 rounded-lg border border-line bg-surface p-3">
            <div className="flex items-center justify-between gap-2">
              <h2 className="text-sm font-semibold">{NAMES[p]}</h2>
              <Badge>{t("integrations.notLinked")}</Badge>
            </div>
            <p className="text-xs text-fg-muted">{t(`integrations.how.${p}` as Key)}</p>
            <code className="font-mono text-2xs text-fg-muted">{t(`integrations.add.${p}` as Key)}</code>
          </section>
        ))}
      </div>
      <div className="grid gap-2.5 xl:grid-cols-2">
        <Panel title={t("integrations.eventsApi")} description={t("integrations.eventsApiDetail")}>
          <Code>{`curl -s -X POST ${origin}/api/v1/events -H "authorization: Bearer $TOKEN" \\
  -H "content-type: application/json" -d '{ "events": [{
    "source": "forms", "type": "form_submitted", "id": "answer-123",
    "person": { "email": "ayse@example.com", "name": "Ayşe Kaya" },
    "traits": { "city": "İzmir" },
    "properties": { "form": "contact-sales" },
    "text": "Sent Contact sales"
  }] }'`}</Code>
        </Panel>
        <Panel title={t("integrations.segmentsApi")} description={t("integrations.segmentsApiDetail")}>
          <Code>{`curl -s ${origin}/api/v1/segments -H "authorization: Bearer $TOKEN"
curl -s "${origin}/api/v1/segments/<id>/members?limit=1000" -H "authorization: Bearer $TOKEN"
curl -s "${origin}/api/v1/segments/<id>/changes?cursor=<cursor>" -H "authorization: Bearer $TOKEN"`}</Code>
          <p className="mt-2 text-xs text-fg-muted">
            {t("integrations.reference")}{" "}
            <a href="/api/docs/" className="text-accent-text">
              /api/docs/
            </a>
          </p>
        </Panel>
      </div>
    </>
  );
}

// ---------------------------------------------------------------- Settings: the file as applied

/** Rebuilt here from published components: the shared file settings page is not in @openasy/ui 0.15.0 yet. */
export function SettingsPage({ config }: { config?: Config }) {
  const t = useT();
  const ago = useAgo();
  if (!config) return <EmptyState title={t("common.loading")} />;
  const file = config.file?.path.split("/").pop() ?? "audience.yaml";
  const groups = [
    {
      title: t("settings.matching"),
      description: t("settings.matchingDetail"),
      items: [
        { label: t("settings.matchBy"), value: t("settings.matchByValue", { kinds: config.matchBy.join(", ") }), path: "match_by" },
        { label: t("settings.phones"), value: t("settings.phonesValue", { country: config.phoneCountry }), path: "phone_country" },
      ],
    },
    {
      title: t("settings.data"),
      items: [
        {
          label: t("settings.traits"),
          value: config.traits.length ? config.traits.map((x) => `${x.key}${x.type !== "string" ? ` (${x.type})` : ""}`).join(", ") : t("settings.none"),
          path: "traits",
        },
        {
          label: t("settings.sources"),
          value: config.sources.length ? config.sources.map((s) => NAMES[s.id]).join(", ") : t("settings.none"),
          path: "sources",
        },
        { label: t("settings.keep"), value: t("settings.keepValue", { days: fmt(config.keepDays) }), path: "events.keep" },
      ],
    },
    {
      title: t("settings.segmentsGroup"),
      items: [
        {
          label: t("settings.recount"),
          value: config.recountMinutes >= 1440 ? t("settings.nightly") : t("settings.every", { minutes: config.recountMinutes }),
          path: "segments.recount",
        },
      ],
    },
  ];
  return (
    <>
      <PageHeader
        title={t("settings.title")}
        description={t("settings.description", { file })}
        meta={
          config.file?.error ? (
            <StatusBadge tone="danger">{t("settings.notApplied")}</StatusBadge>
          ) : (
            <StatusBadge tone="success">{t("settings.applied", { ago: ago(config.file?.appliedAt) })}</StatusBadge>
          )
        }
      />
      {config.file?.error ? (
        <Callout tone="danger" title={t("file.notApplied")} className="mb-2.5">
          {config.file.error}
        </Callout>
      ) : (
        <Callout tone="info" title={t("settings.readOnly", { file })} className="mb-2.5">
          {t("settings.readOnlyDetail")}
        </Callout>
      )}
      <div className="grid gap-2.5 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <div className="flex min-w-0 flex-col gap-2.5">
          {groups.map((g) => (
            <Panel key={g.title} title={g.title} description={g.description} aria-label={g.title}>
              <dl className="audience-settings grid gap-x-3 gap-y-2 text-xs">
                {g.items.map((i) => (
                  <div key={i.path} className="contents">
                    <dt className="flex flex-col text-fg-muted">
                      {i.label}
                      <code className="truncate font-mono text-2xs text-fg-muted">{i.path}</code>
                    </dt>
                    <dd className="min-w-0 text-fg">{i.value}</dd>
                  </div>
                ))}
              </dl>
            </Panel>
          ))}
        </div>
        <Panel
          title={file}
          description={t("settings.asApplied", { ago: ago(config.file?.appliedAt) })}
          actions={<FileCode aria-hidden className="size-3.5 text-fg-muted" />}
          className="self-start"
        >
          <Code label={t("settings.fileLabel", { file })}>{config.text || t("settings.empty")}</Code>
        </Panel>
      </div>
    </>
  );
}

// ---------------------------------------------------------------- Setup

export function SetupPage({ config }: { config?: Config }) {
  const t = useT();
  const origin = window.location.origin;
  return (
    <>
      <PageHeader title={t("setup.title")} description={t("setup.description")} />
      {config?.file?.error && (
        <Callout tone="danger" title={t("file.notApplied")} className="mb-2.5">
          {config.file.error}
        </Callout>
      )}
      <div className="flex flex-col gap-2.5">
        <Panel title={t("setup.step1")} description={t("setup.step1Detail", { path: config?.file?.path ?? "/config/audience.yaml" })}>
          <Code>{`match_by: [email, phone, user_id]
traits:
  plan: { values: [Free, Pro, Business] }
  city: {}
sources:
  analytics: { token: AUDIENCE_ANALYTICS_TOKEN, sites: [shop] }
  consent: { token: AUDIENCE_CONSENT_TOKEN }`}</Code>
        </Panel>
        <Panel title={t("setup.step2")} description={t("setup.step2Detail")}>
          <Code>{`curl -s -X POST ${origin}/api/v1/events -H "authorization: Bearer $TOKEN" \\
  -H "content-type: application/json" \\
  -d '{ "events": [{ "type": "signed_up", "person": { "email": "ayse@example.com", "userId": "u-1" }, "traits": { "plan": "Free" } }] }'`}</Code>
        </Panel>
        <Panel title={t("setup.step3")} description={t("setup.step3Detail")}>
          <Code>{`curl -s -X POST ${origin}/api/v1/segments -H "authorization: Bearer $TOKEN" -H "content-type: application/json" -d '{
  "name": "Free users back on pricing",
  "rules": { "all": [
    { "trait": "plan", "op": "is", "value": "Free" },
    { "event": "page_viewed", "op": "at_least", "days": 30, "where": { "path": "/pricing" } },
    { "event": "deal_opened", "op": "none" }
  ] }
}'`}</Code>
        </Panel>
      </div>
    </>
  );
}
