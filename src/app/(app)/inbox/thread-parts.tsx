"use client";
import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Loader2, SendHorizontal } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { cancelFlow, markRead, sendReply } from "./actions";

/** Clears the unread badge when a conversation is opened. */
export function MarkRead({ id, unread }: { id: string; unread: number }) {
  const router = useRouter();
  useEffect(() => {
    if (unread > 0) markRead(id).then((r) => r.ok && router.refresh());
  }, [id, unread, router]);
  return null;
}

/** Keeps the newest message in view. */
export function ScrollToBottom({ dep }: { dep: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => ref.current?.scrollIntoView({ block: "end" }), [dep]);
  return <div ref={ref} />;
}

export function CancelFlowButton({ id }: { id: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  return (
    <Button size="sm" variant="outline" disabled={pending}
      onClick={() => confirm("Stop the automated questions for this contact?") && start(async () => {
        const r = await cancelFlow(id);
        if (r.ok) { toast.success(r.message ?? "Cancelled"); router.refresh(); } else toast.error(r.error);
      })}>
      {pending && <Loader2 className="animate-spin" />} Cancel flow
    </Button>
  );
}

export function Composer({ id, disabledReason, mock }: { id: string; disabledReason: string | null; mock: boolean }) {
  const router = useRouter();
  const [body, setBody] = useState("");
  const [key, setKey] = useState(() => crypto.randomUUID());
  const [pending, start] = useTransition();

  function submit() {
    if (!body.trim() || pending) return;
    start(async () => {
      const r = await sendReply({ conversationId: id, body, clientKey: key });
      if (r.ok) {
        if (r.message) toast.message(r.message);
        setBody("");
        setKey(crypto.randomUUID());
      } else toast.error(r.error);
      router.refresh();
    });
  }

  if (disabledReason) return <p className="border-t bg-muted/40 px-4 py-3 text-sm text-muted-foreground">{disabledReason}</p>;
  return (
    <form className="flex items-end gap-2 border-t p-3" onSubmit={(e) => { e.preventDefault(); submit(); }}>
      <Textarea
        value={body}
        onChange={(e) => setBody(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submit(); } }}
        placeholder={mock ? "Type a reply (mock mode — won't be sent to WhatsApp)" : "Type a reply… (Enter to send, Shift+Enter for a new line)"}
        rows={2}
        maxLength={4096}
        className="min-h-11 resize-none"
        aria-label="Reply"
      />
      <Button type="submit" size="icon" disabled={pending || !body.trim()} aria-label="Send">
        {pending ? <Loader2 className="animate-spin" /> : <SendHorizontal />}
      </Button>
    </form>
  );
}
