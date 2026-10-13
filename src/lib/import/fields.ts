import { normalizePhone } from "@/lib/phone";
import { cell, parseConsent, type ColumnMapping, type CrmFieldKey } from "./mapping";

export * from "./mapping";

export interface ImportRow {
  row_number: number;
  full_name: string | null;
  organization: string | null;
  phone_raw: string;
  phone_e164: string;
  email: string | null;
  city: string | null;
  state: string | null;
  country: string | null;
  source: string | null;
  notes: string | null;
  custom_fields: Record<string, string>;
  consent: "opted_in" | "opted_out" | null;
}

export type RowResult = { ok: true; row: ImportRow } | { ok: false; row_number: number; error: string; raw: Record<string, string> };

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Validate and normalise one spreadsheet row. `rowNumber` is the 1-based
 * spreadsheet row (header is row 1) so error reports match what users see.
 */
export function transformRow(
  headers: string[],
  values: unknown[],
  mapping: ColumnMapping,
  rowNumber: number,
  defaultCountry: string,
): RowResult {
  const raw: Record<string, string> = {};
  headers.forEach((h, i) => {
    const c = cell(values[i]);
    if (c !== null) raw[h] = c;
  });

  const out: Partial<Record<CrmFieldKey, string | null>> = {};
  const custom: Record<string, string> = {};
  headers.forEach((h, i) => {
    const target = mapping[h] ?? "ignore";
    const v = cell(values[i]);
    if (target === "ignore" || v === null) return;
    if (target === "custom") custom[h] = v;
    else if (out[target] == null) out[target] = v;
  });

  const phoneInput = values[headers.findIndex((h) => mapping[h] === "phone")];
  const phone = normalizePhone(phoneInput, defaultCountry);
  if (!phone.ok) return { ok: false, row_number: rowNumber, error: phone.error, raw };

  let email = out.email ?? null;
  if (email && !EMAIL_RE.test(email)) {
    return { ok: false, row_number: rowNumber, error: `Invalid email "${email}"`, raw };
  }
  email = email?.toLowerCase() ?? null;

  return {
    ok: true,
    row: {
      row_number: rowNumber,
      full_name: out.full_name ?? null,
      organization: out.organization ?? null,
      phone_raw: cell(phoneInput) ?? "",
      phone_e164: phone.e164,
      email,
      city: out.city ?? null,
      state: out.state ?? null,
      country: out.country ?? null,
      source: out.source ?? null,
      notes: out.notes ?? null,
      custom_fields: custom,
      consent: parseConsent(out.consent),
    },
  };
}

