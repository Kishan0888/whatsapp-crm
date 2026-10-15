import { notFound } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { ConversationList } from "../conversation-list";
import { InboxShell } from "../inbox-shell";
import { ThreadView } from "../thread-view";

export const metadata = { title: "Inbox" };

export default async function ConversationPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ q?: string; unread?: string }> }) {
  const { profile } = await requireUser();
  const [{ id }, sp] = await Promise.all([params, searchParams]);
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  return (
    <InboxShell
      hasThread
      list={<ConversationList activeId={id} q={sp.q} unread={sp.unread === "1"} />}
      thread={<ThreadView id={id} role={profile.role} />}
    />
  );
}
