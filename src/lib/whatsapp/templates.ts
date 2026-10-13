/**
 * Template model helpers shared by client and server: Meta component
 * format, draft editing, validation (limits from Meta's components
 * reference), variable discovery and preview rendering.
 */

export type HeaderFormat = "NONE" | "TEXT" | "IMAGE" | "VIDEO" | "DOCUMENT";

export interface MetaButton {
  type: string;
  text?: string;
  url?: string;
  phone_number?: string;
  example?: string[] | string;
}

export interface MetaComponent {
  type: string;
  format?: string;
  text?: string;
  example?: {
    header_text?: string[];
    header_handle?: string[];
    body_text?: string[][];
    header_text_named_params?: { param_name: string; example: string }[];
    body_text_named_params?: { param_name: string; example: string }[];
  };
  buttons?: MetaButton[];
}

export type DraftButton =
  | { type: "QUICK_REPLY"; text: string }
  | { type: "URL"; text: string; url: string; example: string }
  | { type: "PHONE_NUMBER"; text: string; phone: string };

export interface TemplateDraft {
  name: string;
  language: string;
  category: "MARKETING" | "UTILITY";
  header: { format: HeaderFormat; text: string; example: string; handle: string };
  body: { text: string; examples: string[] };
  footer: string;
  buttons: DraftButton[];
}

export const LANGUAGES: [string, string][] = [
  ["en", "English"], ["en_US", "English (US)"], ["en_GB", "English (UK)"], ["hi", "Hindi"], ["mr", "Marathi"],
  ["gu", "Gujarati"], ["bn", "Bengali"], ["ta", "Tamil"], ["te", "Telugu"], ["kn", "Kannada"], ["ml", "Malayalam"],
  ["pa", "Punjabi"], ["ur", "Urdu"], ["ar", "Arabic"],
];

export const emptyDraft = (): TemplateDraft => ({
  name: "",
  language: "en",
  category: "MARKETING",
  header: { format: "NONE", text: "", example: "", handle: "" },
  body: { text: "", examples: [] },
  footer: "",
  buttons: [],
});

const VAR_RE = /\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g;

/** Variable names in order of first appearance; numeric names sorted numerically. */
export function extractVars(text: string | undefined): string[] {
  if (!text) return [];
  const seen: string[] = [];
  for (const m of text.matchAll(VAR_RE)) if (!seen.includes(m[1])) seen.push(m[1]);
  return seen.every((v) => /^\d+$/.test(v)) ? seen.sort((a, b) => Number(a) - Number(b)) : seen;
}

const isSequential = (vars: string[]) => vars.every((v, i) => v === String(i + 1));

export interface Validation {
  errors: string[];
  warnings: string[];
}

/** Validate a draft before submission to Meta. */
export function validateDraft(d: TemplateDraft): Validation {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (!/^[a-z0-9_]+$/.test(d.name)) errors.push("Name may only contain lowercase letters, numbers and underscores.");
  if (d.name.length > 512) errors.push("Name is limited to 512 characters.");
  if (!d.language) errors.push("Choose a language.");

  // Header
  if (d.header.format === "TEXT") {
    const hv = extractVars(d.header.text);
    if (!d.header.text.trim()) errors.push("Header text is empty.");
    if (d.header.text.length > 60) errors.push("Header text is limited to 60 characters.");
    if (hv.length > 1) errors.push("Header text supports only one variable.");
    if (hv.length === 1 && hv[0] !== "1") errors.push("Header variable must be {{1}}.");
    if (hv.length === 1 && !d.header.example.trim()) errors.push("Add a sample value for the header variable.");
  } else if (d.header.format !== "NONE" && !d.header.handle) {
    errors.push(`Upload a sample ${d.header.format.toLowerCase()} for the header (Meta requires an example).`);
  }

  // Body
  const bv = extractVars(d.body.text);
  if (!d.body.text.trim()) errors.push("Body text is required.");
  if (d.body.text.length > 1024) errors.push("Body is limited to 1024 characters.");
  if (bv.length && !isSequential(bv)) errors.push("Body variables must be numbered {{1}}, {{2}}, … without gaps.");
  bv.forEach((_, i) => {
    if (!d.body.examples[i]?.trim()) errors.push(`Add a sample value for body variable {{${i + 1}}}.`);
  });
  const trimmed = d.body.text.trim();
  if (bv.length && (/^\{\{/.test(trimmed) || /\}\}[.!?]?$/.test(trimmed)))
    warnings.push("Body starts or ends with a variable — Meta often rejects this. Add surrounding text.");

  // Footer
  if (d.footer.length > 60) errors.push("Footer is limited to 60 characters.");
  if (extractVars(d.footer).length) errors.push("Footer can't contain variables.");

  // Buttons
  const count = (t: DraftButton["type"]) => d.buttons.filter((b) => b.type === t).length;
  if (d.buttons.length > 10) errors.push("At most 10 buttons.");
  if (count("URL") > 2) errors.push("At most 2 URL buttons.");
  if (count("PHONE_NUMBER") > 1) errors.push("At most 1 phone button.");
  const qr = d.buttons.map((b) => b.type === "QUICK_REPLY");
  const firstQr = qr.indexOf(true);
  const lastQr = qr.lastIndexOf(true);
  if (firstQr !== -1 && qr.slice(firstQr, lastQr + 1).includes(false))
    errors.push("Quick-reply buttons must be grouped together (before or after the other buttons).");
  d.buttons.forEach((b, i) => {
    const n = `Button ${i + 1}`;
    if (!b.text.trim()) errors.push(`${n}: label is required.`);
    if (b.text.length > 25) errors.push(`${n}: label is limited to 25 characters.`);
    if (b.type === "URL") {
      const uv = extractVars(b.url);
      if (!/^https?:\/\/\S+$/.test(b.url.replace(VAR_RE, "x"))) errors.push(`${n}: enter a valid URL.`);
      if (b.url.length > 2000) errors.push(`${n}: URL is limited to 2000 characters.`);
      if (uv.length > 1 || (uv.length === 1 && (uv[0] !== "1" || !/\{\{\s*1\s*\}\}$/.test(b.url))))
        errors.push(`${n}: only one variable, {{1}}, at the end of the URL.`);
      if (uv.length === 1 && !b.example.trim()) errors.push(`${n}: add a sample value for the URL variable.`);
    }
    if (b.type === "PHONE_NUMBER" && !/^\+?\d{6,20}$/.test(b.phone.replace(/[\s-]/g, "")))
      errors.push(`${n}: enter the phone number with country code.`);
  });
  if (d.buttons.length > 3) warnings.push("Templates with 4+ buttons can't be viewed on WhatsApp desktop.");
  return { errors, warnings };
}

