"use client";
import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { Loader2, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { syncMetaCosts } from "./actions";

export function MetaCostForm({ from, to, disabled }: { from: string; to: string; disabled: boolean }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  return (
    <form
      className="flex flex-wrap items-end gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        const fd = new FormData(e.currentTarget);
        const range = { from: String(fd.get("from")), to: String(fd.get("to")) };
        start(async () => {
          const r = await syncMetaCosts(range);
          if (r.ok) toast.success(r.message ?? "Fetched");
          else toast.error(r.error);
          router.push(`/analytics?from=${range.from}&to=${range.to}`);
          router.refresh();
        });
      }}
    >
      <label className="grid gap-1 text-xs">From<Input type="date" name="from" defaultValue={from} className="h-8" /></label>
      <label className="grid gap-1 text-xs">To<Input type="date" name="to" defaultValue={to} className="h-8" /></label>
      <Button size="sm" variant="outline" disabled={pending || disabled} title={disabled ? "Needs WHATSAPP_ACCESS_TOKEN and WABA ID" : undefined}>
        {pending ? <Loader2 className="animate-spin" /> : <RefreshCw />} Fetch from Meta
      </Button>
    </form>
  );
}
