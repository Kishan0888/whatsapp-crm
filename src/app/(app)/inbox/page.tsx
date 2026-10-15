import { MessagesSquare } from "lucide-react";
import { requireUser } from "@/lib/auth";
import { AutoRefresh } from "@/components/auto-refresh";
import { ConversationList } from "./conversation-list";
import { InboxShell } from "./inbox-shell";

export const metadata = { title: "Inbox" };

export default async function InboxPage({ searchParams }: { searchParams: Promise<{ q?: string; unread?: string }> }) {
  await requireUser();
  const sp = await searchParams;
  return (
    <>
      <AutoRefresh active intervalMs={15_000} />
      <InboxShell
        hasThread={false}
        list={<ConversationList q={sp.q} unread={sp.unread === "1"} />}
        thread={
          <div className="flex h-full flex-col items-center justify-center gap-2 p-8 text-center text-muted-foreground">
            <MessagesSquare className="size-10 opacity-40" />
            <p className="text-sm">Select a conversation to read and reply.</p>
          </div>
        }
      />
    </>
  );
}
