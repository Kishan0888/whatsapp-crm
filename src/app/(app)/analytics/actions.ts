"use server";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { assertRole, audit, CAN_MANAGE_CAMPAIGNS } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { loadWaConfig } from "@/lib/whatsapp/config";
import { fetchPricingAnalytics } from "@/lib/whatsapp/api";
import { toFail, type Result } from "@/lib/action-result";

/** Pull Meta's pricing_analytics for a date range and store it (replacing that range). Read-only on Meta. */
export async function syncMetaCosts(input: { from: string; to: string }): Promise<Result<{ points: number }>> {
  try {
    const { profile } = await assertRole(CAN_MANAGE_CAMPAIGNS);
    const p = z.object({ from: z.iso.date(), to: z.iso.date() }).parse(input);
    const start = new Date(`${p.from}T00:00:00Z`);
    const end = new Date(`${p.to}T23:59:59Z`);
    if (end <= start) return { ok: false, error: "End date must be after start date" };
    if (end.getTime() - start.getTime() > 92 * 86400_000) return { ok: false, error: "Choose a range of at most ~3 months" };
    const points = await fetchPricingAnalytics(await loadWaConfig(), Math.floor(start.getTime() / 1000), Math.floor(end.getTime() / 1000));
    const supabase = await createClient();
    const del = await supabase.from("meta_cost_reports").delete().gte("period_start", start.toISOString()).lte("period_end", end.toISOString());
    if (del.error) return { ok: false, error: del.error.message };
    if (points.length) {
      const { error } = await supabase.from("meta_cost_reports").insert(
        points.map((d) => ({
          period_start: new Date(d.start * 1000).toISOString(),
          period_end: new Date(d.end * 1000).toISOString(),
          country: d.country ?? null,
          pricing_category: d.pricing_category ?? null,
          pricing_type: d.pricing_type ?? null,
          volume: d.volume ?? 0,
          cost: d.cost ?? null,
          fetched_by: profile.id,
        })),
      );
      if (error) return { ok: false, error: error.message };
    }
    await audit("meta_costs.sync", "meta_cost_reports", null, { from: p.from, to: p.to, points: points.length });
    revalidatePath("/analytics");
    return { ok: true, data: { points: points.length }, message: `Fetched ${points.length} data point(s) from Meta` };
  } catch (e) {
    return toFail(e);
  }
}
