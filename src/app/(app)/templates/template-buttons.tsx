"use client";
import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { Loader2, RefreshCw, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { removeTemplate, syncTemplates } from "./actions";

export function SyncButton({ disabled }: { disabled?: boolean }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  return (
    <Button variant="outline" disabled={disabled || pending}
      onClick={() => start(async () => {
        const r = await syncTemplates();
        if (r.ok) { toast.success(r.message ?? "Synced"); router.refresh(); } else toast.error(r.error);
      })}>
      {pending ? <Loader2 className="animate-spin" /> : <RefreshCw />} Sync from Meta
    </Button>
  );
}

export function DeleteTemplateButton({ id, submitted, live }: { id: string; submitted: boolean; live: boolean }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  return (
    <Button variant="outline" disabled={pending || (submitted && !live)} title={submitted && !live ? "Deleting from Meta needs live mode" : undefined}
      onClick={() => {
        if (!confirm(submitted ? "Delete this template from Meta? This can't be undone, and the name can't be reused for 30 days." : "Delete this draft?")) return;
        start(async () => {
          const r = await removeTemplate(id);
          if (r.ok) { toast.success(r.message ?? "Deleted"); router.push("/templates"); router.refresh(); } else toast.error(r.error);
        });
      }}>
      <Trash2 /> Delete
    </Button>
  );
}
