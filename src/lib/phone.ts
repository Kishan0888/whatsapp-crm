import { parsePhoneNumberFromString, getCountryCallingCode, type CountryCode } from "libphonenumber-js/max";

export type PhoneResult = { ok: true; e164: string; country?: string } | { ok: false; error: string };

/**
 * Normalise a phone number to E.164 (+<country><number>).
 * Accepts spreadsheet quirks: numeric cells, spaces/dashes, leading 0,
 * 00/011 international prefixes and country code without '+'.
 */
export function normalizePhone(input: unknown, defaultCountry: string = "IN"): PhoneResult {
  if (input === null || input === undefined) return { ok: false, error: "Phone is empty" };
  let raw = typeof input === "number" ? String(Math.trunc(input)) : String(input).trim();
  if (!raw) return { ok: false, error: "Phone is empty" };
  if (/e\+?\d+$/i.test(raw)) return { ok: false, error: `Phone "${raw}" looks like scientific notation — format the column as text` };

  // Keep only one leading '+' and digits.
  raw = raw.replace(/(?!^\+)[^\d]/g, "");
  if (raw.startsWith("00")) raw = "+" + raw.slice(2);
  else if (raw.startsWith("011") && defaultCountry === "US") raw = "+" + raw.slice(3);

  const country = defaultCountry.toUpperCase() as CountryCode;
  const tryParse = (v: string) => {
    const p = parsePhoneNumberFromString(v, country);
    return p && p.isValid() ? p : undefined;
  };

  let parsed = tryParse(raw);
  // "919810000001" — country code without '+'.
  if (!parsed && !raw.startsWith("+")) {
    let cc = "";
    try {
      cc = getCountryCallingCode(country);
    } catch {
      /* unknown country */
    }
    if (cc && raw.startsWith(cc)) parsed = tryParse("+" + raw);
  }
  if (!parsed) return { ok: false, error: `Invalid phone number "${String(input).trim()}"` };
  return { ok: true, e164: parsed.number, country: parsed.country };
}

export function isWhatsAppCapableType(e164: string): boolean {
  const p = parsePhoneNumberFromString(e164);
  const t = p?.getType();
  // Landlines can't receive WhatsApp; unknown types are allowed through.
  return t !== "FIXED_LINE";
}
