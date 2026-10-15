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
  | InboundEvent;

export interface InboundEvent {
  key: string;
  type: "inbound";
  wamid: string;
  from: string;
  /** Text, button label, interactive title or media caption ("" if none). */
  text: string;
  // Optional fields (absent on events stored before the inbox existed).
  msgType?: string;
  timestamp?: string;
  contextId?: string;
  profileName?: string;
  /** Quick-reply payload (template button) or interactive reply id. */
  buttonPayload?: string;
  media?: { id?: string; mime_type?: string; filename?: string };
}

interface RawStatus {
  id: string;
  status: string;
  timestamp: string;
  recipient_id: string;
  pricing?: Record<string, unknown>;
  errors?: { code: number | string; title?: string; message?: string; error_data?: { details?: string } }[];
}
interface RawMedia {
  id?: string;
  mime_type?: string;
  caption?: string;
  filename?: string;
}
interface RawMessage {
  id: string;
  from: string;
  type: string;
  timestamp?: string;
  context?: { id?: string };
  text?: { body?: string };
  button?: { text?: string; payload?: string };
  interactive?: { type?: string; button_reply?: { title?: string; id?: string }; list_reply?: { title?: string; id?: string } };
  image?: RawMedia;
  video?: RawMedia;
  document?: RawMedia;
  audio?: RawMedia;
  sticker?: RawMedia;
  reaction?: { emoji?: string };
  location?: { latitude?: number; longitude?: number; name?: string; address?: string };
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
        const v = change.value as {
          statuses?: RawStatus[];
          messages?: RawMessage[];
          contacts?: { wa_id?: string; profile?: { name?: string } }[];
        };
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
          const reply = m.interactive?.button_reply ?? m.interactive?.list_reply;
          const media = m.image ?? m.video ?? m.document ?? m.audio ?? m.sticker;
          const text =
            m.text?.body ??
            m.button?.text ??
            m.button?.payload ??
            reply?.title ??
            media?.caption ??
            (m.reaction?.emoji ? `Reacted ${m.reaction.emoji}` : undefined) ??
            (m.location ? [m.location.name, m.location.address].filter(Boolean).join(", ") || "Shared a location" : undefined) ??
            "";
          const profileName = v.contacts?.find((c) => c.wa_id === m.from)?.profile?.name ?? v.contacts?.[0]?.profile?.name;
          events.push({
            key: `in:${m.id}`,
            type: "inbound",
            wamid: m.id,
            from: m.from,
            text,
            msgType: m.type,
            timestamp: m.timestamp,
            contextId: m.context?.id,
            profileName,
            buttonPayload: m.button?.payload ?? reply?.id,
            media: media ? { id: media.id, mime_type: media.mime_type, filename: media.filename } : undefined,
          });
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
