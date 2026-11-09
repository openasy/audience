import {
  AppShell,
  Avatar,
  Badge,
  BarList,
  BrandProvider,
  Button,
  Callout,
  DataTable,
  Dialog,
  EmptyState,
  KpiCard,
  KpiGrid,
  navigate,
  PageHeader,
  Panel,
  PRODUCT_IDS,
  SearchInput,
  SelectField,
  StackedBarChart,
  TextField,
  toLocale,
  usePath,
  useLocalePreference,
  useThemePreference,
  type Column,
  type ProductId,
} from "@openasy/ui";
import { AccountSettings, AuthGate, MembersSettings, SignInSettings, TokensSettings, useAccountMenu, useAuth, useInstallBrand } from "@openasy/auth/react";
import colophon from "virtual:openasy-colophon";
import { FileDown, FileUp, Filter, KeyRound, LayoutDashboard, LogIn, LogOut, Plug, Plus, Settings, Trash2, UserRound, Users, UserX } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { Config, ConsentOfPerson, Person, PersonDetail, ProductLink, Summary, TimelineEvent } from "./api.ts";
import { SOURCES } from "./api.ts";
import { download, fmt, Notice, shortDay, SOURCE_TONE, sourceName, time, traitText, useApi, useLoad, type Call } from "./common.tsx";
import { useT, setViewerLocale } from "./i18n.ts";
import { ImportsPage, IntegrationsPage, RequestsPage, SettingsPage as FileSettings, SetupPage } from "./pages.tsx";
import { search } from "./search.ts";
import { SegmentsPage } from "./segments.tsx";

