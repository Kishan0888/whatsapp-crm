import { describe, expect, it } from "vitest";
import { normalizePhone } from "@/lib/phone";
import { autoMap, parseConsent, splitSheet, transformRow } from "@/lib/import/fields";

describe("normalizePhone", () => {
  it.each([
    ["9810000001", "+919810000001"],
    ["98100 00001", "+919810000001"],
    ["+91-98100-00001", "+919810000001"],
    ["09810000001", "+919810000001"],
    ["919810000001", "+919810000001"],
    ["00919810000001", "+919810000001"],
    [919810000001, "+919810000001"],
    ["+1 415 555 2671", "+14155552671"],
  ])("%s → %s", (input, expected) => {
    const r = normalizePhone(input, "IN");
    expect(r).toMatchObject({ ok: true, e164: expected });
  });

  it.each([[""], ["12345"], ["abc"], [null], ["9.1981E+11"]])("rejects %s", (input) => {
    expect(normalizePhone(input, "IN").ok).toBe(false);
  });
});

describe("autoMap", () => {
  it("maps common headers once each and keeps unknown columns as custom", () => {
    expect(autoMap(["Hospital Name", "Mobile No", "Contact Person", "Email ID", "City", "Beds", "Phone"])).toEqual({
      "Hospital Name": "organization",
      "Mobile No": "phone",
      "Contact Person": "full_name",
      "Email ID": "email",
      City: "city",
      Beds: "custom",
      Phone: "custom",
    });
  });
});

describe("parseConsent", () => {
  it("requires explicit opt-out", () => {
    expect(parseConsent("Yes")).toBe("opted_in");
    expect(parseConsent("no")).toBeNull();
    expect(parseConsent("STOP")).toBe("opted_out");
    expect(parseConsent("")).toBeNull();
  });
});

describe("transformRow", () => {
  const headers = ["Name", "Phone", "Email", "Beds"];
  const mapping = autoMap(headers);

  it("normalises a valid row", () => {
    const r = transformRow(headers, ["Dr. A", "98100 00001", "A@X.COM", 50], mapping, 2, "IN");
    expect(r).toEqual({
      ok: true,
      row: expect.objectContaining({
        row_number: 2,
        full_name: "Dr. A",
        phone_e164: "+919810000001",
        email: "a@x.com",
        custom_fields: { Beds: "50" },
        consent: null,
      }),
    });
  });

  it("reports invalid phone and email with row numbers", () => {
    expect(transformRow(headers, ["A", "123", "", ""], mapping, 7, "IN")).toMatchObject({ ok: false, row_number: 7 });
    expect(transformRow(headers, ["A", "9810000001", "bad@", ""], mapping, 8, "IN")).toMatchObject({
      ok: false,
      error: expect.stringContaining("email"),
    });
  });
});

describe("splitSheet", () => {
  it("drops blank rows and de-duplicates headers", () => {
    expect(splitSheet([["Phone", "Phone", null], [null, "", null], ["1", "2", "3"]])).toEqual({
      headers: ["Phone", "Phone (2)", "Column 3"],
      data: [["1", "2", "3"]],
    });
  });
});
