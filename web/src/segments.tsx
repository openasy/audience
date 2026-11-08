// Segments: the list, a segment's rules and size over time, and the dialog that makes and changes them.
import {
  Badge,
  Button,
  Callout,
  Dialog,
  EmptyState,
  navigate,
  PageHeader,
  Panel,
  SegmentedControl,
  SelectField,
  TextField,
  TimeSeriesChart,
} from "@openasy/ui";
import { useAuth } from "@openasy/auth/react";
import { FileDown, Pencil, Plus, Send, Trash2, X } from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import type { Condition, Config, Preview, Scalar, Segment, SegmentDetail, Trait } from "./api.ts";
import { SOURCES } from "./api.ts";
import { fmt, Notice, shortDay, sourceName, useApi, useLoad, type Call } from "./common.tsx";
import { useT, type Key, type T } from "./i18n.ts";

const OPS: Record<Trait["type"], string[]> = {
  string: ["is", "is_not", "in", "not_in", "contains", "exists", "missing"],
  number: ["is", "is_not", "gt", "gte", "lt", "lte", "exists", "missing"],
  boolean: ["is", "is_not", "exists", "missing"],
  date: ["is", "before", "after", "within_last", "within_next", "exists", "missing"],
};
const PERIODS = [7, 30, 90];

type Leaf = Exclude<Condition, { all: Condition[] } | { any: Condition[] }>;
const isGroup = (c: Condition): c is { all: Condition[] } | { any: Condition[] } => "all" in c || "any" in c;
const childrenOf = (c: Condition) => ("all" in c ? c.all : "any" in c ? c.any : [c]);
const joinOf = (c: Condition): "all" | "any" => ("any" in c ? "any" : "all");

/** A condition in words: the field, how it is compared, and the value. */
function words(t: T, c: Leaf): { field: string; op: string; value?: string } {
  if ("identifier" in c) return { field: t(`rule.identifier.${c.identifier}`), op: c.op === "exists" ? t("rule.op.exists") : t("rule.op.missing") };
  if ("trait" in c) {
    const value = Array.isArray(c.value) ? c.value.join(", ") : c.value !== undefined ? String(c.value) : undefined;
    if (c.op === "within_last" || c.op === "within_next")
      return { field: t("rule.trait", { key: c.trait }), op: t(`rule.op.${c.op}` as Key, { days: c.days ?? 0 }) };
    return { field: t("rule.trait", { key: c.trait }), op: t(`rule.op.${c.op}` as Key), value };
  }
  const where = Object.entries(c.where ?? {})
    .map(([k, v]) => `${k} ${String(v)}`)
    .join(", ");
  const field = [t("rule.event", { type: c.event }), where, c.source ? t("rule.from", { source: sourceName(t, c.source) }) : ""].filter(Boolean).join(" ");
  const times = c.op === "none" ? t("rule.never") : t(`rule.count.${c.op}` as Key, { count: c.count ?? 1 });
  return { field, op: c.days ? t("rule.inLast", { times, days: c.days }) : c.op === "none" ? times : t("rule.ever", { times }) };
}

