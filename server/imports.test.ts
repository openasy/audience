import { describe, expect, it } from "vitest";
import { startCore } from "./test-app.ts";

const FILE = `E-posta;Telefon;Ad Soyad;Şehir;Sektör;Not
murat.kilic@example.com;0505 111 22 88;Murat Kılıç;Ankara;Retail;Stand B12
okan@example.com;;Okan Tekin;İzmir;Construction;
;0505 *** ** 88;Masked;Bursa;;
nihan@example.com;0542 000 00 03;Nihan Er;Antalya;Tourism;
nihan@example.com;;Nihan Er;Antalya;Tourism;again in the same file
`;

describe("imports", () => {
  it("offers a mapping from the column names, and says what it would do", () => {
    const { imports, audience } = startCore();
    audience.ingest({ events: [{ type: "signed_up", person: { email: "okan@example.com", userId: "u-1042" }, traits: { plan: "Free" } }] });
    const up = imports.upload(FILE, "izmir-expo-2026.csv", "emre@example.com");
    expect(up).toMatchObject({ file: "izmir-expo-2026.csv", rows: 5, state: "uploaded" });
    expect(up.columns.map((c) => [c.name, c.sample, c.suggested])).toEqual([
      ["E-posta", "murat.kilic@example.com", "email"],
      ["Telefon", "0505 111 22 88", "phone"],
      ["Ad Soyad", "Murat Kılıç", "name"],
      ["Şehir", "Ankara", "trait:city"],
      ["Sektör", "Retail", "trait:sector"],
      ["Not", "Stand B12", "skip"],
    ]);
    const mapping = Object.fromEntries(up.columns.map((c) => [c.name, c.suggested]));
    expect(imports.preview(up.id, { mapping })).toEqual({
      rows: 5,
      created: 2,
      matched: 2,
      skipped: 1,
      problems: [{ row: 4, reason: "Telefon is not a phone number" }],
    });
    expect(() => imports.preview(up.id, { mapping: { ...mapping, "E-posta": "skip", Telefon: "skip" } })).toThrow(/Choose at least one column to match by/);
    expect(() => imports.preview(up.id, { mapping: { ...mapping, Not: "email" } })).toThrow(/two columns go to email/);
    expect(() => imports.preview(up.id, { mapping: { Nope: "email" } })).toThrow(/no column Nope/);
  });

  it("imports: new people, people matched, rows skipped, and an event on each timeline", () => {
    const { imports, audience } = startCore();
    const okan = audience.ingest({ events: [{ type: "signed_up", person: { email: "okan@example.com", userId: "u-1042" } }] }).results[0]!.profile;
    const up = imports.upload(FILE, "izmir-expo-2026.csv", "emre@example.com");
    const done = imports.run(up.id, { mapping: Object.fromEntries(up.columns.map((c) => [c.name, c.suggested])) });
    expect(done).toMatchObject({ state: "done", created: 2, matched: 2, skipped: 1 });
    expect(audience.person(okan)).toMatchObject({ name: "Okan Tekin", traits: { city: "İzmir", sector: "Construction" }, sources: ["import", "api"] });
    expect(audience.person(okan).events[0]).toMatchObject({ source: "import", type: "imported", text: "Imported from izmir-expo-2026.csv" });
    const murat = audience.people({ email: "murat.kilic@example.com" }, undefined, 1).items[0]!;
    expect(murat).toMatchObject({ phone: "+905051112288", firstSource: "import" });
    // The file is gone; it cannot be imported twice.
    expect(() => imports.run(up.id, { mapping: { "E-posta": "email" } })).toThrow(/imported or discarded already/);
    expect(audience.one<{ data: unknown }>("SELECT data FROM imports WHERE id = ?", up.id)!.data).toBeNull();
  });

  it("refuses files it cannot read", () => {
    const { imports } = startCore();
    expect(() => imports.upload("email\n", "a.csv", "x")).toThrow(/at least one row/);
    expect(() => imports.upload("email,email\na,b\n", "a.csv", "x")).toThrow(/same name/);
    expect(() => imports.upload("email,\na,b\n", "a.csv", "x")).toThrow(/needs a name/);
    const up = imports.upload("email\na@example.com\n", "a.csv", "x");
    imports.discard(up.id);
    expect(imports.list()).toEqual([]);
  });
});
