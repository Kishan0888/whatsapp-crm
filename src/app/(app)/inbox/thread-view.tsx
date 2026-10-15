import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, ExternalLink, Megaphone, Bot } from "lucide-react";
import { CAN_EDIT_LEADS } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { whatsappMode } from "@/lib/env";
import { loadThread } from "@/lib/inbox/thread";
import { windowOpen } from "@/lib/inbox/handler";
import { liveFlow, type FlowState } from "@/lib/inbox/flows";
import { Badge } from "@/components/ui/badge";
import { ConsentBadge } from "@/components/consent-badge";
import { MessageStatus } from "@/components/message-status";
import { AutoRefresh } from "@/components/auto-refresh";
import { cn } from "@/lib/utils";
import type { AppRole, ConsentStatus } from "@/lib/types";
import { displayName, type ConversationRow } from "./conversation-list";
import { CancelFlowButton, Composer, MarkRead, ScrollToBottom } from "./thread-parts";

const STEP_LABEL: Record<string, string> = { name: "waiting for representative name", hospital: "waiting for hospital name", datetime: "waiting for preferred date/time" };

const time = (iso: string) => new Intl.DateTimeFormat("en-IN", { dateStyle: "medium", timeStyle: "short" }).format(new Date(iso));

/** Formats *bold*, _italic_ and ~strike~ like WhatsApp. */
function Formatted({ text }: { text: string }) {
  return (
    <>
      {text.split(/(\*[^*\n]+\*|_[^_\n]+_|~[^~\n]+~)/g).map((p, i) =>
        /^\*.+\*$/.test(p) ? <strong key={i}>{p.slice(1, -1)}</strong>
        : /^_.+_$/.test(p) ? <em key={i}>{p.slice(1, -1)}</em>
        : /^~.+~$/.test(p) ? <s key={i}>{p.slice(1, -1)}</s>
        : <span key={i}>{p}</span>,
      )}
    </>
  );
}