/** Draft → Meta `components` (create/edit payload). */
export function buildComponents(d: TemplateDraft): MetaComponent[] {
  const out: MetaComponent[] = [];
  if (d.header.format === "TEXT") {
    const c: MetaComponent = { type: "HEADER", format: "TEXT", text: d.header.text };
    if (extractVars(d.header.text).length) c.example = { header_text: [d.header.example] };
    out.push(c);
  } else if (d.header.format !== "NONE") {
    const c: MetaComponent = { type: "HEADER", format: d.header.format };
    if (d.header.handle) c.example = { header_handle: [d.header.handle] };
    out.push(c);
  }
  const body: MetaComponent = { type: "BODY", text: d.body.text };
  const bv = extractVars(d.body.text);
  if (bv.length) body.example = { body_text: [bv.map((_, i) => d.body.examples[i] ?? "")] };
  out.push(body);
  if (d.footer.trim()) out.push({ type: "FOOTER", text: d.footer });
  if (d.buttons.length) {
    out.push({
      type: "BUTTONS",
      buttons: d.buttons.map((b) => {
        if (b.type === "URL")
          return extractVars(b.url).length
            ? { type: "URL", text: b.text, url: b.url, example: [b.example] }
            : { type: "URL", text: b.text, url: b.url };
        if (b.type === "PHONE_NUMBER") return { type: "PHONE_NUMBER", text: b.text, phone_number: b.phone.replace(/[\s-]/g, "") };
        return { type: "QUICK_REPLY", text: b.text };
      }),
    });
  }
  return out;
}

const find = (cs: MetaComponent[], t: string) => cs.find((c) => c.type?.toUpperCase() === t);

/** Meta components → editable draft. Returns null for templates the editor can't represent. */
export function draftFromTemplate(t: { name: string; language: string; category: string; components: MetaComponent[] }): TemplateDraft | null {
  const cs = t.components ?? [];
  const d = emptyDraft();
  d.name = t.name;
  d.language = t.language;
  if (t.category !== "MARKETING" && t.category !== "UTILITY") return null;
  d.category = t.category;
  const h = find(cs, "HEADER");
  if (h) {
    const f = (h.format ?? "").toUpperCase();
    if (!["TEXT", "IMAGE", "VIDEO", "DOCUMENT"].includes(f)) return null;
    d.header = {
      format: f as HeaderFormat,
      text: h.text ?? "",
      example: h.example?.header_text?.[0] ?? "",
      handle: h.example?.header_handle?.[0] ?? "",
    };
  }
  const b = find(cs, "BODY");
  if (b) {
    if (extractVars(b.text).some((v) => !/^\d+$/.test(v))) return null; // named params: not editable here
    d.body = { text: b.text ?? "", examples: b.example?.body_text?.[0] ?? [] };
  }
  d.footer = find(cs, "FOOTER")?.text ?? "";
  for (const btn of find(cs, "BUTTONS")?.buttons ?? []) {
    const type = btn.type.toUpperCase();
    if (type === "QUICK_REPLY") d.buttons.push({ type, text: btn.text ?? "" });
    else if (type === "URL")
      d.buttons.push({ type, text: btn.text ?? "", url: btn.url ?? "", example: Array.isArray(btn.example) ? (btn.example[0] ?? "") : (btn.example ?? "") });
    else if (type === "PHONE_NUMBER") d.buttons.push({ type, text: btn.text ?? "", phone: btn.phone_number ?? "" });
    else return null;
  }
  return d;
}

