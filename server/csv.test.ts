import { describe, expect, it } from "vitest";
import { csvField, csvLine, parseCsv } from "./csv.ts";

describe("CSV", () => {
  it("reads what spreadsheets write: a BOM, semicolons, quotes and line breaks", () => {
    expect(parseCsv('﻿E-posta;Ad Soyad;Not\r\nmurat@example.com;"Kılıç; Murat";"Stand ""B12""\nhall 2"\r\n\r\n')).toEqual([
      ["E-posta", "Ad Soyad", "Not"],
      ["murat@example.com", "Kılıç; Murat", 'Stand "B12"\nhall 2'],
    ]);
    expect(parseCsv("a,b\n1,2")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
    expect(parseCsv("a\tb\n1\t2\n")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });

  it("writes fields a spreadsheet will not run as formulas", () => {
    expect(csvField("=1+1")).toBe("'=1+1");
    expect(csvField("@SUM(A1)")).toBe("'@SUM(A1)");
    expect(csvField('a "b", c')).toBe('"a ""b"", c"');
    expect(csvLine(["x", null, 3])).toBe("x,,3\r\n");
  });
});
