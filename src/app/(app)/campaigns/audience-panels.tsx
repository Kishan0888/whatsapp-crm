import { AlertTriangle, Loader2, RefreshCw, Users } from "lucide-react";
import { fmtInt } from "@/lib/utils";
import type { AudienceSummary, CostEstimate } from "@/lib/campaigns/audience";

const ROWS: { key: keyof AudienceSummary; label: string; hint: string }[] = [
  { key: "invalid_phone", label: "Missing / invalid phone", hint: "No valid WhatsApp number in international format" },
  { key: "no_consent", label: "No recorded opt-in", hint: "WhatsApp requires opt-in before any business-initiated message" },
  { key: "opted_out", label: "Opted out / suppressed", hint: "Permanently suppressed numbers are never messaged" },
  { key: "duplicate_phone", label: "Duplicate phone", hint: "Each number is messaged once per campaign" },
];

/** Server-calculated breakdown; shows loading and errors explicitly (never a silent 0). */
export function AudienceBreakdown({
  summary, loading, error, onRefresh,
}: { summary: AudienceSummary | null; loading?: boolean; error?: string | null; onRefresh?: () => void }) {
  if (error) {
    return (
      <div role="alert" className="flex items-start justify-between gap-3 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
        <span className="flex gap-2"><AlertTriangle className="mt-0.5 size-4 shrink-0" /> {error}</span>
        {onRefresh && <button type="button" onClick={onRefresh} className="shrink-0 underline">Retry</button>}
      </div>
    );
  }
  if (!summary) {
    return (
      <div className="flex items-center gap-2 rounded-md bg-muted/50 p-3 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" /> Calculating eligible recipients…
      </div>
    );
  }
  return (
    <div className="grid gap-2 rounded-md bg-muted/50 p-3 text-sm">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          {loading ? <Loader2 className="size-4 animate-spin" /> : <Users className="size-4 text-primary" />}
          <span className="text-2xl font-semibold tabular-nums" data-testid="eligible-count">{fmtInt(summary.eligible)}</span>
          <span className="text-muted-foreground">eligible of {fmtInt(summary.matching)} matching lead{summary.matching === 1 ? "" : "s"}</span>
        </div>
        {onRefresh && (
          <button type="button" onClick={onRefresh} disabled={loading} className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground disabled:opacity-50">
            <RefreshCw className="size-3.5" /> Recalculate
          </button>
        )}
      </div>
      <dl className="grid gap-1 sm:grid-cols-2">
        {ROWS.map((r) => (
          <div key={r.key} className="flex justify-between gap-2" title={r.hint}>
            <dt className="text-muted-foreground">Excluded · {r.label}</dt>
            <dd className="tabular-nums">{fmtInt(summary[r.key] as number)}</dd>
          </div>
        ))}
      </dl>
      {summary.no_consent > 0 && (
        <p className="text-xs text-amber-800 dark:text-amber-300">
          {fmtInt(summary.no_consent)} lead(s) have no recorded WhatsApp opt-in, so they can&apos;t be messaged. Record opt-in on the lead (with evidence),
          map an opt-in column when importing, or tick the opt-in declaration on import if every contact in the file opted in.
        </p>
      )}
      <p className="text-[11px] text-muted-foreground">Calculated on the server at {new Date(summary.computed_at).toLocaleTimeString("en-IN")}. Launch re-checks this exact count.</p>
    </div>
  );
}

export function CostSummary({ cost, eligible }: { cost: CostEstimate | null; eligible: number }) {
  if (!cost) return <p className="text-sm text-muted-foreground">Calculating…</p>;
  if (!cost.category) return <p className="text-sm text-muted-foreground">Choose a template to estimate the cost.</p>;
  return (
    <div className="grid gap-1 text-sm">
      <div className="flex justify-between"><span className="text-muted-foreground">Template category</span><span>{cost.category.toLowerCase()}</span></div>
      <div className="flex justify-between"><span className="text-muted-foreground">Destination assumed</span><span>{cost.countryName} ({cost.dialPrefix})</span></div>
      <div className="flex justify-between">
        <span className="text-muted-foreground">Rate per message</span>
        <span className="tabular-nums">{cost.rateLabel ?? <span className="font-medium text-amber-700 dark:text-amber-400">Rate not configured</span>}</span>
      </div>
      <div className="flex justify-between"><span className="text-muted-foreground">Eligible recipients</span><span className="tabular-nums">{fmtInt(eligible)}</span></div>
      {cost.rateConfigured && cost.unpricedRecipients > 0 && (
        <div className="flex justify-between text-amber-700 dark:text-amber-400"><span>Outside {cost.countryName} (not priced)</span><span className="tabular-nums">{fmtInt(cost.unpricedRecipients)}</span></div>
      )}
      <div className="flex justify-between border-t pt-1 font-medium">
        <span>Estimated total</span>
        <span className="tabular-nums" data-testid="estimated-total">
          {cost.totalLabel ? `${cost.totalLabel}${cost.unpricedRecipients > 0 ? " + unpriced" : ""}` : "Rate not configured"}
        </span>
      </div>
      {!cost.rateConfigured && <p className="text-xs text-amber-700 dark:text-amber-400">An admin can set it in {cost.settingsHint}, using Meta&apos;s current rate card.</p>}
      <p className="pt-1 text-xs text-muted-foreground">Estimate only. Meta bills per delivered message by category and recipient country; actual charges may differ and appear in Analytics → Meta-reported charges.</p>
    </div>
  );
}