export interface TemplateVariable {
  /** Mapping key: header.<name> | body.<name> | button.<index>.<name> | button.<index>.coupon */
  key: string;
  label: string;
  component: "header" | "body" | "button";
  name: string;
  buttonIndex?: number;
  kind: "text" | "coupon";
  example?: string;
}

export interface TemplateShape {
  variables: TemplateVariable[];
  mediaHeader: "IMAGE" | "VIDEO" | "DOCUMENT" | null;
  /** Non-null when the CRM can't send this template in campaigns. */
  unsupported: string | null;
}

/** What a campaign must supply to send this template. */
export function templateShape(components: MetaComponent[]): TemplateShape {
  const variables: TemplateVariable[] = [];
  let mediaHeader: TemplateShape["mediaHeader"] = null;
  let unsupported: string | null = null;
  const h = find(components, "HEADER");
  if (h) {
    const f = (h.format ?? "").toUpperCase();
    if (f === "TEXT") {
      const named = h.example?.header_text_named_params ?? [];
      extractVars(h.text).forEach((name, i) =>
        variables.push({
          key: `header.${name}`, label: `Header {{${name}}}`, component: "header", name, kind: "text",
          example: named.find((p) => p.param_name === name)?.example ?? h.example?.header_text?.[i],
        }),
      );
    } else if (f === "IMAGE" || f === "VIDEO" || f === "DOCUMENT") mediaHeader = f;
    else unsupported = `${f || "Unknown"} headers are not supported for campaigns.`;
  }
  const b = find(components, "BODY");
  const named = b?.example?.body_text_named_params ?? [];
  extractVars(b?.text).forEach((name, i) =>
    variables.push({
      key: `body.${name}`, label: `Body {{${name}}}`, component: "body", name, kind: "text",
      example: named.find((p) => p.param_name === name)?.example ?? b?.example?.body_text?.[0]?.[i],
    }),
  );
  (find(components, "BUTTONS")?.buttons ?? []).forEach((btn, i) => {
    const type = btn.type.toUpperCase();
    if (type === "URL") {
      extractVars(btn.url).forEach((name) =>
        variables.push({
          key: `button.${i}.${name}`, label: `URL button "${btn.text}" {{${name}}}`, component: "button", name,
          buttonIndex: i, kind: "text", example: Array.isArray(btn.example) ? btn.example[0] : btn.example,
        }),
      );
    } else if (type === "COPY_CODE") {
      variables.push({ key: `button.${i}.coupon`, label: "Coupon code (copy button)", component: "button", name: "coupon", buttonIndex: i, kind: "coupon" });
    } else if (type !== "QUICK_REPLY" && type !== "PHONE_NUMBER") {
      unsupported = `${type} buttons are not supported for campaigns.`;
    }
  });
  return { variables, mediaHeader, unsupported };
}

export interface Preview {
  header: { type: "text"; text: string } | { type: "media"; format: string } | null;
  body: string;
  footer: string;
  buttons: { type: string; text: string }[];
}

/** Render a WhatsApp-style preview, substituting values by mapping key (or showing the placeholder). */
export function renderPreview(components: MetaComponent[], values: Record<string, string> = {}): Preview {
  const sub = (text: string | undefined, prefix: string) =>
    (text ?? "").replace(VAR_RE, (_, name: string) => values[`${prefix}.${name}`] || `{{${name}}}`);
  const h = find(components, "HEADER");
  let header: Preview["header"] = null;
  if (h) {
    const f = (h.format ?? "").toUpperCase();
    header = f === "TEXT" ? { type: "text", text: sub(h.text, "header") } : { type: "media", format: f };
  }
  return {
    header,
    body: sub(find(components, "BODY")?.text, "body"),
    footer: find(components, "FOOTER")?.text ?? "",
    buttons: (find(components, "BUTTONS")?.buttons ?? []).map((b) => ({ type: b.type.toUpperCase(), text: b.text ?? "Copy code" })),
  };
}
