import "server-only";
import { graphRequest } from "./graph";
import { requireConfig, type WaConfig } from "./config";
import type { MetaComponent } from "./templates";

export interface MetaTemplate {
  id: string;
  name: string;
  language: string;
  status: string;
  category: string;
  components: MetaComponent[];
  rejected_reason?: string;
  quality_score?: { score?: string };
}

const TEMPLATE_FIELDS = "id,name,language,status,category,components,rejected_reason,quality_score";
const auth = (cfg: WaConfig) => ({ token: cfg.token!, version: cfg.version });

/** POST /{WABA_ID}/message_templates */
export async function createTemplate(cfg: WaConfig, t: { name: string; language: string; category: string; components: MetaComponent[] }) {
  requireConfig(cfg, ["live", "token", "wabaId"]);
  return graphRequest<{ id: string; status: string; category: string }>("POST", `${cfg.wabaId}/message_templates`, {
    ...auth(cfg),
    json: t,
  });
}

/** POST /{TEMPLATE_ID} — only APPROVED, REJECTED or PAUSED templates can be edited. */
export async function editTemplate(cfg: WaConfig, metaId: string, components: MetaComponent[]) {
  requireConfig(cfg, ["live", "token"]);
  return graphRequest<{ success: boolean }>("POST", metaId, { ...auth(cfg), json: { components } });
}

export async function getTemplate(cfg: WaConfig, metaId: string) {
  requireConfig(cfg, ["token"]);
  return graphRequest<MetaTemplate>("GET", metaId, { ...auth(cfg), query: { fields: TEMPLATE_FIELDS } });
}

/** GET /{WABA_ID}/message_templates, following paging cursors. */
export async function listTemplates(cfg: WaConfig): Promise<MetaTemplate[]> {
  requireConfig(cfg, ["token", "wabaId"]);
  const out: MetaTemplate[] = [];
  let after: string | undefined;
  for (let page = 0; page < 50; page++) {
    const res = await graphRequest<{ data: MetaTemplate[]; paging?: { cursors?: { after?: string }; next?: string } }>(
      "GET",
      `${cfg.wabaId}/message_templates`,
      { ...auth(cfg), query: { fields: TEMPLATE_FIELDS, limit: "100", ...(after ? { after } : {}) } },
    );
    out.push(...res.data);
    if (!res.paging?.next || !res.paging.cursors?.after) break;
    after = res.paging.cursors.after;
  }
  return out;
}

/** DELETE /{WABA_ID}/message_templates?hsm_id=&name= (deletes only that language version). */
export async function deleteTemplate(cfg: WaConfig, metaId: string, name: string) {
  requireConfig(cfg, ["live", "token", "wabaId"]);
  return graphRequest<{ success: boolean }>("DELETE", `${cfg.wabaId}/message_templates`, {
    ...auth(cfg),
    query: { hsm_id: metaId, name },
  });
}

/** Resumable Upload API → header_handle for media template examples. */
export async function uploadHeaderSample(cfg: WaConfig, file: { bytes: ArrayBuffer; name: string; type: string }) {
  requireConfig(cfg, ["live", "token", "appId"]);
  const session = await graphRequest<{ id: string }>("POST", `${cfg.appId}/uploads`, {
    ...auth(cfg),
    query: { file_name: file.name, file_length: String(file.bytes.byteLength), file_type: file.type },
  });
  const res = await graphRequest<{ h: string }>("POST", session.id, {
    ...auth(cfg),
    headers: { Authorization: `OAuth ${cfg.token}`, file_offset: "0" },
    body: file.bytes,
    timeoutMs: 120_000,
  });
  return res.h;
}

/** POST /{PHONE_NUMBER_ID}/messages. Acceptance ≠ delivery: delivery comes via webhooks. */
export async function sendMessage(cfg: WaConfig, payload: object): Promise<{ wamid: string }> {
  requireConfig(cfg, ["live", "token", "phoneNumberId"]);
  const res = await graphRequest<{ messages?: { id: string }[] }>("POST", `${cfg.phoneNumberId}/messages`, {
    ...auth(cfg),
    json: payload,
  });
  const wamid = res.messages?.[0]?.id;
  if (!wamid) throw new Error("Meta accepted the request but returned no message id");
  return { wamid };
}

export interface PricingPoint {
  start: number;
  end: number;
  country?: string;
  pricing_type?: string;
  pricing_category?: string;
  volume?: number;
  cost?: number;
}

/** GET /{WABA_ID}?fields=pricing_analytics… — Meta's approximate charges for the WABA. */
export async function fetchPricingAnalytics(cfg: WaConfig, startUnix: number, endUnix: number): Promise<PricingPoint[]> {
  requireConfig(cfg, ["token", "wabaId"]);
  const field =
    `pricing_analytics.start(${startUnix}).end(${endUnix}).granularity(DAILY)` +
    `.dimensions(["PRICING_CATEGORY","PRICING_TYPE","COUNTRY"])`;
  const res = await graphRequest<{ pricing_analytics?: { data?: { data_points?: PricingPoint[] }[] } }>("GET", cfg.wabaId!, {
    ...auth(cfg),
    query: { fields: field },
  });
  return (res.pricing_analytics?.data ?? []).flatMap((d) => d.data_points ?? []);
}
