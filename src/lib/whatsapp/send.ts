/**
 * Build Cloud API template-message payloads from a template, the
 * campaign's variable mapping and a lead. Pure: no I/O.
 */
import { templateShape, type MetaComponent } from "./templates";

export interface VarSource {
  source: "field" | "static";
  /** Lead field key (see LEAD_FIELDS, or custom.<column>) or static text. */
  value: string;
  /** Used when the lead field is empty. */
  fallback?: string;
}
export type VariableMapping = Record<string, VarSource>;

export interface HeaderMedia {
  type: "image" | "video" | "document";
  link: string;
  filename?: string;
}

export const LEAD_FIELDS: { key: string; label: string }[] = [
  { key: "first_name", label: "First name" },
  { key: "full_name", label: "Full name" },
  { key: "organization", label: "Organization" },
  { key: "city", label: "City" },
  { key: "state", label: "State" },
  { key: "country", label: "Country" },
  { key: "email", label: "Email" },
  { key: "phone", label: "Phone" },
];

export interface LeadForRender {
  full_name: string | null;
  organization: string | null;
  city: string | null;
  state: string | null;
  country: string | null;
  email: string | null;
  phone_e164: string | null;
  custom_fields: Record<string, unknown> | null;
}

/** Meta rejects text params with newlines/tabs or more than 4 consecutive spaces. */
export function cleanParam(s: string): string {
  return s.replace(/[\r\n\t]+/g, " ").replace(/ {2,}/g, " ").trim().slice(0, 1024);
}

export function resolveVar(src: VarSource | undefined, lead: LeadForRender): string | null {
  if (!src) return null;
  let v: string | null = null;
  if (src.source === "static") v = src.value;
  else if (src.value === "first_name") v = lead.full_name?.trim().split(/\s+/)[0] ?? null;
  else if (src.value === "phone") v = lead.phone_e164;
  else if (src.value.startsWith("custom.")) {
    const raw = lead.custom_fields?.[src.value.slice(7)];
    v = raw === null || raw === undefined ? null : String(raw);
  } else v = (lead as unknown as Record<string, string | null>)[src.value] ?? null;
  const cleaned = v ? cleanParam(v) : "";
  if (cleaned) return cleaned;
  const fb = src.fallback ? cleanParam(src.fallback) : "";
  return fb || null;
}

/** Problems with a campaign's mapping, checked before saving/launching. */
export function validateMapping(components: MetaComponent[], mapping: VariableMapping, media: HeaderMedia | null): string[] {
  const shape = templateShape(components);
  const errors: string[] = [];
  if (shape.unsupported) errors.push(shape.unsupported);
  for (const v of shape.variables) {
    const m = mapping[v.key];
    if (!m || !m.value.trim()) errors.push(`${v.label}: choose a value.`);
    else if (m.source === "field" && !m.fallback?.trim())
      errors.push(`${v.label}: add a fallback for leads where this field is empty.`);
  }
  if (shape.mediaHeader) {
    if (!media?.link) errors.push(`This template needs a ${shape.mediaHeader.toLowerCase()} header: add a public HTTPS link.`);
    else if (!/^https:\/\/\S+$/.test(media.link)) errors.push("Header media link must be a public https:// URL.");
    else if (media.type !== shape.mediaHeader.toLowerCase()) errors.push(`Header media must be a ${shape.mediaHeader.toLowerCase()}.`);
  }
  return errors;
}

type TextParam = { type: "text"; text: string; parameter_name?: string };
export type SendComponent =
  | { type: "header"; parameters: (TextParam | { type: "image" | "video" | "document"; [k: string]: unknown })[] }
  | { type: "body"; parameters: TextParam[] }
  | { type: "button"; sub_type: "url"; index: number; parameters: TextParam[] }
  | { type: "button"; sub_type: "copy_code"; index: number; parameters: { type: "coupon_code"; coupon_code: string }[] };