function RuleRows({ rules, period }: { rules: Condition; period?: { value: number; onChange: (days: number) => void } }) {
  const t = useT();
  const join = joinOf(rules);
  // Only the first event rule with a period gets the period picker, as on the design.
  const picked = period ? firstPeriodLeaf(rules) : null;
  const row = (c: Condition, i: number, j: "all" | "any"): ReactNode => {
    const label = i === 0 ? t("rule.where") : j === "all" ? t("rule.and") : t("rule.or");
    if (isGroup(c))
      return (
        <li key={i} className="flex flex-col gap-1.5 rounded-md border border-line bg-canvas px-2.5 py-1.5 text-sm">
          <span className="text-2xs font-semibold text-fg-muted uppercase">
            {label} · {t(joinOf(c) === "all" ? "rule.allOf" : "rule.anyOf")}
          </span>
          <ol className="audience-list flex flex-col gap-1.5">{childrenOf(c).map((x, k) => row(x, k, joinOf(c)))}</ol>
        </li>
      );
    const w = words(t, c);
    const editable = period && c === picked;
    return (
      <li key={i} className="flex flex-wrap items-center gap-2 rounded-md border border-line bg-canvas px-2.5 py-1.5 text-sm">
        <span className="audience-join text-2xs font-semibold text-fg-muted uppercase">{label}</span>
        <span className="font-medium text-fg">{w.field}</span>
        {editable ? (
          <>
            <span className="text-fg-muted">
              {"event" in c && c.op === "none"
                ? t("rule.never")
                : t(`rule.count.${(c as { op: string }).op}` as Key, { count: (c as { count?: number }).count ?? 1 })}
            </span>
            <SelectField
              aria-label={t("rule.period")}
              value={String(period.value)}
              onChange={(e) => period.onChange(Number(e.target.value))}
              options={[...new Set([...PERIODS, period.value])]
                .sort((a, b) => a - b)
                .map((d) => ({ value: String(d), label: t("rule.lastDays", { days: d }) }))}
              className="w-40"
            />
          </>
        ) : (
          <>
            <span className="text-fg-muted">{w.op}</span>
            {w.value !== undefined && <Badge mono>{w.value}</Badge>}
          </>
        )}
      </li>
    );
  };
  return (
    <ol aria-label={t("segments.rulesLabel")} className="audience-list flex flex-col gap-1.5">
      {childrenOf(rules).map((c, i) => row(c, i, join))}
    </ol>
  );
}

function firstPeriodLeaf(c: Condition): Leaf | null {
  if (isGroup(c)) {
    for (const x of childrenOf(c)) {
      const l = firstPeriodLeaf(x);
      if (l) return l;
    }
    return null;
  }
  return "event" in c && c.days ? c : null;
}

/** The first event rule with a period, with its days changed. */
function withPeriod(c: Condition, days: number): Condition {
  let done = false;
  const walk = (x: Condition): Condition => {
    if ("all" in x) return { all: x.all.map(walk) };
    if ("any" in x) return { any: x.any.map(walk) };
    if (!done && "event" in x && x.days) {
      done = true;
      return { ...x, days };
    }
    return x;
  };
  return walk(c);
}
function firstPeriod(c: Condition): number | null {
  const l = firstPeriodLeaf(c);
  return l && "event" in l ? (l.days ?? null) : null;
}

// ---------------------------------------------------------------- The editor

type Draft =
  | { kind: "trait"; trait: string; op: string; value: string; days: string }
  | { kind: "event"; event: string; op: string; count: string; days: string; source: string; prop: string; propValue: string }
  | { kind: "identifier"; identifier: string; op: string };

function draftOf(c: Leaf): Draft {
  if ("trait" in c)
    return {
      kind: "trait",
      trait: c.trait,
      op: c.op,
      value: Array.isArray(c.value) ? c.value.join(", ") : c.value === undefined ? "" : String(c.value),
      days: String(c.days ?? 30),
    };
  if ("event" in c) {
    const [prop, propValue] = Object.entries(c.where ?? {})[0] ?? ["", ""];
    return {
      kind: "event",
      event: c.event,
      op: c.op,
      count: String(c.count ?? 1),
      days: c.days ? String(c.days) : "",
      source: c.source ?? "",
      prop,
      propValue: String(propValue),
    };
  }
  return { kind: "identifier", identifier: c.identifier, op: c.op };
}

