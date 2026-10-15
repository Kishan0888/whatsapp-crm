import Link from "next/link";
import { Search } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

export interface ConversationRow {
  id: string;
  phone_e164: string;
  contact_name: string | null;
  last_message_at: string | null;
  last_message_preview: string | null;
  last_direction: "in" | "out" | null;
  unread_count: number;
  flow: { step?: string } | null;
  leads: { full_name: string | null; organization: string | null } | null;
}

export const displayName = (c: Pick<ConversationRow, "contact_name" | "phone_e164" | "leads">) =>
  c.leads?.full_name || c.contact_name || c.leads?.organization || c.phone_e164;

function shortTime(iso: string | null) {
  if (!iso) return "";
  const d = new Date(iso);
  const sameDay = d.toDateString() === new Date().toDateString();
  return new Intl.DateTimeFormat("en-IN", sameDay ? { timeStyle: "short" } : { day: "numeric", month: "short" }).format(d);
}

export async function ConversationList({ activeId, q, unread }: { activeId?: string; q?: string; unread?: boolean }) {
  const supabase = await createClient();
  let query = supabase
    .from("conversations")
    .select("id, phone_e164, contact_name, last_message_at, last_message_preview, last_direction, unread_count, flow, leads(full_name, organization)")
    .not("last_message_at", "is", null)
    .order("last_message_at", { ascending: false })
    .limit(100);
  const term = q?.replace(/[%,()*:\\"']/g, " ").trim();
  if (term) {
    const digits = term.replace(/\D/g, "");
    query = query.or([`contact_name.ilike.%${term}%`, ...(digits.length >= 3 ? [`phone_e164.like.%${digits}%`] : [])].join(","));
  }
  if (unread) query = query.gt("unread_count", 0);
  const { data, error } = await query;
  const rows = (data ?? []) as unknown as ConversationRow[];
  const qs = (extra: Record<string, string>) => {
    const p = new URLSearchParams({ ...(q ? { q } : {}), ...(unread ? { unread: "1" } : {}), ...extra });
    return p.toString() ? `?${p}` : "";
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <form className="flex gap-2 border-b p-3" method="get">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute top-2.5 left-2.5 size-4 text-muted-foreground" />
          <Input name="q" defaultValue={q} placeholder="Search name or number" className="pl-8" aria-label="Search conversations" />
        </div>
        <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <input type="checkbox" name="unread" value="1" defaultChecked={unread} /> Unread
        </label>
        <button className="sr-only">Search</button>
      </form>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {error && <p className="p-4 text-sm text-destructive">Couldn&apos;t load conversations: {error.message}</p>}
        {!error && rows.length === 0 && (
          <div className="p-6 text-center text-sm text-muted-foreground">
            {term || unread ? "No conversations match." : "No conversations yet. Messages people send to your WhatsApp number will appear here."}
          </div>
        )}
        <ul>
          {rows.map((c) => {
            const active = c.id === activeId;
            const inFlow = c.flow?.step && ["name", "hospital", "datetime"].includes(c.flow.step);
            return (
              <li key={c.id}>
                <Link
                  href={`/inbox/${c.id}${qs({})}`}
                  className={cn("flex gap-3 border-b px-3 py-3 hover:bg-muted/50", active && "bg-accent hover:bg-accent")}
                  aria-current={active ? "page" : undefined}
                >
                  <div className="flex size-9 shrink-0 items-center justify-center rounded-full bg-primary/10 text-sm font-medium text-primary">
                    {displayName(c).replace(/^\+/, "").slice(0, 1).toUpperCase()}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-baseline justify-between gap-2">
                      <span className={cn("truncate text-sm", c.unread_count > 0 ? "font-semibold" : "font-medium")}>{displayName(c)}</span>
                      <span className="shrink-0 text-xs text-muted-foreground">{shortTime(c.last_message_at)}</span>
                    </div>
                    <div className="truncate text-xs text-muted-foreground">{c.phone_e164}</div>
                    <div className="mt-0.5 flex items-center justify-between gap-2">
                      <span className={cn("truncate text-xs", c.unread_count > 0 ? "text-foreground" : "text-muted-foreground")}>
                        {c.last_direction === "out" && "You: "}
                        {c.last_message_preview}
                      </span>
                      <span className="flex shrink-0 items-center gap-1">
                        {inFlow && <span className="rounded bg-amber-500/15 px-1 text-[10px] text-amber-700 dark:text-amber-400">form</span>}
                        {c.unread_count > 0 && (
                          <span className="min-w-5 rounded-full bg-primary px-1.5 text-center text-[11px] font-medium text-primary-foreground" aria-label={`${c.unread_count} unread`}>
                            {c.unread_count}
                          </span>
                        )}
                      </span>
                    </div>
                  </div>
                </Link>
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}