export async function ThreadView({ id, role }: { id: string; role: AppRole }) {
  const supabase = await createClient();
  const { data } = await supabase
    .from("conversations")
    .select("id, phone_e164, contact_name, last_inbound_at, unread_count, flow, lead_id, last_message_at, last_message_preview, last_direction, leads(full_name, organization, marketing_consent)")
    .eq("id", id)
    .maybeSingle();
  if (!data) notFound();
  const c = data as unknown as ConversationRow & { last_inbound_at: string | null; lead_id: string | null; leads: (ConversationRow["leads"] & { marketing_consent: ConsentStatus }) | null };
  const [{ items, truncated }, { data: optOut }] = await Promise.all([
    loadThread(supabase, c.id, c.phone_e164),
    supabase.from("opt_outs").select("created_at").eq("phone_e164", c.phone_e164).maybeSingle(),
  ]);

  const now = new Date();
  const open = windowOpen(c.last_inbound_at, now);
  const hoursLeft = open && c.last_inbound_at ? Math.max(0, 24 - (now.getTime() - new Date(c.last_inbound_at).getTime()) / 3600_000) : 0;
  const flow = liveFlow(c.flow as FlowState | null, now);
  const flowActive = flow && STEP_LABEL[flow.step];
  const canReply = CAN_EDIT_LEADS.includes(role);
  const mock = whatsappMode() !== "live";
  const disabledReason = !canReply
    ? "Your role can view conversations but not reply."
    : !open
      ? "The 24-hour reply window is closed. WhatsApp only allows approved templates until this contact messages you again."
      : null;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <MarkRead id={c.id} unread={c.unread_count} />
      <AutoRefresh active intervalMs={8_000} />
      <header className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b px-4 py-3">
        <Link href="/inbox" className="md:hidden" aria-label="Back to conversations"><ArrowLeft className="size-4" /></Link>
        <div className="min-w-0 flex-1">
          <div className="truncate font-semibold">{displayName(c)}</div>
          <div className="flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
            <span className="font-mono">{c.phone_e164}</span>
            {c.contact_name && c.leads?.full_name && c.contact_name !== c.leads.full_name && <span>WhatsApp: {c.contact_name}</span>}
            {c.leads?.organization && <span>· {c.leads.organization}</span>}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          {c.lead_id ? (
            <Link href={`/leads/${c.lead_id}`} className="inline-flex items-center gap-1 text-xs text-primary hover:underline">Lead <ExternalLink className="size-3" /></Link>
          ) : (
            <Badge variant="outline">Not a lead yet</Badge>
          )}
          {c.leads && <ConsentBadge status={c.leads.marketing_consent} />}
          {optOut && <Badge variant="destructive">Opted out of marketing</Badge>}
          <Badge variant={open ? "success" : "secondary"}>{open ? `Reply window: ${hoursLeft < 1 ? "<1" : Math.floor(hoursLeft)}h left` : "Reply window closed"}</Badge>
        </div>
      </header>

      {flowActive && (
        <div className="flex items-center justify-between gap-2 border-b bg-amber-500/10 px-4 py-2 text-sm">
          <span className="flex items-center gap-2"><Bot className="size-4" /> Send Details form in progress — {STEP_LABEL[flow.step]}.</span>
          {canReply && <CancelFlowButton id={c.id} />}
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto bg-muted/30 px-3 py-4 sm:px-6">
        {truncated && <p className="mb-3 text-center text-xs text-muted-foreground">Showing the latest 300 messages.</p>}
        {items.length === 0 && <p className="py-10 text-center text-sm text-muted-foreground">No messages yet.</p>}
        <ol className="flex flex-col gap-2">
          {items.map((m) => {
            const out = m.direction === "out";
            const note = m.type === "note";
            return (
              <li key={m.key} className={cn("flex", note ? "justify-center" : out ? "justify-end" : "justify-start")}>
                <div
                  className={cn(
                    "max-w-[85%] rounded-lg px-3 py-2 text-sm shadow-xs sm:max-w-[70%]",
                    note ? "border border-dashed border-amber-500/50 bg-amber-500/10 text-xs" : out ? "bg-[#d9fdd3] text-[#111b21] dark:bg-[#005c4b] dark:text-[#e9edef]" : "bg-card",
                  )}
                >
                  {(m.source === "campaign" || m.source === "automation" || m.meta?.template) && (
                    <div className="mb-1 flex items-center gap-1 text-[11px] opacity-70">
                      {m.source === "campaign" ? <Megaphone className="size-3" /> : <Bot className="size-3" />}
                      {m.source === "campaign" ? `Campaign: ${m.meta?.campaign ?? "—"}${m.meta?.template ? ` · ${m.meta.template}` : ""}` : m.meta?.template ? `Automated · template ${m.meta.template}` : "Automated reply"}
                    </div>
                  )}
                  {m.type === "button" || m.type === "interactive" ? (
                    <div className="italic">Tapped “{m.body}”</div>
                  ) : (
                    <div className="whitespace-pre-wrap break-words"><Formatted text={m.body} /></div>
                  )}
                  {m.type === "cta_url" && m.meta?.url && (
                    <a href={m.meta.url} target="_blank" rel="noreferrer" className="mt-2 flex items-center justify-center gap-1 border-t border-black/10 pt-1.5 text-[13px] font-medium text-sky-600 dark:border-white/10">
                      <ExternalLink className="size-3.5" /> {m.meta.display_text}
                    </a>
                  )}
                  {m.error && <div className="mt-1 text-[11px] text-destructive">{m.error}</div>}
                  <div className="mt-1 flex items-center justify-end gap-1.5 text-[10px] opacity-60">
                    {m.meta?.sender && <span>{m.meta.sender} ·</span>}
                    <time dateTime={m.at}>{time(m.at)}</time>
                    {out && !note && <MessageStatus status={m.status} />}
                  </div>
                </div>
              </li>
            );
          })}
        </ol>
        <ScrollToBottom dep={items.at(-1)?.key ?? ""} />
      </div>

      <Composer id={c.id} disabledReason={disabledReason} mock={mock} />
    </div>
  );
}