function leafOf(d: Draft, traits: Trait[]): Leaf {
  if (d.kind === "identifier") return { identifier: d.identifier as "email", op: d.op as "exists" };
  if (d.kind === "trait") {
    const type = traits.find((x) => x.key === d.trait)?.type ?? "string";
    if (d.op === "exists" || d.op === "missing") return { trait: d.trait, op: d.op };
    if (d.op === "within_last" || d.op === "within_next") return { trait: d.trait, op: d.op, days: Number(d.days) };
    if (d.op === "in" || d.op === "not_in")
      return {
        trait: d.trait,
        op: d.op,
        value: d.value
          .split(",")
          .map((x) => x.trim())
          .filter(Boolean),
      };
    const value: Scalar = type === "number" ? Number(d.value) : type === "boolean" ? d.value === "true" : d.value;
    return { trait: d.trait, op: d.op, value };
  }
  const v = d.propValue.trim();
  const typed: Scalar = v === "true" ? true : v === "false" ? false : v !== "" && !Number.isNaN(Number(v)) ? Number(v) : v;
  return {
    event: d.event.trim(),
    op: d.op as "at_least",
    ...(d.op !== "none" && { count: Number(d.count) || 1 }),
    ...(d.days && { days: Number(d.days) }),
    ...(d.source && { source: d.source as "crm" }),
    ...(d.prop.trim() && { where: { [d.prop.trim()]: typed } }),
  };
}