export type BuildResult =
  | { ok: true; components: SendComponent[]; values: Record<string, string> }
  | { ok: false; error: string };

export function buildSendComponents(
  components: MetaComponent[],
  mapping: VariableMapping,
  lead: LeadForRender,
  media: HeaderMedia | null,
): BuildResult {
  const shape = templateShape(components);
  if (shape.unsupported) return { ok: false, error: shape.unsupported };
  const values: Record<string, string> = {};
  for (const v of shape.variables) {
    const val = resolveVar(mapping[v.key], lead);
    if (!val) return { ok: false, error: `No value for ${v.label}` };
    values[v.key] = v.kind === "coupon" ? val.slice(0, 20) : val;
  }
  const param = (name: string, text: string): TextParam =>
    /^\d+$/.test(name) ? { type: "text", text } : { type: "text", parameter_name: name, text };

  const out: SendComponent[] = [];
  const headerVars = shape.variables.filter((v) => v.component === "header");
  if (shape.mediaHeader) {
    if (!media?.link) return { ok: false, error: "Missing header media link" };
    const obj: Record<string, string> = { link: media.link };
    if (media.type === "document" && media.filename) obj.filename = media.filename;
    out.push({ type: "header", parameters: [{ type: media.type, [media.type]: obj }] });
  } else if (headerVars.length) {
    out.push({ type: "header", parameters: headerVars.map((v) => param(v.name, values[v.key])) });
  }
  const bodyVars = shape.variables.filter((v) => v.component === "body");
  if (bodyVars.length) out.push({ type: "body", parameters: bodyVars.map((v) => param(v.name, values[v.key])) });
  for (const v of shape.variables.filter((x) => x.component === "button")) {
    if (v.kind === "coupon")
      out.push({ type: "button", sub_type: "copy_code", index: v.buttonIndex!, parameters: [{ type: "coupon_code", coupon_code: values[v.key] }] });
    else out.push({ type: "button", sub_type: "url", index: v.buttonIndex!, parameters: [param(v.name, values[v.key])] });
  }
  return { ok: true, components: out, values };
}

export interface TemplateSnapshot {
  name: string;
  language: string;
  category: string;
  components: MetaComponent[];
}

export function buildTemplateMessage(toE164: string, t: TemplateSnapshot, components: SendComponent[]) {
  return {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to: toE164.replace(/^\+/, ""),
    type: "template",
    template: {
      name: t.name,
      language: { code: t.language },
      ...(components.length ? { components } : {}),
    },
  };
}

/** Free-form text (only inside the 24-hour customer service window). */
export function buildTextMessage(toE164: string, body: string) {
  return {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to: toE164.replace(/^\+/, ""),
    type: "text",
    text: { body: body.slice(0, 4096), preview_url: /https?:\/\//.test(body) },
  };
}

/** Interactive message with one URL button (only inside the customer service window). */
export function buildCtaUrlMessage(toE164: string, body: string, displayText: string, url: string) {
  return {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to: toE164.replace(/^\+/, ""),
    type: "interactive",
    interactive: {
      type: "cta_url",
      body: { text: body.slice(0, 1024) },
      action: { name: "cta_url", parameters: { display_text: displayText.slice(0, 20), url } },
    },
  };
}

/** Inverse of buildSendComponents: mapping-key → value, for rendering sent templates. */
export function valuesFromSendComponents(components: SendComponent[] | null | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const c of components ?? []) {
    if (c.type === "header" || c.type === "body") {
      c.parameters.forEach((p, i) => {
        if (p.type === "text") out[`${c.type}.${(p as TextParam).parameter_name ?? i + 1}`] = (p as TextParam).text;
      });
    } else if (c.type === "button" && c.sub_type === "url") {
      c.parameters.forEach((p, i) => (out[`button.${c.index}.${p.parameter_name ?? i + 1}`] = p.text));
    }
  }
  return out;
}
