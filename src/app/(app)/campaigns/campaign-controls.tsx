"use client";
import Link from "next/link";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Download, Loader2, Pause, Play, RotateCcw, Send, XCircle, Zap } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { fmtInt, fmtMoney } from "@/lib/utils";
import { controlCampaign, deleteDraftCampaign, launchCampaign, processNow } from "./actions";

type R = { ok: true; message?: string } | { ok: false; error: string };

function useRun() {
  const router = useRouter();
  const [pending, start] = useTransition();
  const run = (fn: () => Promise<R>, after?: () => void) =>
    start(async () => {
      const r = await fn();
      if (r.ok) {
        toast.success(r.message ?? "Done");
        after?.();
        router.refresh();
      } else toast.error(r.error);
    });
  return { pending, run };
}

export { AutoRefresh } from "@/components/auto-refresh";

export function LaunchDialog({
  id, eligible, rate, currency, live, templateName,
}: { id: string; eligible: number; rate: number; currency: string; live: boolean; templateName: string }) {
  const router = useRouter();
  const { pending, run } = useRun();
  const [typed, setTyped] = useState("");
  const [ack, setAck] = useState(false);
  const [open, setOpen] = useState(false);
  const ok = ack && typed === String(eligible) && eligible > 0;
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button disabled={eligible === 0}><Send /> {live ? "Launch campaign" : "Run dry run"}</Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{live ? "Send real WhatsApp messages?" : "Start a dry run?"}</DialogTitle>
          <DialogDescription>
            {live
              ? "Messages are sent through the official WhatsApp Cloud API and Meta will charge your account."
              : "Mock mode: every recipient is processed and personalised, but nothing is sent to Meta and nothing is charged."}
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-2 rounded-md bg-muted/50 p-3 text-sm">
          <div className="flex justify-between"><span>Template</span><span className="font-medium">{templateName}</span></div>
          <div className="flex justify-between"><span>Recipients (opted-in, not suppressed)</span><span className="font-medium tabular-nums">{fmtInt(eligible)}</span></div>
          {live && <div className="flex justify-between"><span>Estimated cost</span><span className="font-medium tabular-nums">{fmtMoney(eligible * rate, currency)}</span></div>}
        </div>
        <label className="flex items-start gap-2 text-sm">
          <input type="checkbox" className="mt-0.5" checked={ack} onChange={(e) => setAck(e.target.checked)} />
          <span>{live ? `I authorise sending ${fmtInt(eligible)} WhatsApp messages. I understand the cost shown is an estimate.` : "I understand this is a dry run."}</span>
        </label>
        <div className="grid gap-1.5">
          <label htmlFor="confirm-count" className="text-sm">Type the number of recipients (<strong>{eligible}</strong>) to confirm</label>
          <Input id="confirm-count" inputMode="numeric" value={typed} onChange={(e) => setTyped(e.target.value.trim())} />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
          <Button disabled={!ok || pending} variant={live ? "destructive" : "default"}
            onClick={() => run(() => launchCampaign(id, eligible), () => { setOpen(false); router.refresh(); })}>
            {pending && <Loader2 className="animate-spin" />} {live ? `Send to ${fmtInt(eligible)}` : "Start dry run"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function CampaignControls({ id, status, hasRetryable }: { id: string; status: string; hasRetryable: boolean }) {
  const router = useRouter();
  const { pending, run } = useRun();
  return (
    <div className="flex flex-wrap gap-2">
      {status === "draft" && (
        <>
          <Button variant="outline" asChild><Link href={`/campaigns/${id}/edit`}>Edit</Link></Button>
          <Button variant="ghost" disabled={pending} onClick={() => confirm("Delete this draft?") && run(() => deleteDraftCampaign(id), () => router.push("/campaigns"))}>Delete</Button>
        </>
      )}
      {status === "running" && <Button variant="outline" disabled={pending} onClick={() => run(() => controlCampaign(id, "pause"))}><Pause /> Pause</Button>}
      {status === "paused" && <Button variant="outline" disabled={pending} onClick={() => run(() => controlCampaign(id, "resume"))}><Play /> Resume</Button>}
      {["running", "paused", "completed"].includes(status) && hasRetryable && (
        <Button variant="outline" disabled={pending} onClick={() => run(() => controlCampaign(id, "retry_failed"))}><RotateCcw /> Retry failed</Button>
      )}
      {["running", "paused"].includes(status) && (
        <Button variant="outline" disabled={pending}
          onClick={() => confirm("Cancel all unsent messages in this campaign? Messages already sent can't be recalled.") && run(() => controlCampaign(id, "cancel"))}>
          <XCircle /> Cancel unsent
        </Button>
      )}
      {status === "running" && (
        <Button variant="ghost" disabled={pending} title="Process a batch now instead of waiting for the scheduler" onClick={() => run(processNow)}>
          {pending ? <Loader2 className="animate-spin" /> : <Zap />} Process now
        </Button>
      )}
      {status !== "draft" && (
        <Button variant="outline" asChild><a href={`/campaigns/${id}/export`}><Download /> Export CSV</a></Button>
      )}
    </div>
  );
}
