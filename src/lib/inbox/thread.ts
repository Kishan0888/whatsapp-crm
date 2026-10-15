import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { renderPreview } from "@/lib/whatsapp/templates";
import { valuesFromSendComponents, type SendComponent, type TemplateSnapshot } from "@/lib/whatsapp/send";

export interface ThreadItem {
  key: string;
  direction: "in" | "out";
  source: "inbound" | "inbox" | "automation" | "campaign";
  type: string;
  body: string;
  at: string;
  status: string;
  error: string | null;
  meta?: { url?: string; display_text?: string; template?: string; campaign?: string; sender?: string };
}

const MAX = 300;

/** Inbox messages plus campaign sends to this phone, oldest first. */
export async function loadThread(supabase: SupabaseClient, conversationId: string, phone: string): Promise<{ items: ThreadItem[]; truncated: boolean }> {
  const [msgs, camp] = await Promise.all([
    supabase
      .from("messages")
      .select("id, direction, type, body, payload, status, source, error_code, error_message, wa_timestamp, created_at, profiles:sent_by(full_name, email)")
      .eq("conversation_id", conversationId)
      .order("id", { ascending: false })
      .limit(MAX),
    supabase
      .from("campaign_recipients")
      .select("id, status, accepted_at, rendered_components, last_error_code, last_error, campaigns(name, template_snapshot)")
      .eq("phone_e164", phone)
      .not("wa_message_id", "is", null)
      .order("accepted_at", { ascending: false })
      .limit(50),
  ]);
  if (msgs.error) throw new Error(msgs.error.message);

  type M = { id: number; direction: "in" | "out"; type: string; body: string | null; payload: { url?: string; display_text?: string; template?: { name?: string } }; status: string; source: ThreadItem["source"]; error_code: string | null; error_message: string | null; wa_timestamp: string | null; created_at: string; profiles: { full_name: string | null; email: string | null } | null };
  const items: ThreadItem[] = ((msgs.data ?? []) as unknown as M[]).map((m) => ({
    key: `m${m.id}`,
    direction: m.direction,
    source: m.source,
    type: m.type,
    body: m.body ?? `[${m.type}]`,
    at: m.wa_timestamp ?? m.created_at,
    status: m.status,
    error: m.status === "failed" || m.type === "note" ? [m.error_code, m.error_message].filter(Boolean).join(": ") || null : m.status === "mock" ? m.error_message : null,
    meta: {
      url: m.payload?.url,
      display_text: m.payload?.display_text,
      template: m.payload?.template?.name,
      sender: m.profiles?.full_name ?? m.profiles?.email ?? undefined,
    },
  }));

  type C = { id: number; status: string; accepted_at: string | null; rendered_components: SendComponent[] | null; last_error_code: string | null; last_error: string | null; campaigns: { name: string; template_snapshot: TemplateSnapshot | null } | null };
  for (const c of (camp.data ?? []) as unknown as C[]) {
    const snap = c.campaigns?.template_snapshot;
    const body = snap ? renderPreview(snap.components, valuesFromSendComponents(c.rendered_components)).body : "[Template]";
    items.push({
      key: `c${c.id}`,
      direction: "out",
      source: "campaign",
      type: "template",
      body,
      at: c.accepted_at ?? new Date(0).toISOString(),
      status: c.status,
      error: c.status === "failed" ? [c.last_error_code, c.last_error].filter(Boolean).join(": ") : null,
      meta: { template: snap?.name, campaign: c.campaigns?.name },
    });
  }
  items.sort((a, b) => a.at.localeCompare(b.at) || a.key.localeCompare(b.key));
  return { items, truncated: (msgs.data?.length ?? 0) >= MAX };
}
