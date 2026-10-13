// Client-safe import helpers (no phone metadata).

export const MAX_ROWS = 50_000;
export const CHUNK_SIZE = 500;

export const CRM_FIELDS = [
  { key: "full_name", label: "Contact name" },
  { key: "organization", label: "Organization / Hospital / Brand" },
  { key: "phone", label: "Phone (required)" },
  { key: "email", label: "Email" },
  { key: "city", label: "City" },
  { key: "state", label: "State" },
  { key: "country", label: "Country" },
  { key: "source", label: "Source" },
  { key: "notes", label: "Notes" },
  { key: "consent", label: "WhatsApp opt-in status" },
] as const;

export type CrmFieldKey = (typeof CRM_FIELDS)[number]["key"];
/** Mapping target for a column: a CRM field, a custom field, or ignored. */
export type MappingTarget = CrmFieldKey | "custom" | "ignore";
export type ColumnMapping = Record<string, MappingTarget>;

const SYNONYMS: Record<CrmFieldKey, string[]> = {
  full_name: ["name", "full name", "contact name", "contact person", "person", "owner", "doctor", "doctor name", "contact"],
  organization: ["organization", "organisation", "company", "hospital", "hospital name", "brand", "business", "clinic", "firm", "company name"],
  phone: ["phone", "mobile", "mobile number", "phone number", "whatsapp", "whatsapp number", "contact number", "number", "mob", "cell", "mobile no", "phone no"],
  email: ["email", "e-mail", "email id", "mail", "email address"],
  city: ["city", "town", "district", "location"],
  state: ["state", "province", "region"],
  country: ["country"],
  source: ["source", "lead source", "channel"],
  notes: ["notes", "note", "remarks", "remark", "comments", "comment", "description"],
  consent: ["opt in", "optin", "opt-in", "whatsapp opt in", "consent", "whatsapp consent", "marketing consent", "subscribed"],
};

const norm = (s: string) => s.toLowerCase().replace(/[_\-.]+/g, " ").replace(/\s+/g, " ").trim();

/** Guess a mapping from spreadsheet headers. Each CRM field is used at most once. */
export function autoMap(headers: string[]): ColumnMapping {
  const used = new Set<CrmFieldKey>();
  const mapping: ColumnMapping = {};
  for (const h of headers) {
    const n = norm(h);
    const hit = (Object.keys(SYNONYMS) as CrmFieldKey[]).find((k) => !used.has(k) && SYNONYMS[k].includes(n));
    if (hit) {
      used.add(hit);
      mapping[h] = hit;
    } else {
      mapping[h] = n ? "custom" : "ignore";
    }
  }
  return mapping;
}

export function parseConsent(v: unknown): "opted_in" | "opted_out" | null {
  if (v === null || v === undefined) return null;
  const s = norm(String(v));
  if (["yes", "y", "true", "1", "opted in", "opt in", "optin", "subscribed", "consented"].includes(s)) return "opted_in";
  // Opt-out must be explicit. A plain "no" means consent wasn't given, not an opt-out.
  if (["opted out", "opt out", "optout", "stop", "unsubscribe", "unsubscribed", "dnd"].includes(s)) return "opted_out";
  return null;
}

export const cell = (v: unknown): string | null => {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v.toISOString();
  const s = String(v).trim();
  return s ? s.slice(0, 2000) : null;
};

/** Drop blank rows; returns [headers, dataRows] with header names made unique. */
export function splitSheet(rows: unknown[][]): { headers: string[]; data: unknown[][] } {
  const nonEmpty = rows.filter((r) => r.some((c) => cell(c) !== null));
  if (nonEmpty.length === 0) return { headers: [], data: [] };
  const seen = new Map<string, number>();
  const headers = nonEmpty[0].map((h, i) => {
    const base = cell(h) ?? `Column ${i + 1}`;
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    return n ? `${base} (${n + 1})` : base;
  });
  return { headers, data: nonEmpty.slice(1) };
}
