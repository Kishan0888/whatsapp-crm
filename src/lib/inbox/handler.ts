/**
 * Inbound message handling + outbound delivery for the inbox and button
 * flows. All database access goes through `rpc` (security-definer SQL
 * functions from the inbox migration), which makes the whole path
 * testable against the real SQL with a mocked WhatsApp API.
 *
 * Interactive/automated replies are sent here, directly — never through
 * the campaign worker.
 */
import { normalizePhone } from "@/lib/phone";
import { sendMessage } from "@/lib/whatsapp/api";
import { MetaApiError } from "@/lib/whatsapp/graph";
import type { WaConfig } from "@/lib/whatsapp/config";
import { buildCtaUrlMessage, buildTemplateMessage, buildTextMessage, type SendComponent, type TemplateSnapshot } from "@/lib/whatsapp/send";
import { isOptOutMessage, type InboundEvent } from "@/lib/whatsapp/webhook";
import { decide, FLOW_TTL_MS, type FlowContext, type FlowState, type ReplySpec } from "./flows";

export type Rpc = <T>(fn: string, args: Record<string, unknown>) => Promise<T>;

export interface InboxDeps {
  rpc: Rpc;
  cfg: WaConfig;
  /** Meeting URL and optional growth-report template (loaded from settings). */
  flowSettings: () => Promise<Omit<FlowContext, "now">>;
  optOut: (phoneE164: string, reason: string, source: string) => Promise<void>;
  now?: () => Date;
}

interface InboundRecord {
  conversation_id: string;
  lead_id: string | null;
  message_id: number | null;
  inserted: boolean;
  flow: FlowState | null;
  flow_rev: number;
  last_inbound_at: string | null;
}

export const SERVICE_WINDOW_MS = 24 * 60 * 60 * 1000;

export function windowOpen(lastInboundAt: string | null | undefined, now: Date): boolean {
  return !!lastInboundAt && now.getTime() - new Date(lastInboundAt).getTime() < SERVICE_WINDOW_MS;
}

export function toE164(waId: string): string {
  const n = normalizePhone(`+${waId.replace(/^\+/, "")}`);
  return n.ok ? n.e164 : `+${waId.replace(/\D/g, "")}`;
}

function replyRow(r: ReplySpec, key: string) {
  switch (r.type) {
    case "text":
      return { idempotency_key: key, type: "text", body: r.body, payload: {} };
    case "cta_url":
      return { idempotency_key: key, type: "cta_url", body: r.body, payload: { display_text: r.displayText, url: r.url } };
    case "template":
      return { idempotency_key: key, type: "template", body: r.body, payload: { template: r.template, components: r.components } };
    case "note":
      return { idempotency_key: key, type: "note", body: r.body, payload: {}, status: "skipped", error_message: r.body };
  }
}

