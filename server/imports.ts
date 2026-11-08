// People from a CSV. The file is uploaded and kept until it is imported or discarded; each column is mapped to email,
// phone, user id, name or a trait, or left out. Rows are matched to profiles by the same rule as everything else, so a
// row with an email already here adds to that person, and a row with nothing to match by is skipped, never guessed.
// After the import only the counts stay; the file itself is deleted.
import { gunzipSync, gzipSync } from "node:zlib";
import type { Audience } from "./audience.ts";
import { newId, traitValue, type Ids } from "./audience.ts";
import type { IdKind } from "./config.ts";
import { parseCsv } from "./csv.ts";
import { AudienceError, bad, isObj, notFound } from "./errors.ts";
import { fold, normalEmail, normalPhone, normalUserId } from "./identity.ts";

export const MAX_BYTES = 20 * 1024 * 1024;
const MAX_ROWS = 100_000;
const MAX_COLUMNS = 50;

/** Column names people use, in English, Turkish and German, for the mapping offered first. */
const GUESS: Array<[RegExp, string]> = [
  [/^(e-?mail|e-?posta|mail|email address|e-?mail-?adresse)$/, "email"],
  [/^(phone|telefon|tel|gsm|cep|cep telefonu|mobile|mobil|handy|telefonnummer|phone number)$/, "phone"],
  [/^(user ?id|user_id|userid|kullanici ?id|uye no|customer id|kundennummer|musteri no)$/, "user_id"],
  [/^(name|full name|ad soyad|adi soyadi|isim|ad|vollstandiger name)$/, "name"],
];
const TRAIT_WORDS: Record<string, string[]> = {
  city: ["sehir", "il", "stadt", "city"],
  company: ["firma", "sirket", "unternehmen", "company"],
  sector: ["sektor", "branche", "industry", "sector"],
  plan: ["plan", "paket", "tarif"],
  country: ["ulke", "land", "country"],
};

export type Target = "email" | "phone" | "user_id" | "name" | "skip" | `trait:${string}`;