const PAGES = ["people", "segments", "imports", "requests", "integrations", "settings", "setup", "account", "members", "signin", "tokens", "about"] as const;
type Page = "overview" | (typeof PAGES)[number];
type Route = { page: Page; id?: string };
/** The first path segments that are pages of this UI, for followLinks. */
export const PATHS = ["overview", ...PAGES];
function parseRoute(path: string): Route {
  const [page, id] = path.replace(/^\//, "").split("/");
  if ((PAGES as readonly string[]).includes(page ?? "")) return { page: page as Page, ...(id && { id: decodeURIComponent(id) }) };
  return { page: "overview" };
}

// ---------------------------------------------------------------- Overview

function OverviewPage({ summary }: { summary?: Summary }) {
  const t = useT();
  if (!summary) return <EmptyState title={t("common.loading")} />;
  const known = summary.profiles ? Math.round((summary.knownBy.email / summary.profiles) * 100) : 0;
  const shown = SOURCES.filter((s) => summary.events.some((d) => d.sources[s] > 0));
  const used = summary.segments.filter((s) => s.usedBy.length).length;
  return (
    <>
      <PageHeader title={t("overview.title")} description={t("overview.description")} />
      {summary.file?.error && (
        <Callout tone="danger" title={t("file.notApplied")} className="mb-2.5">
          {summary.file.error}
        </Callout>
      )}
      <KpiGrid minWidth={170} className="mb-2.5">
        <KpiCard
          label={t("overview.profiles")}
          value={fmt(summary.profiles)}
          icon={Users}
          delta={{
            label: t("overview.new30d", { count: fmt(summary.new30d) }),
            direction: summary.new30d ? "up" : "flat",
            intent: summary.new30d ? "good" : "neutral",
          }}
          trend={summary.trend}
        />
        <KpiCard label={t("overview.knownByEmail")} value={`${known}%`} delta={{ label: t("overview.knownRest"), intent: "neutral" }} />
        <KpiCard label={t("overview.merged")} value={fmt(summary.mergedThisMonth)} delta={{ label: t("overview.mergedDetail"), intent: "neutral" }} />
        <KpiCard label={t("overview.eventsToday")} value={fmt(summary.eventsToday)} />
        <KpiCard
          label={t("overview.segments")}
          value={fmt(summary.segments.length)}
          delta={{ label: t("overview.segmentsUsed", { count: used }), intent: "neutral" }}
        />
      </KpiGrid>
      <div className="mb-2.5 grid gap-2.5 xl:grid-cols-[minmax(0,1fr)_320px]">
        <Panel title={t("overview.bySource")} description={t("overview.last14")}>
          {shown.length ? (
            <StackedBarChart
              label={t("overview.bySourceLabel")}
              categories={summary.events.map((d) => shortDay(d.day))}
              segments={shown.map((s) => ({ id: s, name: sourceName(t, s) }))}
              values={summary.events.map((d) => shown.map((s) => d.sources[s]))}
              height={200}
              xTicks={7}
              format={(v) => fmt(Math.round(v))}
            />
          ) : (
            <EmptyState title={t("common.nothingYet")}>{t("overview.noEvents")}</EmptyState>
          )}
        </Panel>
        <Panel title={t("overview.firstSource")} description={t("overview.firstSeen")}>
          {summary.firstSources.length ? (
            <BarList
              label={t("overview.firstSourceLabel")}
              items={summary.firstSources.map((s) => ({ id: s.source, label: sourceName(t, s.source), value: s.profiles }))}
            />
          ) : (
            <EmptyState title={t("common.nothingYet")} />
          )}
        </Panel>
      </div>
      <Panel title={t("overview.segmentSizes")} description={t("overview.segmentSizesDetail")} flush>
        {summary.segments.length ? (
          <ul aria-label={t("overview.segmentSizesLabel")} className="audience-list grid gap-px bg-line sm:grid-cols-2 xl:grid-cols-3">
            {summary.segments.map((s) => (
              <li key={s.id} className="flex flex-col gap-0.5 bg-surface px-3 py-2">
                <a href={`/segments/${s.id}`} className="truncate text-sm font-medium text-fg">
                  {s.name}
                </a>
                <span className="flex items-baseline gap-2">
                  <span className="font-mono text-lg font-semibold tabular-nums">{fmt(s.size)}</span>
                  <span className={s.change30d >= 0 ? "text-xs text-success" : "text-xs text-danger-text"}>
                    {t("overview.change30d", { change: `${s.change30d >= 0 ? "+" : ""}${fmt(s.change30d)}` })}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <div className="p-3">
            <EmptyState title={t("overview.noSegments")} action={<Button onClick={() => navigate("/segments")}>{t("segments.new")}</Button>} />
          </div>
        )}
      </Panel>
    </>
  );
}

// ---------------------------------------------------------------- People

function AddDialog({ open, onOpenChange, onDone }: { open: boolean; onOpenChange: (o: boolean) => void; onDone: (p: Person) => void }) {
  const t = useT();
  const call = useApi();
  const [f, setF] = useState({ email: "", phone: "", userId: "", name: "" });
  const [error, setError] = useState<string | null>(null);
  const any = f.email.trim() || f.phone.trim() || f.userId.trim();
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={t("add.title")}
      description={t("add.description")}
      onSubmit={(e) => {
        e.preventDefault();
        if (!any) return;
        setError(null);
        const person = Object.fromEntries(Object.entries(f).filter(([, v]) => v.trim()));
        void call<{ person: Person }>("/api/v1/profiles", { method: "POST", body: JSON.stringify({ person }) }).then(
          (r) => (setF({ email: "", phone: "", userId: "", name: "" }), onDone(r.person)),
          (err: Error) => setError(err.message),
        );
      }}
      footer={
        <>
          <Button type="button" onClick={() => onOpenChange(false)}>
            {t("common.cancel")}
          </Button>
          <Button type="submit" variant="primary" disabled={!any}>
            {t("add.submit")}
          </Button>
        </>
      }
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <TextField label={t("person.email")} type="email" value={f.email} onChange={set("email")} />
        <TextField label={t("person.phone")} value={f.phone} onChange={set("phone")} placeholder="+90 555 111 22 33" />
        <TextField label={t("person.userId")} value={f.userId} onChange={set("userId")} mono />
        <TextField label={t("person.name")} value={f.name} onChange={set("name")} />
      </div>
      <p className="text-xs text-fg-muted">{t("add.matched")}</p>
      {error && <p className="text-xs text-danger-text">{error}</p>}
    </Dialog>
  );
}

const PRODUCT_NAMES: Record<string, string> = { analytics: "Analytics", consent: "Consent", forms: "Forms", crm: "CRM", messages: "Messages" };

function DeleteDialog({
  person,
  config,
  open,
  onOpenChange,
  onDone,
}: {
  person: PersonDetail;
  config?: Config;
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onDone: (products: string[]) => void;
}) {
  const t = useT();
  const call = useApi();
  const [ref, setRef] = useState("");
  const [error, setError] = useState<string | null>(null);
  const name = person.name ?? person.email ?? person.phone ?? person.userId ?? person.id;
  const products = (config?.sources ?? []).filter((s) => s.delete).map((s) => s.id);
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={t("delete.title", { name })}
      description={t("delete.description")}
      iconTone="warning"
      onSubmit={(e) => {
        e.preventDefault();
        if (ref.trim().length < 3) return;
        setError(null);
        void call(`/api/v1/people/${person.id}?${new URLSearchParams({ reference: ref.trim() })}`, { method: "DELETE" }).then(
          () => onDone(products.map((p) => PRODUCT_NAMES[p] ?? p)),
          (err: Error) => setError(err.message),
        );
      }}
      footer={
        <>
          <Button type="button" onClick={() => onOpenChange(false)}>
            {t("common.cancel")}
          </Button>
          <Button type="submit" variant="danger" disabled={ref.trim().length < 3}>
            {t("delete.submit")}
          </Button>
        </>
      }
    >
      <ul aria-label={t("delete.where")} className="audience-list flex flex-col gap-1 text-xs">
        <li className="flex items-center gap-2">
          <Trash2 aria-hidden className="size-3 text-fg-muted" />
          {t("delete.here", { count: fmt(person.eventCount) })}
        </li>
        {products.map((p) => (
          <li key={p} className="flex items-center gap-2">
            <Trash2 aria-hidden className="size-3 text-fg-muted" />
            {t(`delete.in.${p}`)}
          </li>
        ))}
      </ul>
      <TextField label={t("delete.reference")} value={ref} maxLength={100} onChange={(e) => setRef(e.target.value)} placeholder="KVKK-2026-031" />
      {error && <p className="text-xs text-danger-text">{error}</p>}
    </Dialog>
  );
}

function ConsentLine({ call, id }: { call: Call; id: string }) {
  const t = useT();
  const c = useLoad<ConsentOfPerson>(call, `/api/v1/people/${id}/consent`);
  if (c === undefined) return <span className="text-fg-muted">{t("common.loading")}</span>;
  if (c === null || c.error) return <span className="text-danger-text">{c?.error ?? t("common.failed")}</span>;
  if (!c.linked) return <span className="text-fg-muted">{t("person.consentNotLinked")}</span>;
  const standing = c.people.flatMap((p) => p.standing);
  if (!standing.length) return <span className="text-fg-muted">{t("person.consentNone")}</span>;
  return (
    <span className="flex flex-wrap gap-1">
      {standing.map((s) => (
        <Badge key={`${s.purpose}-${s.channel}`} tone={s.allowed ? "success" : "danger"}>
          {t("person.consentEntry", { purpose: s.purpose, channel: s.channel, answer: s.allowed ? t("answer.yes") : t("answer.no") })}
          {s.version !== null && ` · v${s.version}`}
        </Badge>
      ))}
    </span>
  );
}

function Timeline({ call, person }: { call: Call; person: PersonDetail }) {
  const t = useT();
  const [events, setEvents] = useState<TimelineEvent[]>(person.events);
  const [cursor, setCursor] = useState(person.nextCursor);
  const more = () =>
    void call<{ events: TimelineEvent[]; nextCursor?: string }>(
      `/api/v1/people/${person.id}/events?${new URLSearchParams({ cursor: cursor!, limit: "100" })}`,
    ).then(
      (r) => (setEvents((e) => [...e, ...r.events]), setCursor(r.nextCursor)),
      () => {},
    );
  return (
    <section className="flex flex-col gap-1.5 border-t border-line pt-2.5">
      <h3 className="text-xs font-semibold text-fg-muted">{t("person.timeline", { count: fmt(person.eventCount) })}</h3>
      {events.length ? (
        <ol aria-label={t("person.timelineLabel")} className="audience-list flex flex-col gap-2">
          {events.map((e) => (
            <li key={e.id} className="flex gap-2 text-xs">
              <Badge tone={SOURCE_TONE[e.source]} className="audience-source shrink-0 justify-center">
                {sourceName(t, e.source)}
              </Badge>
              <span className="flex min-w-0 flex-col">
                <span className="audience-wrap text-fg">{e.text ?? e.type}</span>
                <span className="text-2xs text-fg-muted">
                  {time(e.at)}
                  {e.text ? ` · ${e.type}` : ""}
                </span>
              </span>
            </li>
          ))}
        </ol>
      ) : (
        <p className="text-xs text-fg-muted">{t("person.noEvents")}</p>
      )}
      {cursor && (
        <Button size="sm" variant="ghost" onClick={more}>
          {t("person.more")}
        </Button>
      )}
    </section>
  );
}

function ProfilePanel({ call, id, config, onDeleted }: { call: Call; id: string; config?: Config; onDeleted: (name: string, products: string[]) => void }) {
  const t = useT();
  const { can } = useAuth();
  const p = useLoad<PersonDetail>(call, `/api/v1/people/${id}`);
  const [deleting, setDeleting] = useState(false);
  if (p === undefined) return <Panel aria-label={t("person.profile")}>{t("common.loading")}</Panel>;
  if (p === null) return <Panel aria-label={t("person.profile")}>{t("person.gone")}</Panel>;
  const traits = config?.traits ?? [];
  const name = p.name ?? p.email ?? p.phone ?? p.userId ?? p.id;
  const enumTrait = traits.find((x) => x.values);
  const headline = traits
    .filter((x) => x !== enumTrait && p.traits[x.key] !== undefined)
    .slice(0, 2)
    .map((x) => traitText(p.traits[x.key]))
    .join(" · ");
  const rest = traits.filter((x) => p.traits[x.key] !== undefined);
  return (
    <Panel
      aria-label={t("person.profile")}
      title={<span className="audience-wrap">{name}</span>}
      description={headline || undefined}
      actions={enumTrait && p.traits[enumTrait.key] !== undefined ? <Badge tone="info">{traitText(p.traits[enumTrait.key])}</Badge> : undefined}
    >
      <div className="flex flex-col gap-3">
        <dl className="audience-facts grid gap-x-2 gap-y-1.5 text-xs">
          <dt className="text-fg-muted">{t("person.email")}</dt>
          <dd className="audience-wrap font-mono text-fg">{p.emails.length ? p.emails.join(", ") : "–"}</dd>
          <dt className="text-fg-muted">{t("person.phone")}</dt>
          <dd className="font-mono text-fg">{p.phones.length ? p.phones.join(", ") : "–"}</dd>
          <dt className="text-fg-muted">{t("person.userId")}</dt>
          <dd className="font-mono text-fg">{p.userId ?? "–"}</dd>
          <dt className="text-fg-muted">{t("person.sources")}</dt>
          <dd className="flex flex-wrap gap-1">
            {p.sources.map((s) => (
              <Badge key={s} tone={SOURCE_TONE[s]}>
                {sourceName(t, s)}
              </Badge>
            ))}
          </dd>
          <dt className="text-fg-muted">{t("person.consent")}</dt>
          <dd className="text-fg">
            <ConsentLine call={call} id={p.id} />
          </dd>
          <dt className="text-fg-muted">{t("person.segments")}</dt>
          <dd className="text-fg">{p.segments.length ? p.segments.map((s) => s.name).join(", ") : t("person.noSegments")}</dd>
          {rest.map((x) => (
            <div key={x.key} className="contents">
              <dt className="truncate font-mono text-fg-muted">{x.key}</dt>
              <dd className="audience-wrap text-fg">{traitText(p.traits[x.key])}</dd>
            </div>
          ))}
        </dl>
        {p.mergedFrom.length > 0 && <p className="text-2xs text-fg-muted">{t("person.merged", { count: p.mergedFrom.length })}</p>}
        <Timeline key={p.id} call={call} person={p} />
        <div className="flex flex-wrap gap-1.5">
          {can("admin") && (
            <Button
              size="sm"
              icon={<FileDown />}
              onClick={() =>
                void call(`/api/v1/people/${p.id}/export`).then(
                  (d) => download(`audience-${p.id}.json`, JSON.stringify(d, null, 2)),
                  () => {},
                )
              }
            >
              {t("person.export")}
            </Button>
          )}
          {can("admin") && (
            <Button size="sm" variant="ghost" icon={<Trash2 />} onClick={() => setDeleting(true)}>
              {t("person.delete")}
            </Button>
          )}
        </div>
      </div>
      <DeleteDialog
        key={p.id}
        person={p}
        config={config}
        open={deleting}
        onOpenChange={setDeleting}
        onDone={(products) => (setDeleting(false), onDeleted(name, products))}
      />
    </Panel>
  );
}

function PeoplePage({ call, config, selected }: { call: Call; config?: Config; selected?: string }) {
  const t = useT();
  const { can } = useAuth();
  const [query, setQuery] = useState("");
  const [q, setQ] = useState("");
  const enumTrait = config?.traits.find((x) => x.values);
  const [value, setValue] = useState("all");
  const [version, setVersion] = useState(0);
  const [adding, setAdding] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  useEffect(() => {
    const timer = setTimeout(() => setQ(query.trim()), 250);
    return () => clearTimeout(timer);
  }, [query]);
  const params = new URLSearchParams({ limit: "200", ...(q && { q }), ...(enumTrait && value !== "all" && { trait: `${enumTrait.key}:${value}` }) });
  const list = useLoad<{ people: Person[]; total: number; nextCursor?: string }>(call, `/api/v1/people?${params}`, version);
  const rows = list?.people ?? [];
  const active = selected ?? rows[0]?.id;
  const columnTraits = (config?.traits ?? []).slice(0, 2);
  const cols: Column<Person>[] = [
    {
      id: "name",
      header: t("people.person"),
      width: "34%",
      sortValue: (p) => p.name ?? p.email ?? "",
      cell: (p) => (
        <span className="flex min-w-0 items-center gap-2">
          <Avatar name={p.name ?? p.email ?? "?"} size="sm" />
          <span className="flex min-w-0 flex-col">
            <span className="truncate font-medium">{p.name ?? p.email ?? p.phone ?? p.userId}</span>
            <span className="truncate text-2xs text-fg-muted">{[p.name ? p.email : null, p.userId].filter(Boolean).join(" · ")}</span>
          </span>
        </span>
      ),
    },
    ...columnTraits.map((x) => ({
      id: `trait-${x.key}`,
      header: x.key,
      sortValue: (p: Person) => traitText(p.traits[x.key]),
      cell: (p: Person) =>
        p.traits[x.key] === undefined ? (
          <span className="text-xs text-fg-muted">–</span>
        ) : x.values ? (
          <Badge>{traitText(p.traits[x.key])}</Badge>
        ) : (
          <span className="text-xs">{traitText(p.traits[x.key])}</span>
        ),
    })),
    { id: "sources", header: t("people.sources"), align: "right", mono: true, sortValue: (p) => p.sources.length, cell: (p) => p.sources.length },
    {
      id: "last",
      header: t("people.latest"),
      sortValue: (p) => p.lastAt ?? "",
      cell: (p) => <span className="text-xs whitespace-nowrap">{time(p.lastAt)}</span>,
    },
  ];
  return (
    <>
      <PageHeader
        title={t("people.title")}
        description={t("people.description")}
        actions={
          can("editor") && (
            <Button variant="primary" icon={<Plus />} onClick={() => setAdding(true)}>
              {t("people.add")}
            </Button>
          )
        }
      />
      {notice && <Notice>{notice}</Notice>}
      <div className="grid gap-2.5 xl:grid-cols-[minmax(0,1fr)_380px]">
        <Panel flush aria-label={t("people.all")}>
          <div className="flex flex-wrap items-end gap-2 px-3 py-2">
            <SearchInput
              label={t("people.search")}
              placeholder={t("people.searchPlaceholder")}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              className="w-64"
            />
            {enumTrait && (
              <SelectField
                aria-label={enumTrait.key}
                value={value}
                onChange={(e) => setValue(e.target.value)}
                options={[{ value: "all", label: t("people.every", { trait: enumTrait.key }) }, ...enumTrait.values!.map((v) => ({ value: v, label: v }))]}
                className="w-36"
              />
            )}
            <span className="ml-auto self-center text-xs text-fg-muted">
              {list
                ? list.nextCursor
                  ? t("people.countLatest", { shown: fmt(rows.length), count: fmt(list.total) })
                  : t("people.count", { count: fmt(list.total) })
                : ""}
            </span>
          </div>
          <div className="border-t border-line">
            <DataTable
              label={t("people.table")}
              columns={cols}
              rows={rows}
              loading={list === undefined}
              getRowId={(p) => p.id}
              onRowClick={(p) => navigate(`/people/${p.id}`)}
              activeRowId={active}
              minWidth={640}
              pageSize={50}
              empty={<EmptyState title={t("people.none")}>{t("people.noneDetail")}</EmptyState>}
            />
          </div>
        </Panel>
        {active ? (
          <ProfilePanel
            key={`${active}-${version}`}
            call={call}
            id={active}
            config={config}
            onDeleted={(name, products) => {
              setNotice(products.length ? t("delete.done", { name, products: products.join(", ") }) : t("delete.doneHere", { name }));
              setVersion((v) => v + 1);
              navigate("/people");
            }}
          />
        ) : (
          <Panel aria-label={t("person.profile")}>
            <p className="text-sm text-fg-muted">{t("people.pick")}</p>
          </Panel>
        )}
      </div>
      <AddDialog
        open={adding}
        onOpenChange={setAdding}
        onDone={(p) => {
          setAdding(false);
          setVersion((v) => v + 1);
          navigate(`/people/${p.id}`);
        }}
      />
    </>
  );
}

// ---------------------------------------------------------------- Shell

/** Account, Members, Sign-in and API tokens: the screens come from @openasy/auth. */
function AuthSettingsPage({ page }: { page: "account" | "members" | "signin" | "tokens" }) {
  const t = useT();
  const { signOut, can } = useAuth();
  if (page !== "account" && !can("admin")) return <EmptyState title={t("settings.adminsOnly")}>{t("settings.askAnAdmin")}</EmptyState>;
  return (
    <>
      <PageHeader
        title={t(`settings.${page}`)}
        description={t(`settings.${page}Detail`)}
        actions={
          page === "account" && (
            <Button icon={<LogOut />} onClick={() => void signOut()}>
              {t("settings.signOut")}
            </Button>
          )
        }
      />
      {page === "account" ? <AccountSettings /> : page === "members" ? <MembersSettings /> : page === "signin" ? <SignInSettings /> : <TokensSettings />}
    </>
  );
}

function Product() {
  const msg = useT();
  const [theme, setTheme] = useThemePreference();
  const [, setLocale] = useLocalePreference();
  const { me, can } = useAuth();
  const account = useAccountMenu();
  const route = parseRoute(usePath());
  const [summary, setSummary] = useState<Summary>();
  const [config, setConfig] = useState<Config>();
  const [products, setProducts] = useState<Array<ProductLink & { id: ProductId }>>([]);
  const call = useApi();
  const onSearch = useMemo(() => search(call, msg), [call, msg]);

  // The install's other products (OPENASY_PRODUCTS), for the switcher; ids this UI does not know are left out.
  useEffect(() => {
    void call<{ products: ProductLink[] }>("/api/v1/products").then(
      (r) =>
        setProducts(r.products.filter((p): p is ProductLink & { id: ProductId } => p.id !== "audience" && (PRODUCT_IDS as readonly string[]).includes(p.id))),
      () => {},
    );
  }, [call]);

  const reload = useCallback(() => {
    void call<Summary>("/api/v1/summary").then(setSummary, () => {});
    void call<Config>("/api/v1/config").then(setConfig, () => {});
  }, [call]);
  useEffect(() => {
    reload();
    const timer = setInterval(reload, 30_000);
    return () => clearInterval(timer);
  }, [reload]);

  const open = (summary?.deletions.pending ?? 0) + (summary?.deletions.waiting ?? 0) + (summary?.deletions.failed ?? 0);
  const nav = [
    { id: "overview", label: msg("nav.overview"), icon: LayoutDashboard },
    { id: "people", label: msg("nav.people"), icon: Users },
    { id: "segments", label: msg("nav.segments"), icon: Filter, count: summary?.segments.length || undefined },
    { id: "imports", label: msg("nav.imports"), icon: FileUp },
    { id: "requests", label: msg("nav.requests"), icon: UserX, count: open || undefined, attention: !!summary?.deletions.failed },
  ];
  const footerNav = [
    { id: "integrations", label: msg("nav.integrations"), icon: Plug },
    { id: "settings", label: msg("nav.settings"), icon: Settings },
    ...(can("admin")
      ? [
          { id: "members", label: msg("nav.members"), icon: Users },
          { id: "signin", label: msg("nav.signIn"), icon: LogIn },
          { id: "tokens", label: msg("nav.apiTokens"), icon: KeyRound },
        ]
      : []),
    { id: "account", label: msg("nav.account"), icon: UserRound },
  ];
  const roleName = me.user.role.charAt(0).toUpperCase() + me.user.role.slice(1);
  const empty = summary !== undefined && summary.profiles === 0 && summary.segments.length === 0 && route.page === "overview";

  return (
    <AppShell
      product="audience"
      onSearch={onSearch}
      about={colophon}
      nav={nav}
      activeNav={route.page}
      onNavigate={(id) => navigate(`/${id}`)}
      connectedProducts={products.map((p) => p.id)}
      onSwitchProduct={(id) => {
        const to = products.find((p) => p.id === id);
        if (to) window.location.assign(to.url);
      }}
      footerNav={account.settings(footerNav)}
      setup
      user={{ name: me.user.name, role: roleName, ...account.user }}
      theme={theme}
      onThemeChange={setTheme}
      onLanguageChange={(code) => setLocale(toLocale(code))}
    >
      {empty || route.page === "setup" ? (
        <SetupPage config={config} />
      ) : route.page === "overview" ? (
        <OverviewPage summary={summary} />
      ) : route.page === "people" ? (
        <PeoplePage call={call} config={config} selected={route.id} />
      ) : route.page === "segments" ? (
        <SegmentsPage call={call} config={config} selected={route.id} onChange={reload} />
      ) : route.page === "imports" ? (
        <ImportsPage call={call} config={config} onChange={reload} />
      ) : route.page === "requests" ? (
        <RequestsPage call={call} onChange={reload} />
      ) : route.page === "integrations" ? (
        <IntegrationsPage call={call} config={config} onChange={reload} />
      ) : route.page === "settings" ? (
        <FileSettings config={config} />
      ) : route.page === "account" || route.page === "members" || route.page === "signin" || route.page === "tokens" ? (
        <AuthSettingsPage page={route.page} />
      ) : (
        <SetupPage config={config} />
      )}
    </AppShell>
  );
}

export function App() {
  const installBrand = useInstallBrand();
  const [theme] = useThemePreference();
  const [locale] = useLocalePreference();
  setViewerLocale(locale);
  return (
    // The install's brand from config/brand.env (ADR 0053); OpenAsy's own look where it sets none.
    <BrandProvider theme={theme} locale={locale} brand={{ name: "OpenAsy", organization: undefined, ...installBrand }} className="min-h-screen">
      <AuthGate product="OpenAsy Audience">
        <Product />
      </AuthGate>
    </BrandProvider>
  );
}
