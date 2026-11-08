import { describe, expect, it } from "vitest";
import { fold, normalEmail, normalPhone, normalUserId } from "./identity.ts";

describe("identifiers", () => {
  it("writes emails lowercased and trimmed", () => {
    expect(normalEmail(" Ayse.Kaya@Example.COM ")).toBe("ayse.kaya@example.com");
    expect(normalEmail("not an email")).toBeNull();
    expect(normalEmail(42)).toBeNull();
  });

  it("writes phone numbers in E.164, as Consent and İYS do", () => {
    for (const v of ["0555 111 22 33", "555 111 22 33", "905551112233", "+90 (555) 111-22-33", "0090 555 111 22 33"])
      expect(normalPhone(v, "TR")).toBe("+905551112233");
    expect(normalPhone("030 1234567", "DE")).toBe("+49301234567");
    expect(normalPhone("+49 30 1234567", "TR")).toBe("+49301234567");
    expect(normalPhone("(415) 555-0100", "US")).toBe("+14155550100");
    // Masked or too short numbers match nobody.
    expect(normalPhone("0505 *** ** 88", "TR")).toBeNull();
    expect(normalPhone("0555 111", "TR")).toBeNull();
  });

  it("takes user ids as sent, without spaces", () => {
    expect(normalUserId(" u-1042 ")).toBe("u-1042");
    expect(normalUserId(1042)).toBe("1042");
    expect(normalUserId("u 1042")).toBeNull();
  });

  it("folds case with the dotted and dotless i as one letter", () => {
    expect(fold("İzmir")).toBe(fold("IZMIR"));
    expect(fold("izmir")).toBe(fold("İZMİR"));
    expect(fold("Iğdır")).toBe("iğdir");
  });
});