export function createImports(a: Audience) {
  const { all, one, run, tx, clock } = a;
  const iso = () => new Date(clock()).toISOString();
  const ascii = (s: string) =>
    fold(s)
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/[_\s]+/g, " ")
      .trim();

  function suggest(column: string): Target {
    const n = ascii(column);
    for (const [re, target] of GUESS) if (re.test(n)) return target as Target;
    for (const t of a.config().traits) {
      if (ascii(t.key.replace(/_/g, " ")) === n || (TRAIT_WORDS[t.key] ?? []).includes(n)) return `trait:${t.key}`;
    }
    return "skip";
  }

  interface ImportRow {
    id: string;
    file: string;
    actor: string;
    uploaded_at: string;
    rows: number;
    columns: string;
    data: Uint8Array | null;
    state: "uploaded" | "done" | "discarded";
    mapping: string | null;
    created: number | null;
    matched: number | null;
    skipped: number | null;
    done_at: string | null;
  }

  function present(r: ImportRow) {
    const columns = JSON.parse(r.columns) as Array<{ name: string; sample: string }>;
    return {
      id: r.id,
      file: r.file,
      actor: r.actor,
      uploadedAt: r.uploaded_at,
      rows: r.rows,
      state: r.state,
      columns: columns.map((c) => ({ ...c, suggested: suggest(c.name) })),
      mapping: r.mapping ? (JSON.parse(r.mapping) as Record<string, Target>) : null,
      created: r.created,
      matched: r.matched,
      skipped: r.skipped,
      doneAt: r.done_at,
    };
  }

  const rowOf = (id: string) => one<ImportRow>("SELECT * FROM imports WHERE id = ?", id);
  function waiting(id: string) {
    const r = rowOf(id);
    if (!r) throw notFound("The import");
    if (r.state !== "uploaded" || !r.data) throw new AudienceError(409, "conflict", "This file was imported or discarded already; upload it again.");
    return r;
  }

  /** POST /api/v1/imports: the file, kept until it is imported. */
  function upload(text: string, file: unknown, actor: string) {
    const name = typeof file === "string" && file.trim() ? file.trim().slice(0, 200) : "upload.csv";
    const rows = parseCsv(text);
    const header = rows[0];
    if (!header || rows.length < 2) throw bad("The file has a header line and at least one row.");
    if (header.length > MAX_COLUMNS) throw bad(`The file has more than ${MAX_COLUMNS} columns.`);
    if (rows.length - 1 > MAX_ROWS) throw bad(`The file has more than ${MAX_ROWS} rows; split it.`);
    const names = header.map((h) => h.trim());
    if (names.some((n) => !n)) throw bad("Every column needs a name in the header line.");
    if (new Set(names).size !== names.length) throw bad("Two columns have the same name in the header line.");
    const columns = names.map((n, i) => ({ name: n, sample: (rows.slice(1).find((r) => r[i]?.trim())?.[i] ?? "").trim().slice(0, 200) }));
    const id = newId();
    run(
      "INSERT INTO imports (id, file, actor, uploaded_at, rows, columns, data, state) VALUES (?, ?, ?, ?, ?, ?, ?, 'uploaded')",
      id,
      name,
      actor,
      iso(),
      rows.length - 1,
      JSON.stringify(columns),
      gzipSync(JSON.stringify(rows)),
    );
    return present(rowOf(id)!);
  }

  function parseMapping(v: unknown, columns: string[]): Record<string, Target> {
    if (!isObj(v) || !isObj(v.mapping) || Object.keys(v).some((k) => k !== "mapping")) throw bad("The body is { mapping: { column: target } }.");
    const out: Record<string, Target> = {};
    const used = new Set<string>();
    for (const [col, target] of Object.entries(v.mapping)) {
      if (!columns.includes(col)) throw bad(`mapping: the file has no column ${col}.`);
      if (typeof target !== "string") throw bad(`mapping.${col} is email, phone, user_id, name, trait:<name> or skip.`);
      if (target.startsWith("trait:")) {
        if (!a.traitOf(target.slice(6))) throw bad(`mapping.${col}: no trait ${target.slice(6)} in audience.yaml.`);
      } else if (!["email", "phone", "user_id", "name", "skip"].includes(target))
        throw bad(`mapping.${col} is email, phone, user_id, name, trait:<name> or skip.`);
      if (target !== "skip") {
        if (used.has(target)) throw bad(`mapping: two columns go to ${target}.`);
        used.add(target);
      }
      out[col] = target as Target;
    }
    const keys = a.config().matchBy.filter((k) => used.has(k));
    if (!keys.length)
      throw bad(
        `Choose at least one column to match by: ${a.config().matchBy.join(", ")}. Without one a row cannot be matched to a person, so nothing would be imported.`,
      );
    return out;
  }

  function rowsOf(r: ImportRow) {
    return JSON.parse(gunzipSync(r.data!).toString("utf8")) as string[][];
  }

  /** The identifiers, name and traits of a row as the mapping reads them, or why it is skipped. */
  function readRow(row: string[], header: string[], mapping: Record<string, Target>) {
    const country = a.config().phoneCountry;
    const ids: Ids = { email: null, phone: null, userId: null, name: null };
    const traits: Record<string, string> = {};
    const problems: string[] = [];
    header.forEach((col, i) => {
      const target = mapping[col] ?? "skip";
      const raw = (row[i] ?? "").trim();
      if (target === "skip" || !raw) return;
      if (target === "email") ids.email = normalEmail(raw) ?? (problems.push(`${col} is not an email address`), null);
      else if (target === "phone") ids.phone = normalPhone(raw, country) ?? (problems.push(`${col} is not a phone number`), null);
      else if (target === "user_id") ids.userId = normalUserId(raw) ?? (problems.push(`${col} is not a user id`), null);
      else if (target === "name") ids.name = raw.slice(0, 200);
      else {
        const t = a.traitOf(target.slice(6))!;
        const v = traitValue(t, raw);
        if ("reason" in v) problems.push(`${col}: ${t.key} ${v.reason}`);
        else traits[t.key] = v.value;
      }
    });
    const matchable = a.config().matchBy.some((k) => (k === "email" ? ids.email : k === "phone" ? ids.phone : ids.userId));
    return { ids, traits, problems, matchable };
  }

  /** What an import would do, without doing it: new people, people matched to someone here, and rows skipped. */
  function preview(id: string, body: unknown) {
    const r = waiting(id);
    const rows = rowsOf(r);
    const header = rows[0]!.map((h) => h.trim());
    const mapping = parseMapping(body, header);
    const matchBy = a.config().matchBy;
    const seen = new Set<string>();
    let created = 0;
    let matched = 0;
    let skipped = 0;
    const problems: Array<{ row: number; reason: string }> = [];
    rows.slice(1).forEach((row, i) => {
      const x = readRow(row, header, mapping);
      if (!x.matchable) {
        skipped++;
        if (problems.length < 20) problems.push({ row: i + 2, reason: x.problems[0] ?? "nothing to match by" });
        return;
      }
      if (x.problems.length && problems.length < 20) problems.push({ row: i + 2, reason: x.problems[0]! });
      const keys = matchBy
        .map((k) => [k, k === "email" ? x.ids.email : k === "phone" ? x.ids.phone : x.ids.userId] as [IdKind, string | null])
        .filter(([, v]) => v);
      const here = keys.some(([k, v]) => seen.has(`${k}:${v}`) || one("SELECT 1 FROM identifiers WHERE kind = ? AND value = ?", k, v!));
      if (here) matched++;
      else created++;
      for (const [k, v] of keys) seen.add(`${k}:${v}`);
    });
    return { rows: rows.length - 1, created, matched, skipped, problems };
  }

  /** Imports the file: every row matched or added, its traits set, and one event on each timeline. */
  function runImport(id: string, body: unknown) {
    const r = waiting(id);
    const rows = rowsOf(r);
    const header = rows[0]!.map((h) => h.trim());
    const mapping = parseMapping(body, header);
    const at = iso();
    let created = 0;
    let matched = 0;
    let skipped = 0;
    const changed = new Set<string>();
    tx(() => {
      rows.slice(1).forEach((row, i) => {
        const x = readRow(row, header, mapping);
        if (!x.matchable) return void skipped++;
        const res = a.resolve(x.ids, "import", at);
        if (res.created) created++;
        else matched++;
        a.setTraits(res.profile, x.traits, "import", at);
        a.addEvent(res.profile, {
          source: "import",
          type: "imported",
          at,
          text: `Imported from ${r.file}`,
          props: { file: r.file, import: id },
          external: `${id}:${i}`,
        });
        changed.add(res.profile);
        for (const m of res.merged) changed.add(m);
      });
      run(
        "UPDATE imports SET state = 'done', data = NULL, mapping = ?, created = ?, matched = ?, skipped = ?, done_at = ? WHERE id = ?",
        JSON.stringify(mapping),
        created,
        matched,
        skipped,
        iso(),
        id,
      );
    });
    a.hooks.changed(changed);
    return present(rowOf(id)!);
  }

  function discard(id: string) {
    waiting(id);
    run("UPDATE imports SET state = 'discarded', data = NULL WHERE id = ?", id);
  }

  function get(id: string) {
    const r = rowOf(id);
    if (!r) throw notFound("The import");
    return present(r);
  }

  return {
    upload,
    preview,
    run: runImport,
    discard,
    get,
    list: () => all<ImportRow>("SELECT * FROM imports WHERE state != 'discarded' ORDER BY uploaded_at DESC LIMIT 100").map(present),
  };
}

export type Imports = ReturnType<typeof createImports>;
