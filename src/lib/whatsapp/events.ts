import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { normalizePhone } from "@/lib/phone";
import { isOptOutMessage, type WebhookEvent } from "./webhook";

const MAX_EVENT_ATTEMPTS = 20;

/**
 * Apply one webhook event. Returns true when done (processed or
 * permanently unprocessable), false to retry later (e.g. a status for a
 * message id the worker hasn't recorded yet).
 */
export async function applyEvent(admin: SupabaseClient, e: WebhookEvent): Promise<{ done: boolean; error?: string }> {
  if (e.type === "status") {
    if (!["sent", "delivered", "read", "failed"].includes(e.status)) return { done: true }; // e.g. "played"
    const { data, error } = await admin.rpc("apply_message_status", {
      p_wa_message_id: e.wamid,
      p_status: e.status,
      p_timestamp: new Date(Number(e.timestamp) * 1000).toISOString(),
      p_error_code: e.errorCode ?? null,
      p_error: e.errorMessage ?? null,
      p_pricing: e.pricing ?? null,
    });
    if (error) return { done: false, error: error.message };
    if (e.status === "failed" && e.errorCode === "131050") await optOut(admin, `+${e.recipient}`, "Meta 131050: user stopped marketing messages", "meta_131050");
    return data ? { done: true } : { done: false, error: "Unknown message id (not sent by this CRM, or not recorded yet)" };
  }

  if (e.type === "template_status") {
    const reason = [e.reason && e.reason !== "NONE" ? e.reason : null, e.detail].filter(Boolean).join(" — ") || null;
    const { error } = await admin
      .from("whatsapp_templates")
      .update({ status: e.event, rejected_reason: e.event === "REJECTED" ? reason : null, last_synced_at: new Date().toISOString() })
      .eq("meta_template_id", e.templateId);
    return error ? { done: false, error: error.message } : { done: true };
  }

  // Inbound message: only opt-out keywords are acted on (no inbox in this CRM).
  if (isOptOutMessage(e.text)) await optOut(admin, `+${e.from}`, `Replied "${e.text.slice(0, 50)}"`, "webhook_keyword");
  return { done: true };
}

async function optOut(admin: SupabaseClient, phone: string, reason: string, source: string) {
  const norm = normalizePhone(phone);
  if (!norm.ok) return;
  await admin.from("opt_outs").upsert({ phone_e164: norm.e164, reason, source }, { onConflict: "phone_e164", ignoreDuplicates: true });
  const { data: lead } = await admin.from("leads").select("id").eq("phone_e164", norm.e164).maybeSingle();
  await admin.from("consent_events").insert({ lead_id: lead?.id ?? null, phone_e164: norm.e164, status: "opted_out", source, evidence: reason });
}

/**
 * Store events idempotently (unique event_key) and process the new ones.
 * Duplicate deliveries from Meta's retries are ignored.
 */
export async function ingestEvents(admin: SupabaseClient, events: WebhookEvent[]) {
  if (!events.length) return { stored: 0, processed: 0 };
  const rows = events.map((e) => ({ event_key: e.key, event_type: e.type, payload: e }));
  const { data: inserted, error } = await admin
    .from("webhook_events")
    .upsert(rows, { onConflict: "event_key", ignoreDuplicates: true })
    .select("id, event_key");
  if (error) throw new Error(`Could not store webhook events: ${error.message}`);
  let processed = 0;
  for (const row of inserted ?? []) {
    const e = events.find((x) => x.key === row.event_key)!;
    if (await settle(admin, row.id, e, 0)) processed++;
  }
  return { stored: inserted?.length ?? 0, processed };
}

async function settle(admin: SupabaseClient, id: number, e: WebhookEvent, attempts: number) {
  const r = await applyEvent(admin, e).catch((err: unknown) => ({ done: false, error: err instanceof Error ? err.message : String(err) }));
  const giveUp = !r.done && attempts + 1 >= MAX_EVENT_ATTEMPTS;
  await admin
    .from("webhook_events")
    .update({
      attempts: attempts + 1,
      error: r.error ?? null,
      processed_at: r.done || giveUp ? new Date().toISOString() : null,
    })
    .eq("id", id);
  return r.done;
}

/** Retry events that couldn't be applied yet (called by the worker). */
export async function reprocessPendingEvents(admin: SupabaseClient, limit = 200) {
  const { data } = await admin
    .from("webhook_events")
    .select("id, payload, attempts")
    .is("processed_at", null)
    .lt("received_at", new Date(Date.now() - 5_000).toISOString())
    .order("received_at")
    .limit(limit);
  let done = 0;
  for (const row of data ?? []) if (await settle(admin, row.id, row.payload as WebhookEvent, row.attempts)) done++;
  return done;
}
