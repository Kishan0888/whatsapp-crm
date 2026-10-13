import type { CampaignStats } from "@/lib/types";

export const pct = (a: number, b: number) => (b > 0 ? `${((a / b) * 100).toFixed(1)}%` : "—");

/** Rates are computed only from evidence: Meta message ids and webhook timestamps. */
export function rates(s: Pick<CampaignStats, "submitted" | "delivered" | "read" | "failed">) {
  return {
    delivery: pct(s.delivered, s.submitted),
    read: pct(s.read, s.delivered),
    failure: pct(s.failed, s.submitted + s.failed),
  };
}

export const STATUS_COLORS = {
  submitted: "#2563eb",
  delivered: "#059669",
  read: "#0891b2",
  failed: "#dc2626",
  pending: "#94a3b8",
};

export const emptyStats = (id: string): CampaignStats => ({
  campaign_id: id, total: 0, queued: 0, sending: 0, submitted: 0, sent_confirmed: 0, delivered: 0, read: 0,
  failed: 0, cancelled: 0, skipped: 0, dry_run: 0, paid: 0, free: 0,
});

export function normalizeStats(row: Record<string, unknown>): CampaignStats {
  const out = { ...row } as Record<string, unknown>;
  for (const [k, v] of Object.entries(out)) if (k !== "campaign_id") out[k] = Number(v ?? 0);
  return out as unknown as CampaignStats;
}
