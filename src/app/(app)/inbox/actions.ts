"use server";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { assertRole, audit, CAN_EDIT_LEADS, getCurrentUser } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { createInboxDeps } from "@/lib/inbox/deps";
import { deliverOutbound, windowOpen } from "@/lib/inbox/handler";
import { toFail, type Result } from "@/lib/action-result";

const replySchema = z.object({
  conversationId: z.uuid(),
  body: z.string().trim().min(1, "Type a message").max(4096, "Messages are limited to 4096 characters"),
  /** Client-generated id so double-submits never send twice. */
  clientKey: z.uuid(),
});

export async function sendReply(input: z.input<typeof replySchema>): Promise<Result<{ status: string }>> {
  try {
    const { profile } = await assertRole(CAN_EDIT_LEADS);
    const p = replySchema.safeParse(input);
    if (!p.success) return { ok: false, error: p.error.issues[0].message };
    const supabase = await createClient();
    const { data: conv } = await supabase.from("conversations").select("id, last_inbound_at").eq("id", p.data.conversationId).maybeSingle();
    if (!conv) return { ok: false, error: "Conversation not found" };
    if (!windowOpen(conv.last_inbound_at, new Date()))
      return { ok: false, error: "The 24-hour reply window is closed. WhatsApp only allows approved templates until the contact messages you again." };

    const deps = await createInboxDeps(createAdminClient(), async () => {});
    const q = await deps.rpc<{ id: number; duplicate: boolean }>("inbox_queue_outbound", {
      p_conversation_id: conv.id,
      p_idempotency_key: `inbox:${p.data.clientKey}`,
      p_type: "text",
      p_body: p.data.body,
      p_payload: {},
      p_source: "inbox",
      p_sent_by: profile.id,
    });
    const result = q.duplicate ? "duplicate" : await deliverOutbound(deps, q.id);
    if (!q.duplicate) await audit("inbox.reply", "conversation", conv.id, { message_id: q.id, result });
    revalidatePath(`/inbox/${conv.id}`);
    if (result === "failed") return { ok: false, error: "WhatsApp rejected the message — see the error under it." };
    return { ok: true, data: { status: result }, message: result === "mock" ? "Saved (mock mode — not sent to WhatsApp)" : undefined };
  } catch (e) {
    return toFail(e);
  }
}

export async function markRead(conversationId: string): Promise<Result> {
  try {
    if (!(await getCurrentUser())) return { ok: false, error: "Not signed in" };
    const supabase = await createClient();
    const { error } = await supabase.rpc("inbox_mark_read", { p_conversation_id: z.uuid().parse(conversationId) });
    if (error) return { ok: false, error: error.message };
    return { ok: true, data: null };
  } catch (e) {
    return toFail(e);
  }
}

export async function cancelFlow(conversationId: string): Promise<Result> {
  try {
    await assertRole(CAN_EDIT_LEADS);
    const supabase = await createClient();
    const { error } = await supabase.rpc("inbox_cancel_flow", { p_conversation_id: z.uuid().parse(conversationId) });
    if (error) return { ok: false, error: error.message };
    revalidatePath(`/inbox/${conversationId}`);
    return { ok: true, data: null, message: "Flow cancelled" };
  } catch (e) {
    return toFail(e);
  }
}