function DraftRow({ d, traits, onChange, onRemove, index }: { d: Draft; traits: Trait[]; onChange: (d: Draft) => void; onRemove: () => void; index: number }) {
  const t = useT();
  const kind = (
    <SelectField
      aria-label={t("editor.kind", { n: index + 1 })}
      value={d.kind}
      onChange={(e) =>
        onChange(
          e.target.value === "trait"
            ? { kind: "trait", trait: traits[0]?.key ?? "", op: "is", value: traits[0]?.values?.[0] ?? "", days: "30" }
            : e.target.value === "event"
              ? { kind: "event", event: "page_viewed", op: "at_least", count: "1", days: "30", source: "", prop: "path", propValue: "/pricing" }
              : { kind: "identifier", identifier: "email", op: "exists" },
        )
      }
      options={[
        { value: "trait", label: t("editor.trait") },
        { value: "event", label: t("editor.event") },
        { value: "identifier", label: t("editor.identifier") },
      ]}
      className="w-32"
    />
  );
  let fields: ReactNode;
  if (d.kind === "trait") {
    const trait = traits.find((x) => x.key === d.trait);
    const type = trait?.type ?? "string";
    const ops = OPS[type];
    const op = ops.includes(d.op) ? d.op : ops[0]!;
    fields = (
      <>
        <SelectField
          aria-label={t("editor.traitName", { n: index + 1 })}
          value={d.trait}
          onChange={(e) => onChange({ ...d, trait: e.target.value, op: "is", value: traits.find((x) => x.key === e.target.value)?.values?.[0] ?? "" })}
          options={traits.map((x) => ({ value: x.key, label: x.key }))}
          className="w-36"
        />
        <SelectField
          aria-label={t("editor.op", { n: index + 1 })}
          value={op}
          onChange={(e) => onChange({ ...d, op: e.target.value })}
          options={ops.map((o) => ({ value: o, label: t(`rule.op.${o}` as Key, { days: "N" }) }))}
          className="w-40"
        />
        {op === "within_last" || op === "within_next" ? (
          <TextField
            label={t("editor.days")}
            type="number"
            min={1}
            max={3650}
            value={d.days}
            onChange={(e) => onChange({ ...d, days: e.target.value })}
            className="w-24"
          />
        ) : op === "exists" || op === "missing" ? null : type === "boolean" ? (
          <SelectField
            aria-label={t("editor.value", { n: index + 1 })}
            value={d.value || "true"}
            onChange={(e) => onChange({ ...d, value: e.target.value })}
            options={[
              { value: "true", label: "true" },
              { value: "false", label: "false" },
            ]}
            className="w-24"
          />
        ) : trait?.values && (op === "is" || op === "is_not") ? (
          <SelectField
            aria-label={t("editor.value", { n: index + 1 })}
            value={d.value}
            onChange={(e) => onChange({ ...d, value: e.target.value })}
            options={trait.values.map((v) => ({ value: v, label: v }))}
            className="w-36"
          />
        ) : (
          <TextField
            label={t("editor.valueLabel")}
            type={type === "number" ? "number" : type === "date" ? "date" : "text"}
            value={d.value}
            placeholder={op === "in" || op === "not_in" ? t("editor.commas") : undefined}
            onChange={(e) => onChange({ ...d, value: e.target.value })}
            className="w-40"
          />
        )}
      </>
    );
  } else if (d.kind === "event") {
    fields = (
      <>
        <TextField label={t("editor.eventType")} mono value={d.event} onChange={(e) => onChange({ ...d, event: e.target.value })} className="w-40" />
        <SelectField
          aria-label={t("editor.op", { n: index + 1 })}
          value={d.op}
          onChange={(e) => onChange({ ...d, op: e.target.value })}
          options={["at_least", "at_most", "exactly", "none"].map((o) => ({ value: o, label: t(`editor.eventOp.${o}` as Key) }))}
          className="w-32"
        />
        {d.op !== "none" && (
          <TextField
            label={t("editor.times")}
            type="number"
            min={0}
            max={1000}
            value={d.count}
            onChange={(e) => onChange({ ...d, count: e.target.value })}
            className="w-20"
          />
        )}
        <TextField
          label={t("editor.inLastDays")}
          type="number"
          min={1}
          max={3650}
          value={d.days}
          placeholder={t("editor.ever")}
          onChange={(e) => onChange({ ...d, days: e.target.value })}
          className="w-28"
        />
        <SelectField
          aria-label={t("editor.source", { n: index + 1 })}
          value={d.source}
          onChange={(e) => onChange({ ...d, source: e.target.value })}
          options={[{ value: "", label: t("editor.anySource") }, ...SOURCES.map((s) => ({ value: s, label: sourceName(t, s) }))]}
          className="w-32"
        />
        <TextField label={t("editor.property")} mono value={d.prop} onChange={(e) => onChange({ ...d, prop: e.target.value })} className="w-24" />
        <TextField label={t("editor.propertyValue")} value={d.propValue} onChange={(e) => onChange({ ...d, propValue: e.target.value })} className="w-32" />
      </>
    );
  } else {
    fields = (
      <>
        <SelectField
          aria-label={t("editor.identifierKind", { n: index + 1 })}
          value={d.identifier}
          onChange={(e) => onChange({ ...d, identifier: e.target.value })}
          options={["email", "phone", "user_id"].map((k) => ({ value: k, label: t(`rule.identifier.${k}` as Key) }))}
          className="w-32"
        />
        <SelectField
          aria-label={t("editor.op", { n: index + 1 })}
          value={d.op}
          onChange={(e) => onChange({ ...d, op: e.target.value })}
          options={[
            { value: "exists", label: t("rule.op.exists") },
            { value: "missing", label: t("rule.op.missing") },
          ]}
          className="w-32"
        />
      </>
    );
  }
  return (
    <li className="flex flex-wrap items-end gap-2 rounded-md border border-line bg-canvas px-2.5 py-2">
      {kind}
      {fields}
      <Button type="button" size="sm" variant="ghost" icon={<X />} onClick={onRemove} aria-label={t("editor.remove", { n: index + 1 })}>
        {t("editor.removeShort")}
      </Button>
    </li>
  );
}