/** Store an inbound message, apply opt-out and flow logic, send any replies. Idempotent. */
export async function handleInbound(deps: InboxDeps, e: InboundEvent): Promise<{ action: string; sent: number }> {
  const now = deps.now?.() ?? new Date();
  const phone = toE164(e.from);
  const msgType = e.msgType ?? "text";
  const recordArgs = {
    p_phone: phone,
    p_wa_message_id: e.wamid,
    p_type: msgType,
    p_body: e.text || null,
    p_payload: { button_payload: e.buttonPayload ?? null, media: e.media ?? null },
    p_context_id: e.contextId ?? null,
    p_wa_timestamp: e.timestamp ? new Date(Number(e.timestamp) * 1000).toISOString() : now.toISOString(),
    p_profile_name: e.profileName ?? null,
  };
  let rec = await deps.rpc<InboundRecord>("inbox_record_inbound", recordArgs);

  // Opt-out keywords: permanent suppression; stop any running flow; no automated reply.
  if (["text", "button", "interactive"].includes(msgType) && isOptOutMessage(e.text)) {
    await deps.optOut(phone, `Replied "${e.text.slice(0, 50)}"`, "webhook_keyword");
    const f = rec.flow;
    if (f && f.last_input !== e.wamid && ["name", "hospital", "datetime"].includes(f.step)) {
      await deps.rpc("inbox_apply_flow", {
        p_conversation_id: rec.conversation_id, p_set_flow: true, p_expected_rev: rec.flow_rev,
        p_flow: { ...f, step: "cancelled", updated_at: now.toISOString(), last_input: e.wamid },
        p_trigger_wa_message_id: e.wamid, p_replies: [], p_details: null,
      });
    }
    return { action: "opt_out", sent: 0 };
  }

  const settings = await deps.flowSettings();
  let action = "none";
  for (let attempt = 0; attempt < 3; attempt++) {
    const d = decide(rec.flow, { wamid: e.wamid, msgType, text: e.text, buttonPayload: e.buttonPayload }, { ...settings, now });
    action = d.action;
    if (d.flow === undefined && d.replies.length === 0 && !d.details) break;
    const res = await deps.rpc<{ ok: boolean }>("inbox_apply_flow", {
      p_conversation_id: rec.conversation_id,
      p_set_flow: d.flow !== undefined,
      p_expected_rev: rec.flow_rev,
      p_flow: d.flow ?? null,
      p_trigger_wa_message_id: e.wamid,
      p_replies: d.replies.map((r, i) => replyRow(r, `auto:${e.wamid}:${i}`)),
      p_details: d.details ?? null,
    });
    if (res.ok) break;
    // Another message changed the flow concurrently: re-read and decide again.
    rec = await deps.rpc<InboundRecord>("inbox_record_inbound", recordArgs);
  }

  // Send whatever is still pending for this inbound message (also covers retries after a crash).
  const pending = await deps.rpc<number[]>("inbox_pending_replies", { p_trigger_wa_message_id: e.wamid });
  let sent = 0;
  for (const id of pending) if ((await deliverOutbound(deps, id)) === "sent") sent++;
  return { action, sent };
}

interface Claimed {
  claimed: boolean;
  id: number;
  type: string;
  body: string | null;
  payload: { display_text?: string; url?: string; template?: TemplateSnapshot; components?: SendComponent[] };
  phone: string;
  last_inbound_at: string | null;
}

export type DeliveryResult = "sent" | "mock" | "failed" | "not_claimed";

/**
 * Send one queued outbound message exactly once (pending → sending →
 * sent/failed/mock). Mock mode never calls Meta.
 */
export async function deliverOutbound(deps: InboxDeps, messageId: number): Promise<DeliveryResult> {
  const now = deps.now?.() ?? new Date();
  const m = await deps.rpc<Claimed>("inbox_claim_outbound", { p_message_id: messageId });
  if (!m.claimed) return "not_claimed";
  const finish = (status: string, wamid: string | null, code: string | null, error: string | null) =>
    deps.rpc("inbox_finish_outbound", { p_message_id: m.id, p_status: status, p_wa_message_id: wamid, p_error_code: code, p_error: error });

  if (m.type !== "template" && !windowOpen(m.last_inbound_at, now)) {
    await finish("failed", null, "window_closed", "The 24-hour customer service window is closed. Only approved templates can be sent.");
    return "failed";
  }
  if (deps.cfg.mode !== "live") {
    await finish("mock", null, null, "Mock mode: recorded but not sent to WhatsApp.");
    return "mock";
  }

  let payload: object;
  if (m.type === "text") payload = buildTextMessage(m.phone, m.body ?? "");
  else if (m.type === "cta_url") payload = buildCtaUrlMessage(m.phone, m.body ?? "", m.payload.display_text ?? "", m.payload.url ?? "");
  else if (m.type === "template" && m.payload.template) payload = buildTemplateMessage(m.phone, m.payload.template, m.payload.components ?? []);
  else {
    await finish("failed", null, "unsupported", `Unsupported outbound type ${m.type}`);
    return "failed";
  }

  try {
    const { wamid } = await sendMessage(deps.cfg, payload);
    await finish("sent", wamid, null, null);
    return "sent";
  } catch (err) {
    const code = err instanceof MetaApiError ? err.code : "error";
    const msg = err instanceof Error ? `${err.message}${err instanceof MetaApiError && err.details ? ` — ${err.details}` : ""}` : String(err);
    await finish("failed", null, code, msg);
    return "failed";
  }
}

/** Flow TTL re-exported for UI badges. */
export { FLOW_TTL_MS };
