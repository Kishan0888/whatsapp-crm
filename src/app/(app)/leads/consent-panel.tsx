"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ConsentBadge } from "@/components/consent-badge";
import { fmtDate } from "@/lib/utils";
import type { ConsentStatus } from "@/lib/types";
import { recordConsent } from "./actions";

export interface ConsentEvent {
  id: number;
  status: ConsentStatus;
  source: string;
  evidence: string | null;
  created_at: string;
}

export function ConsentPanel({
  leadId,
  status,
  source,
  events,
  canEdit,
}: {
  leadId: string;
  status: ConsentStatus;
  source: string | null;
  events: ConsentEvent[];
  canEdit: boolean;
}) {
  const router = useRouter();
  const [evidence, setEvidence] = useState("");
  const [pending, start] = useTransition();

  const submit = (s: "opted_in" | "opted_out") => {
    if (s === "opted_out" && !confirm("Opt-outs are permanent and cannot be undone. Continue?")) return;
    start(async () => {
      const r = await recordConsent({ leadId, status: s, evidence });
      if (r.ok) {
        toast.success(r.message ?? "Saved");
        setEvidence("");
        router.refresh();
      } else toast.error(r.error);
    });
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center justify-between">WhatsApp marketing consent <ConsentBadge status={status} /></CardTitle>
        <CardDescription>
          Only opted-in leads are eligible for marketing campaigns. {source && <>Source: {source}.</>}
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-3">
        {canEdit && status !== "opted_out" && (
          <>
            <Textarea
              placeholder="Evidence, e.g. 'Ticked WhatsApp opt-in on website form 12 Oct 2026'"
              value={evidence}
              onChange={(e) => setEvidence(e.target.value)}
              rows={2}
            />
            <div className="flex gap-2">
              {status !== "opted_in" && (
                <Button size="sm" disabled={pending || evidence.trim().length < 3} onClick={() => submit("opted_in")}>Record opt-in</Button>
              )}
              <Button size="sm" variant="destructive" disabled={pending || evidence.trim().length < 3} onClick={() => submit("opted_out")}>
                Opt out permanently
              </Button>
            </div>
          </>
        )}
        {status === "opted_out" && <p className="text-sm text-muted-foreground">This number is on the permanent suppression list.</p>}
        {events.length > 0 && (
          <ul className="grid gap-2 border-t pt-3 text-sm">
            {events.map((e) => (
              <li key={e.id} className="flex flex-col">
                <span className="flex items-center gap-2"><ConsentBadge status={e.status} /> <span className="text-xs text-muted-foreground">{e.source} · {fmtDate(e.created_at)}</span></span>
                {e.evidence && <span className="mt-0.5 text-xs text-muted-foreground">{e.evidence}</span>}
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