function SegmentDialog({
  open,
  onOpenChange,
  segment,
  config,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  segment?: Segment;
  config?: Config;
  onSaved: (s: SegmentDetail) => void;
}) {
  const t = useT();
  const call = useApi();
  const traits = useMemo(() => config?.traits ?? [], [config]);
  const nested = segment ? childrenOf(segment.rules).some(isGroup) : false;
  const [name, setName] = useState(segment?.name ?? "");
  const [description, setDescription] = useState(segment?.description ?? "");
  const [join, setJoin] = useState<"all" | "any">(segment ? joinOf(segment.rules) : "all");
  const [drafts, setDrafts] = useState<Draft[]>(
    segment && !nested
      ? childrenOf(segment.rules).map((c) => draftOf(c as Leaf))
      : traits[0]
        ? [{ kind: "trait", trait: traits[0].key, op: "is", value: traits[0].values?.[0] ?? "", days: "30" }]
        : [{ kind: "event", event: "page_viewed", op: "at_least", count: "1", days: "30", source: "", prop: "path", propValue: "/pricing" }],
  );
  const [preview, setPreview] = useState<{ size?: number; error?: string }>({});
  const [error, setError] = useState<string | null>(null);
  const rules = useMemo<Condition | null>(
    () => (nested ? segment!.rules : drafts.length ? ({ [join]: drafts.map((d) => leafOf(d, traits)) } as Condition) : null),
    [nested, segment, drafts, join, traits],
  );
  useEffect(() => {
    if (!open || !rules) return;
    const timer = setTimeout(
      () =>
        void call<Preview>("/api/v1/segments/preview", { method: "POST", body: JSON.stringify({ rules }) }).then(
          (r) => setPreview({ size: r.size }),
          (err: Error) => setPreview({ error: err.message }),
        ),
      300,
    );
    return () => clearTimeout(timer);
  }, [open, rules, call]);
  const save = () => {
    setError(null);
    const body = JSON.stringify({ name: name.trim(), description: description.trim() || null, ...(!nested && { rules }) });
    void call<SegmentDetail>(segment ? `/api/v1/segments/${segment.id}` : "/api/v1/segments", { method: segment ? "PUT" : "POST", body }).then(
      onSaved,
      (err: Error) => setError(err.message),
    );
  };
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      size="lg"
      title={segment ? t("editor.editTitle", { name: segment.name }) : t("editor.newTitle")}
      description={t("editor.description")}
      onSubmit={(e) => {
        e.preventDefault();
        if (name.trim() && rules && !preview.error) save();
      }}
      footer={
        <>
          <Button type="button" onClick={() => onOpenChange(false)}>
            {t("common.cancel")}
          </Button>
          <Button type="submit" variant="primary" disabled={!name.trim() || !rules || !!preview.error}>
            {segment ? t("editor.save") : t("editor.create")}
          </Button>
        </>
      }
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <TextField label={t("editor.name")} value={name} maxLength={120} onChange={(e) => setName(e.target.value)} />
        <TextField label={t("editor.about")} value={description} maxLength={500} onChange={(e) => setDescription(e.target.value)} />
      </div>
      {nested ? (
        <Callout tone="info" title={t("editor.nested")}>
          <RuleRows rules={segment!.rules} />
        </Callout>
      ) : (
        <>
          <SegmentedControl<"all" | "any">
            label={t("editor.join")}
            value={join}
            onChange={setJoin}
            options={[
              { value: "all", label: t("editor.joinAll") },
              { value: "any", label: t("editor.joinAny") },
            ]}
          />
          <ol aria-label={t("editor.conditions")} className="audience-list flex flex-col gap-1.5">
            {drafts.map((d, i) => (
              <DraftRow
                key={i}
                index={i}
                d={d}
                traits={traits}
                onChange={(x) => setDrafts(drafts.map((y, k) => (k === i ? x : y)))}
                onRemove={() => setDrafts(drafts.filter((_, k) => k !== i))}
              />
            ))}
          </ol>
          <div>
            <Button
              type="button"
              size="sm"
              icon={<Plus />}
              onClick={() =>
                setDrafts([...drafts, { kind: "event", event: "page_viewed", op: "at_least", count: "1", days: "30", source: "", prop: "path", propValue: "" }])
              }
            >
              {t("editor.add")}
            </Button>
          </div>
        </>
      )}
      <p aria-live="polite" className={preview.error ? "text-xs text-danger-text" : "text-sm text-fg"}>
        {preview.error ?? (preview.size !== undefined ? t("segments.matchNow", { count: fmt(preview.size) }) : "")}
      </p>
      {error && <p className="text-xs text-danger-text">{error}</p>}
    </Dialog>
  );
}

