/**
 * Webhook signature validation and payload parsing (pure).
 * Signature: X-Hub-Signature-256 = "sha256=" + HMAC-SHA256(app secret, raw body).
 */
import { createHmac, timingSafeEqual } from "node:crypto";

export function verifySignature(rawBody: string, header: string | null, appSecret: string): boolean {
  if (!header?.startsWith("sha256=") || !appSecret) return false;
  const expected = createHmac("sha256", appSecret).update(rawBody, "utf8").digest();
  const given = Buffer.from(header.slice(7), "hex");
  return given.length === expected.length && timingSafeEqual(given, expected);
}

export type WebhookEvent =
  | {
      key: string;
      type: "status";
      wamid: string;
      status: string;
      timestamp: string;
      recipient: string;
      errorCode?: string;
      errorMessage?: string;
      pricing?: Record<string, unknown>;
    }
  | {
      key: string;
      type: "template_status";
      templateId: string;
      name: string;
      language: string;
      event: string;
      reason: string | null;
      detail?: string;
    }
  | { key: string; type: "inbound"; wamid: string; from: string; text: string };

interface RawStatus {
  id: string;
  status: string;
  timestamp: string;
  recipient_id: string;
  pricing?: Record<string, unknown>;
  errors?: { code: number | string; title?: string; message?: string; error_data?: { details?: string } }[];
}
interface RawMessage {
  id: string;
  from: string;
  type: string;
  text?: { body?: string };
  button?: { text?: string; payload?: string };
  interactive?: { button_reply?: { title?: string; id?: string } };
}
interface RawTemplateStatus {
  event: string;
  message_template_id: number | string;
  message_template_name: string;
  message_template_language: string;
  reason?: string | null;
  rejection_info?: { reason?: string; recommendation?: string };
  other_info?: { title?: string; description?: string };
}

/** Flatten a webhook POST body into events with idempotency keys. */
export function parseWebhook(body: unknown): WebhookEvent[] {
  const events: WebhookEvent[] = [];
  const b = body as { object?: string; entry?: { id?: string; time?: number; changes?: { field?: string; value?: unknown }[] }[] };
  if (b?.object !== "whatsapp_business_account" || !Array.isArray(b.entry)) return events;
  for (const entry of b.entry) {
    for (const change of entry.changes ?? []) {
      if (change.field === "messages") {
        const v = change.value as { statuses?: RawStatus[]; messages?: RawMessage[] };
        for (const s of v.statuses ?? []) {
          const err = s.errors?.[0];
          events.push({
            key: `status:${s.id}:${s.status}:${s.timestamp}`,
            type: "status",
            wamid: s.id,
            status: s.status,
            timestamp: s.timestamp,
            recipient: s.recipient_id,
            errorCode: err ? String(err.code) : undefined,
            errorMessage: err ? [err.message ?? err.title, err.error_data?.details].filter(Boolean).join(" — ") : undefined,
            pricing: s.pricing,
          });
        }
        for (const m of v.messages ?? []) {
          const text = m.text?.body ?? m.button?.payload ?? m.button?.text ?? m.interactive?.button_reply?.title ?? "";
          events.push({ key: `in:${m.id}`, type: "inbound", wamid: m.id, from: m.from, text });
        }
      } else if (change.field === "message_template_status_update") {
        const v = change.value as RawTemplateStatus;
        const detail = [v.rejection_info?.reason, v.rejection_info?.recommendation, v.other_info?.title, v.other_info?.description]
          .filter(Boolean)
          .join(" — ");
        events.push({
          key: `tpl:${v.message_template_id}:${v.event}:${entry.time ?? ""}`,
          type: "template_status",
          templateId: String(v.message_template_id),
          name: v.message_template_name,
          language: v.message_template_language,
          event: v.event,
          reason: v.reason ?? null,
          detail: detail || undefined,
        });
      }
    }
  }
  return events;
}

const OPT_OUT_PHRASES = ["stop", "unsubscribe", "stop promotions", "stop all", "opt out", "optout", "unsubscribe from promos", "stop messages"];

/** Inbound text or quick-reply that should permanently opt the sender out. */
export function isOptOutMessage(text: string): boolean {
  const t = text.toLowerCase().replace(/[^\p{L}\p{N} ]/gu, " ").replace(/\s+/g, " ").trim();
  return OPT_OUT_PHRASES.includes(t);
}
