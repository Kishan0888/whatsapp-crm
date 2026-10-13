import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createAdminClient } from "@/lib/supabase/admin";
import { loadWaConfig, type WaConfig } from "@/lib/whatsapp/config";
import { sendMessage } from "@/lib/whatsapp/api";
import { MetaApiError } from "@/lib/whatsapp/graph";
import { classifyError } from "@/lib/whatsapp/errors";
import { buildSendComponents, buildTemplateMessage, type HeaderMedia, type LeadForRender, type TemplateSnapshot, type VariableMapping } from "@/lib/whatsapp/send";
import { reprocessPendingEvents } from "@/lib/whatsapp/events";

interface ClaimedRow {
  id: number;
  campaign_id: string;
  lead_id: string | null;
  phone_e164: string;
  attempts: number;
}
interface CampaignRow {
  id: string;
  status: string;
  is_dry_run: boolean;
  template_snapshot: TemplateSnapshot | null;
  variable_mapping: VariableMapping;
  header_media: HeaderMedia | null;
}
type LeadRow = LeadForRender & { id: string; marketing_consent: string };

export interface ProcessStats {
  claimed: number;
  submitted: number;
  dryRun: number;
  retried: number;
  failed: number;
  skipped: number;
  pausedCampaigns: number;
  staleInterrupted: number;
  eventsReprocessed: number;
  completedCampaigns: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Drain the send queue for up to `budgetMs`, throttled to the configured
 * messages/second. Safe to run concurrently: rows are claimed with
 * FOR UPDATE SKIP LOCKED and each phone appears once per campaign.
 */
export async function processQueue({ budgetMs = 50_000 }: { budgetMs?: number } = {}): Promise<ProcessStats> {
  const admin = createAdminClient();
  const cfg = await loadWaConfig();
  const stats: ProcessStats = {
    claimed: 0, submitted: 0, dryRun: 0, retried: 0, failed: 0, skipped: 0,
    pausedCampaigns: 0, staleInterrupted: 0, eventsReprocessed: 0, completedCampaigns: 0,
  };
  const deadline = Date.now() + budgetMs;

  const { data: stale } = await admin.rpc("release_stale_recipients");
  stats.staleInterrupted = Number(stale ?? 0);
  stats.eventsReprocessed = await reprocessPendingEvents(admin);

  const campaigns = new Map<string, CampaignRow>();
  const perTick = Math.max(1, Math.min(cfg.sendRatePerSecond, 80));

  while (Date.now() < deadline - 2_000) {
    const tick = Date.now();
    const { data: claimed, error } = await admin.rpc("claim_recipients", { p_limit: perTick });
    if (error) throw new Error(`claim_recipients failed: ${error.message}`);
    const rows = (claimed ?? []) as ClaimedRow[];
    if (!rows.length) break;
    stats.claimed += rows.length;

    // Load campaign settings (fresh status each tick so pauses take effect quickly).
    const cids = [...new Set(rows.map((r) => r.campaign_id))];
    const { data: cs } = await admin
      .from("campaigns")
      .select("id, status, is_dry_run, template_snapshot, variable_mapping, header_media")
      .in("id", cids);
    for (const c of (cs ?? []) as CampaignRow[]) campaigns.set(c.id, c);

    const leadIds = rows.map((r) => r.lead_id).filter((x): x is string => !!x);
    const { data: ls } = await admin
      .from("leads")
      .select("id, full_name, organization, city, state, country, email, phone_e164, custom_fields, marketing_consent")
      .in("id", leadIds.length ? leadIds : ["00000000-0000-0000-0000-000000000000"]);
    const leads = new Map(((ls ?? []) as LeadRow[]).map((l) => [l.id, l]));
    const { data: oo } = await admin.from("opt_outs").select("phone_e164").in("phone_e164", rows.map((r) => r.phone_e164));
    const optedOut = new Set((oo ?? []).map((o) => o.phone_e164));

    await Promise.all(rows.map((r) => processOne(admin, cfg, r, campaigns, leads, optedOut, stats)));

    const elapsed = Date.now() - tick;
    if (elapsed < 1_000) await sleep(1_000 - elapsed);
  }

  const { data: done } = await admin.rpc("complete_finished_campaigns");
  stats.completedCampaigns = Number(done ?? 0);
  return stats;
}

async function processOne(
  admin: SupabaseClient,
  cfg: WaConfig,
  r: ClaimedRow,
  campaigns: Map<string, CampaignRow>,
  leads: Map<string, LeadRow>,
  optedOut: Set<string>,
  stats: ProcessStats,
) {
  const update = (patch: Record<string, unknown>) => admin.from("campaign_recipients").update(patch).eq("id", r.id);
  const release = () => update({ status: "queued", attempts: Math.max(0, r.attempts - 1), locked_at: null });
  const pause = async (c: CampaignRow, reason: string) => {
    if (c.status !== "running") return;
    c.status = "paused";
    await admin.from("campaigns").update({ status: "paused", last_error: reason }).eq("id", c.id).eq("status", "running");
    await admin.from("audit_logs").insert({ action: "campaign.auto_pause", entity_type: "campaign", entity_id: c.id, details: { reason } });
    stats.pausedCampaigns++;
  };

  const c = campaigns.get(r.campaign_id);
  if (!c || c.status !== "running" || !c.template_snapshot) return void (await release());

  // Re-check eligibility at send time: consent can change after launch.
  const lead = r.lead_id ? leads.get(r.lead_id) : undefined;
  if (!lead || lead.marketing_consent !== "opted_in" || optedOut.has(r.phone_e164)) {
    stats.skipped++;
    return void (await update({ status: "skipped", last_error_code: "ineligible", last_error: "No longer eligible (consent withdrawn, opted out or lead deleted)" }));
  }

  const built = buildSendComponents(c.template_snapshot.components, c.variable_mapping, lead, c.header_media);
  if (!built.ok) {
    stats.failed++;
    return void (await update({ status: "failed", failed_at: new Date().toISOString(), last_error_code: "render", last_error: built.error }));
  }

  if (c.is_dry_run) {
    stats.dryRun++;
    return void (await update({ status: "dry_run", rendered_components: built.components, last_error: null }));
  }
  if (cfg.mode !== "live") {
    await pause(c, "WHATSAPP_MODE is not 'live' — this live campaign was paused before sending.");
    return void (await release());
  }

  try {
    const { wamid } = await sendMessage(cfg, buildTemplateMessage(r.phone_e164, c.template_snapshot, built.components));
    stats.submitted++;
    await update({
      status: "sent", wa_message_id: wamid, accepted_at: new Date().toISOString(),
      rendered_components: built.components, last_error: null, last_error_code: null,
    });
  } catch (e) {
    const code = e instanceof MetaApiError ? e.code : "unknown";
    const message = e instanceof MetaApiError ? `${e.message}${e.details ? ` — ${e.details}` : ""}` : e instanceof Error ? e.message : String(e);
    const decision = code === "unknown" ? { action: "permanent" as const } : classifyError(code, r.attempts);
    if (decision.action === "retry") {
      stats.retried++;
      await update({
        status: "queued", locked_at: null, last_error_code: code, last_error: message,
        next_attempt_at: new Date(Date.now() + (decision.retryInSec ?? 30) * 1000).toISOString(),
      });
    } else if (decision.action === "systemic") {
      await pause(c, `Meta error ${code}: ${message}`);
      await release();
    } else {
      stats.failed++;
      if (decision.action === "opt_out") {
        await admin.from("opt_outs").upsert(
          { phone_e164: r.phone_e164, reason: "Meta 131050: user stopped marketing messages", source: "meta_131050" },
          { onConflict: "phone_e164", ignoreDuplicates: true },
        );
      }
      await update({ status: "failed", failed_at: new Date().toISOString(), last_error_code: code, last_error: message });
    }
  }
}