// ---------------------------------------------------------------- The page

function SegmentPanel({ call, id, config, onChange }: { call: Call; id: string; config?: Config; onChange: (notice?: string, gone?: boolean) => void }) {
  const t = useT();
  const { can } = useAuth();
  const [version, setVersion] = useState(0);
  const s = useLoad<SegmentDetail>(call, `/api/v1/segments/${id}`, version);
  const [days, setDays] = useState<number | null>(null);
  const [size, setSize] = useState<number | null>(null);
  const [editing, setEditing] = useState(false);
  const [removing, setRemoving] = useState(false);
  const base = s ? firstPeriod(s.rules) : null;
  useEffect(() => {
    if (!s || days === null || days === base) return setSize(null);
    let live = true;
    void call<Preview>("/api/v1/segments/preview", { method: "POST", body: JSON.stringify({ rules: withPeriod(s.rules, days) }) }).then(
      (r) => live && setSize(r.size),
      () => {},
    );
    return () => void (live = false);
  }, [call, s, days, base]);
  if (s === undefined) return <Panel aria-label={t("segments.rules")}>{t("common.loading")}</Panel>;
  if (s === null) return <Panel aria-label={t("segments.rules")}>{t("segments.gone")}</Panel>;
  const period = days ?? base;
  const changed = period !== base;
  const history = s.history.slice(-30);
  const savePeriod = () =>
    void call(`/api/v1/segments/${s.id}`, { method: "PUT", body: JSON.stringify({ rules: withPeriod(s.rules, period!) }) }).then(
      () => (setDays(null), setVersion((v) => v + 1), onChange(t("segments.periodSaved", { name: s.name }))),
      () => {},
    );
  return (
    <div className="flex min-w-0 flex-col gap-2.5">
      <Panel
        aria-label={t("segments.rules")}
        title={s.name}
        description={[
          s.description,
          t("segments.owner", { owner: s.owner }),
          s.usedBy.length ? t("segments.usedBy", { by: s.usedBy.join(", ") }) : t("segments.notUsed"),
        ]
          .filter(Boolean)
          .join(" · ")}
        actions={
          <>
            <Button size="sm" icon={<FileDown />} onClick={() => window.location.assign(`/api/v1/segments/${s.id}/export`)}>
              {t("segments.export")}
            </Button>
            <Button
              size="sm"
              variant="primary"
              icon={<Send />}
              onClick={() => onChange(t("segments.useNotice", { name: s.name, path: `/api/v1/segments/${s.id}/members` }))}
            >
              {t("segments.use")}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-2">
          <RuleRows rules={s.rules} period={base ? { value: period!, onChange: setDays } : undefined} />
          <p aria-live="polite" className="text-sm text-fg">
            <span className="font-mono text-lg font-semibold tabular-nums">{fmt(changed && size !== null ? size : s.size)}</span> {t("segments.peopleMatch")}
          </p>
          <div className="flex flex-wrap gap-1.5">
            {changed && can("editor") && (
              <Button size="sm" variant="primary" onClick={savePeriod}>
                {t("segments.savePeriod", { days: period! })}
              </Button>
            )}
            {can("editor") && (
              <Button size="sm" icon={<Pencil />} onClick={() => setEditing(true)}>
                {t("segments.edit")}
              </Button>
            )}
            {can("editor") && (
              <Button size="sm" variant="ghost" icon={<Trash2 />} onClick={() => setRemoving(true)}>
                {t("segments.delete")}
              </Button>
            )}
          </div>
        </div>
      </Panel>
      <Panel
        title={t("segments.history")}
        description={s.period ? t("segments.historyPeriod", { minutes: config?.recountMinutes ?? 15 }) : t("segments.historyDetail")}
      >
        <TimeSeriesChart
          label={t("segments.historyLabel", { name: s.name })}
          labels={history.map((h) => shortDay(h.day))}
          series={[{ id: "size", name: t("segments.people"), data: history.map((h) => h.size), color: "var(--oa-chart-1)" }]}
          height={160}
          format={(v) => fmt(Math.round(v))}
        />
      </Panel>
      {editing && (
        <SegmentDialog
          open={editing}
          onOpenChange={setEditing}
          segment={s}
          config={config}
          onSaved={(x) => (setEditing(false), setVersion((v) => v + 1), onChange(t("segments.saved", { name: x.name })))}
        />
      )}
      <Dialog
        open={removing}
        onOpenChange={setRemoving}
        title={t("segments.deleteTitle", { name: s.name })}
        description={s.usedBy.length ? t("segments.deleteUsed", { by: s.usedBy.join(", ") }) : t("segments.deleteDetail")}
        iconTone="warning"
        footer={
          <>
            <Button type="button" onClick={() => setRemoving(false)}>
              {t("common.cancel")}
            </Button>
            <Button
              type="button"
              variant="danger"
              onClick={() =>
                void call(`/api/v1/segments/${s.id}`, { method: "DELETE" }).then(
                  () => (setRemoving(false), onChange(t("segments.deleted", { name: s.name }), true)),
                  () => {},
                )
              }
            >
              {t("segments.delete")}
            </Button>
          </>
        }
      />
    </div>
  );
}

export function SegmentsPage({ call, config, selected, onChange }: { call: Call; config?: Config; selected?: string; onChange: () => void }) {
  const t = useT();
  const { can } = useAuth();
  const [version, setVersion] = useState(0);
  const [creating, setCreating] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const list = useLoad<{ segments: Segment[] }>(call, "/api/v1/segments", version);
  const segments = list?.segments ?? [];
  const id = selected ?? segments[0]?.id;
  return (
    <>
      <PageHeader
        title={t("segments.title")}
        description={t("segments.description")}
        actions={
          can("editor") && (
            <Button variant="primary" icon={<Plus />} onClick={() => setCreating(true)}>
              {t("segments.new")}
            </Button>
          )
        }
      />
      {notice && <Notice>{notice}</Notice>}
      {list && !segments.length ? (
        <EmptyState title={t("segments.none")} action={can("editor") && <Button onClick={() => setCreating(true)}>{t("segments.new")}</Button>}>
          {t("segments.noneDetail")}
        </EmptyState>
      ) : (
        <div className="grid gap-2.5 xl:grid-cols-[260px_minmax(0,1fr)]">
          <Panel flush aria-label={t("segments.title")}>
            <ul className="audience-list flex flex-col py-1">
              {segments.map((x) => (
                <li key={x.id}>
                  <button
                    type="button"
                    onClick={() => (setNotice(null), navigate(`/segments/${x.id}`))}
                    aria-current={x.id === id ? "true" : undefined}
                    className={`flex w-full items-center justify-between gap-2 px-3 py-1.5 text-left ${x.id === id ? "bg-accent-soft text-accent-text" : "text-fg hover:bg-canvas"}`}
                  >
                    <span className="truncate text-sm font-medium">{x.name}</span>
                    <span className="shrink-0 font-mono text-2xs text-fg-muted tabular-nums">{fmt(x.size)}</span>
                  </button>
                </li>
              ))}
            </ul>
          </Panel>
          {id && (
            <SegmentPanel
              key={`${id}-${version}`}
              call={call}
              id={id}
              config={config}
              onChange={(n, gone) => {
                if (n) setNotice(n);
                setVersion((v) => v + 1);
                onChange();
                if (gone) navigate("/segments");
              }}
            />
          )}
        </div>
      )}
      {creating && (
        <SegmentDialog
          open={creating}
          onOpenChange={setCreating}
          config={config}
          onSaved={(s) => {
            setCreating(false);
            setNotice(t("segments.created", { name: s.name, count: fmt(s.size) }));
            setVersion((v) => v + 1);
            onChange();
            navigate(`/segments/${s.id}`);
          }}
        />
      )}
    </>
  );
}
