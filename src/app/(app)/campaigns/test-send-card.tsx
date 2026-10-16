"use client";
import Link from "next/link";
import { useEffect, useState, useTransition } from "react";
import { FlaskConical, Loader2, Send } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { prepareTestSend, sendTestMessage, type TestSendPreview } from "./actions";

const STORAGE_KEY = "crm.testPhone";

/**
 * Sends the campaign's approved template to ONE number the user types in.
 * Two steps (preview → confirm), so a test can never go out by accident and
 * never reaches the campaign audience.
 */
export function TestSendCard({ campaignId, blockers }: { campaignId: string; blockers: string[] }) {
  const [phone, setPhone] = useState("");
  const [preview, setPreview] = useState<(TestSendPreview & { key: string }) | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [outcome, setOutcome] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, start] = useTransition();

  useEffect(() => {
    try {
      const saved = window.localStorage.getItem(STORAGE_KEY);
      if (saved) setPhone(saved); // eslint-disable-line react-hooks/set-state-in-effect -- one-time restore of a per-browser convenience
    } catch {
      /* storage unavailable */
    }
  }, []);

  const blocked = blockers.length > 0;

  function doPreview() {
    setOutcome(null);
    setConfirmed(false);
    start(async () => {
      const r = await prepareTestSend({ campaignId, phone });
      if (!r.ok) {
        setPreview(null);
        setOutcome({ ok: false, text: r.error });
        return;
      }
      try {
        window.localStorage.setItem(STORAGE_KEY, phone);
      } catch {
        /* ignore */
      }
      setPreview({ ...r.data, key: crypto.randomUUID() });
    });
  }

  function doSend() {
    if (!preview) return;
    start(async () => {
      const r = await sendTestMessage({ campaignId, phone, clientKey: preview.key, confirmed });
      setOutcome(r.ok ? { ok: true, text: r.message ?? `Sent (message id ${r.data.wamid})` } : { ok: false, text: r.error });
      if (r.ok) {
        setPreview(null);
        setConfirmed(false);
      }
    });
  }

  return (
    <Card className="border-dashed">
      <CardHeader>
        <CardTitle className="flex items-center gap-2"><FlaskConical className="size-4" /> Send test message</CardTitle>
        <CardDescription>Sends this campaign&apos;s approved template to one number only — never to the audience. It does not start the campaign.</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-3">
        {blocked && (
          <ul className="grid gap-1 rounded-md bg-muted/60 p-3 text-sm text-muted-foreground">
            {blockers.map((b) => <li key={b}>• {b}</li>)}
          </ul>
        )}
        <fieldset disabled={blocked || pending} className="grid gap-3">
          <div className="grid gap-1.5">
            <Label htmlFor="test-phone">Test WhatsApp number</Label>
            <div className="flex gap-2">
              <Input id="test-phone" inputMode="tel" placeholder="+91 98xxx xxxxx (your own number)" value={phone}
                onChange={(e) => { setPhone(e.target.value); setPreview(null); setConfirmed(false); }} />
              <Button type="button" variant="outline" onClick={doPreview} disabled={!phone.trim()}>
                {pending && !preview ? <Loader2 className="animate-spin" /> : null} Preview
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">If this number belongs to a lead, their details fill the variables; otherwise the fallbacks are used.</p>
          </div>

          {preview && (
            <div className="grid gap-3 rounded-md border p-3">
              <div className="text-xs text-muted-foreground">
                To <strong className="font-mono text-foreground">{preview.plan.to}</strong> · template <strong className="text-foreground">{preview.templateName}</strong> ({preview.language}, {preview.category.toLowerCase()})
                {preview.plan.personalizedWith ? ` · personalised as ${preview.plan.personalizedWith}` : " · using fallback values"}
              </div>
              <div className="whitespace-pre-wrap rounded-md bg-[#d9fdd3] p-3 text-sm text-[#111b21] dark:bg-[#005c4b] dark:text-[#e9edef]">
                {preview.plan.header && <div className="mb-1 font-semibold">{preview.plan.header}</div>}
                {preview.plan.body}
              </div>
              <label className="flex items-start gap-2 text-sm">
                <input type="checkbox" className="mt-0.5" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />
                <span>Send 1 real WhatsApp message to {preview.plan.to}. I understand Meta may charge for it.</span>
              </label>
              <Button type="button" onClick={doSend} disabled={!confirmed || pending} className="justify-self-start">
                {pending ? <Loader2 className="animate-spin" /> : <Send />} Send test to {preview.plan.to}
              </Button>
            </div>
          )}
        </fieldset>

        {outcome && (
          <div role="status" className={outcome.ok ? "rounded-md bg-primary/10 p-3 text-sm" : "rounded-md bg-destructive/10 p-3 text-sm text-destructive"}>
            {outcome.text} {outcome.ok && <Link href="/inbox" className="underline">Open Inbox</Link>}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
