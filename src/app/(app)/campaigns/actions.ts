"use server";
import { revalidatePath } from "next/cache";
import { after } from "next/server";
import { z } from "zod";
import { assertRole, audit, CAN_MANAGE_CAMPAIGNS } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { loadWaConfig } from "@/lib/whatsapp/config";
import { getTemplate } from "@/lib/whatsapp/api";
import { validateMapping, type HeaderMedia, type LeadForRender, type VariableMapping } from "@/lib/whatsapp/send";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireConfig } from "@/lib/whatsapp/config";
import { createInboxDeps } from "@/lib/inbox/deps";
import {
  estimateCost, homeCountry, loadAudienceSummary, loadPricingSettings, type AudienceSummary, type CostEstimate,
} from "@/lib/campaigns/audience";
import { executeTestSend, planTestSend, type TestSendPlan } from "@/lib/campaigns/test-send";
import { templateShape } from "@/lib/whatsapp/templates";
import { processQueue, type ProcessStats } from "@/lib/worker/process";
import { toFail, type Result } from "@/lib/action-result";
import type { WhatsAppTemplate } from "@/lib/types";

const audienceSchema = z.object({
  segment_ids: z.array(z.uuid()).max(20).default([]),
  tag_ids: z.array(z.uuid()).max(50).default([]),
  tag_match: z.enum(["any", "all"]).default("any"),
});

export interface AudiencePreview {
  summary: AudienceSummary;
  cost: CostEstimate;
  sample: LeadForRender[];
}

/**
 * Server-calculated audience breakdown and cost estimate, from the same SQL
 * classifier launch_campaign uses. Errors are returned, never shown as zero.
 */
export async function previewAudience(
  filter: z.input<typeof audienceSchema>,
  templateId?: string | null,
): Promise<Result<AudiencePreview>> {
  try {
    await assertRole(CAN_MANAGE_CAMPAIGNS);
    const f = audienceSchema.parse(filter);
    const supabase = await createClient();
    const settings = await loadPricingSettings(supabase);
    const { dialPrefix } = homeCountry(settings);
    let category: string | null = null;
    if (templateId) {
      const { data: t, error } = await supabase.from("whatsapp_templates").select("category").eq("id", z.uuid().parse(templateId)).maybeSingle();
      if (error) return { ok: false, error: `Could not load the template: ${error.message}` };
      category = t?.category ?? null;
    }
    const [summary, sampleIds] = await Promise.all([
      loadAudienceSummary(supabase, f, dialPrefix),
      supabase.rpc("audience_classify", { p_filter: f }).eq("reason", "eligible").limit(3),
    ]);
    const leadIds = ((sampleIds.data ?? []) as { lead_id: string }[]).map((r) => r.lead_id);
    const { data: sample } = leadIds.length
      ? await supabase.from("leads").select("full_name, organization, city, state, country, email, phone_e164, custom_fields").in("id", leadIds)
      : { data: [] };
    return { ok: true, data: { summary, cost: estimateCost(summary, category, settings), sample: (sample ?? []) as LeadForRender[] } };
  } catch (e) {
    return toFail(e);
  }
}

const varSource = z.object({ source: z.enum(["field", "static"]), value: z.string().max(1024), fallback: z.string().max(1024).optional() });
const campaignSchema = z.object({
  name: z.string().trim().min(2, "Give the campaign a name").max(120),
  templateId: z.uuid({ message: "Choose an approved template" }),
  audience: audienceSchema,
  mapping: z.record(z.string().max(100), varSource),
  media: z
    .object({ type: z.enum(["image", "video", "document"]), link: z.string().trim().max(2000), filename: z.string().trim().max(240).optional() })
    .nullable(),
});

export async function saveCampaign(id: string | null, input: z.input<typeof campaignSchema>): Promise<Result<{ id: string }>> {
  try {
    const { profile } = await assertRole(CAN_MANAGE_CAMPAIGNS);
    const p = campaignSchema.safeParse(input);
    if (!p.success) return { ok: false, error: p.error.issues[0].message };
    const d = p.data;
    const supabase = await createClient();
    const { data: t } = await supabase.from("whatsapp_templates").select("*").eq("id", d.templateId).single<WhatsAppTemplate>();
    if (!t) return { ok: false, error: "Template not found" };
    if (t.status !== "APPROVED") return { ok: false, error: `Template status is ${t.status}. Only APPROVED templates can be used.` };
    const shape = templateShape(t.components);
    const media = shape.mediaHeader ? (d.media as HeaderMedia | null) : null;
    const errs = validateMapping(t.components, d.mapping as VariableMapping, media);
    if (errs.length) return { ok: false, error: errs[0] };
    const row = {
      name: d.name,
      template_id: t.id,
      audience_filter: d.audience,
      variable_mapping: d.mapping,
      header_media: media,
    };
    if (id) {
      const { data: cur } = await supabase.from("campaigns").select("status").eq("id", id).single();
      if (cur?.status !== "draft") return { ok: false, error: "Only draft campaigns can be edited." };
      const { error } = await supabase.from("campaigns").update(row).eq("id", id);
      if (error) return { ok: false, error: error.message };
      await audit("campaign.update", "campaign", id, { name: d.name });
      revalidatePath("/campaigns");
      return { ok: true, data: { id }, message: "Campaign saved" };
    }
    const { data, error } = await supabase.from("campaigns").insert({ ...row, created_by: profile.id }).select("id").single();
    if (error) return { ok: false, error: error.message };
    await audit("campaign.create", "campaign", data.id, { name: d.name, template: t.name });
    revalidatePath("/campaigns");
    return { ok: true, data: { id: data.id }, message: "Campaign saved as draft" };
  } catch (e) {
    return toFail(e);
  }
}

/**
 * Launch after explicit confirmation of the exact recipient count.
 * Live mode re-checks the template's status with Meta first; mock mode
 * runs a dry run that never calls Meta.
 */
export async function launchCampaign(id: string, confirmedCount: number): Promise<Result<{ recipients: number; dryRun: boolean }>> {
  try {
    await assertRole(CAN_MANAGE_CAMPAIGNS);
    const supabase = await createClient();
    const { data: c } = await supabase.from("campaigns").select("*, whatsapp_templates(*)").eq("id", z.uuid().parse(id)).single();
    if (!c) return { ok: false, error: "Campaign not found" };
    let t = c.whatsapp_templates as WhatsAppTemplate | null;
    if (!t) return { ok: false, error: "Campaign has no template" };
    if (!t.meta_template_id) return { ok: false, error: "This template isn't known to Meta. Submit it and wait for approval." };
    const cfg = await loadWaConfig();
    const dryRun = cfg.mode !== "live";

    if (!dryRun) {
      const live = await getTemplate(cfg, t.meta_template_id);
      await supabase
        .from("whatsapp_templates")
        .update({ status: live.status, components: live.components, quality_score: live.quality_score?.score ?? null, last_synced_at: new Date().toISOString() })
        .eq("id", t.id);
      t = { ...t, status: live.status, components: live.components };
    }
    if (t.status !== "APPROVED") return { ok: false, error: `Template status is ${t.status} on Meta. Only APPROVED templates can be sent.` };
    if (t.category !== "MARKETING" && t.category !== "UTILITY") return { ok: false, error: `${t.category} templates can't be used for campaigns.` };
    const errs = validateMapping(t.components, c.variable_mapping, c.header_media);
    if (errs.length) return { ok: false, error: errs[0] };

    const snapshot = { name: t.name, language: t.language, category: t.category, components: t.components };
    const settings = await loadPricingSettings(supabase);
    const cost = estimateCost({ eligible: 0, eligible_home: 0 }, t.category, settings);
    // launch_campaign re-runs the shared eligibility classifier and refuses if the
    // count differs from what the user confirmed; a repeat call fails (not draft).
    const { data: n, error } = await supabase.rpc("launch_campaign", {
      p_campaign_id: c.id,
      p_expected_count: confirmedCount,
      p_dry_run: dryRun,
      p_template_snapshot: snapshot,
      p_est_rate: cost.rateDecimal,
      p_home_prefix: cost.dialPrefix,
      p_est_country: cost.country,
    });
    if (error) return { ok: false, error: error.message };
    // Start sending right away; the scheduled worker continues from here.
    after(async () => {
      try {
        await processQueue({ budgetMs: 25_000 });
      } catch (e) {
        console.error("[launch] initial processing failed", e);
      }
    });
    revalidatePath("/campaigns");
    revalidatePath(`/campaigns/${c.id}`);
    return {
      ok: true,
      data: { recipients: Number(n), dryRun },
      message: dryRun
        ? `Dry run started for ${n} recipients — nothing will be sent to Meta.`
        : `${n} recipients queued. Messages are sent in the background; watch the status counts below.`,
    };
  } catch (e) {
    return toFail(e);
  }
}

export async function controlCampaign(id: string, action: "pause" | "resume" | "cancel" | "retry_failed"): Promise<Result<{ status: string }>> {
  try {
    await assertRole(CAN_MANAGE_CAMPAIGNS);
    const supabase = await createClient();
    const { data, error } = await supabase.rpc("campaign_control", { p_campaign_id: z.uuid().parse(id), p_action: action });
    if (error) return { ok: false, error: error.message };
    revalidatePath(`/campaigns/${id}`);
    return { ok: true, data: { status: String(data) }, message: `Campaign ${String(data)}` };
  } catch (e) {
    return toFail(e);
  }
}

/** Manually process a batch now (e.g. local development without a scheduler). */
export async function processNow(): Promise<Result<ProcessStats>> {
  try {
    await assertRole(CAN_MANAGE_CAMPAIGNS);
    const stats = await processQueue({ budgetMs: 20_000 });
    revalidatePath("/campaigns", "layout");
    return { ok: true, data: stats, message: `Processed ${stats.claimed} recipient(s)` };
  } catch (e) {
    return toFail(e);
  }
}

export async function deleteDraftCampaign(id: string): Promise<Result> {
  try {
    await assertRole(CAN_MANAGE_CAMPAIGNS);
    const supabase = await createClient();
    const { error, count } = await supabase.from("campaigns").delete({ count: "exact" }).eq("id", z.uuid().parse(id)).eq("status", "draft");
    if (error) return { ok: false, error: error.message };
    if (!count) return { ok: false, error: "Only drafts can be deleted." };
    await audit("campaign.delete", "campaign", id);
    revalidatePath("/campaigns");
    return { ok: true, data: null, message: "Draft deleted" };
  } catch (e) {
    return toFail(e);
  }
}

// ---------------------------------------------------------------------
// Send test message: one approved template → one explicitly chosen number.
// Never enqueues campaign recipients and never runs the campaign worker.
// ---------------------------------------------------------------------

const TEST_SENDS_PER_HOUR = 10;

const testSchema = z.object({
  campaignId: z.uuid(),
  phone: z.string().trim().min(6, "Enter the test WhatsApp number").max(30),
});

export interface TestSendPreview {
  plan: TestSendPlan;
  templateName: string;
  language: string;
  category: string;
}

async function loadTestContext(input: z.input<typeof testSchema>) {
  const p = testSchema.parse(input);
  const supabase = await createClient();
  const { data: c, error } = await supabase.from("campaigns").select("*, whatsapp_templates(*)").eq("id", p.campaignId).maybeSingle();
  if (error) throw new Error(`Could not load the campaign: ${error.message}`);
  if (!c) throw new Error("Campaign not found");
  const t = c.whatsapp_templates as WhatsAppTemplate | null;
  if (!t) throw new Error("Choose an approved template first.");
  const settings = await loadPricingSettings(supabase);
  return { p, supabase, c, t, settings };
}

async function leadForPhone(supabase: Awaited<ReturnType<typeof createClient>>, e164: string) {
  const { data } = await supabase
    .from("leads")
    .select("full_name, organization, city, state, country, email, phone_e164, custom_fields")
    .eq("phone_e164", e164)
    .maybeSingle();
  return (data ?? null) as (LeadForRender & { full_name: string | null }) | null;
}

/** Step 1: validate and render the exact test message. Sends nothing. */
export async function prepareTestSend(input: z.input<typeof testSchema>): Promise<Result<TestSendPreview>> {
  try {
    await assertRole(CAN_MANAGE_CAMPAIGNS);
    const { p, supabase, c, t, settings } = await loadTestContext(input);
    const snapshot = { name: t.name, language: t.language, category: t.category, components: t.components };
    const first = planTestSend({ phone: p.phone, defaultCountry: settings.default_country, template: snapshot, mapping: c.variable_mapping, media: c.header_media, lead: null });
    if (!first.ok) return { ok: false, error: first.errors[0] };
    const lead = await leadForPhone(supabase, first.plan.to);
    const planned = lead ? planTestSend({ phone: p.phone, defaultCountry: settings.default_country, template: snapshot, mapping: c.variable_mapping, media: c.header_media, lead }) : first;
    if (!planned.ok) return { ok: false, error: planned.errors[0] };
    return { ok: true, data: { plan: planned.plan, templateName: t.name, language: t.language, category: t.category } };
  } catch (e) {
    return toFail(e);
  }
}

/**
 * Step 2 (after explicit confirmation): re-check approval with Meta and send
 * the template to the single test number via the live Cloud API.
 */
export async function sendTestMessage(
  input: z.input<typeof testSchema> & { clientKey: string; confirmed: boolean },
): Promise<Result<{ wamid: string; to: string }>> {
  try {
    const { profile } = await assertRole(CAN_MANAGE_CAMPAIGNS);
    if (input.confirmed !== true) return { ok: false, error: "Confirm the test send first." };
    const clientKey = z.uuid().parse(input.clientKey);
    const cfg = await loadWaConfig();
    if (cfg.mode !== "live") return { ok: false, error: "Test sends need WHATSAPP_MODE=live. Mock mode never contacts WhatsApp." };
    requireConfig(cfg, ["token", "phoneNumberId"]);
    const { p, supabase, c, t, settings } = await loadTestContext(input);
    if (!t.meta_template_id) return { ok: false, error: "This template isn't known to Meta. Submit it and wait for approval." };

    // Rate-limit accidental repeats.
    const since = new Date(Date.now() - 3600_000).toISOString();
    const { count } = await supabase
      .from("audit_logs")
      .select("id", { count: "exact", head: true })
      .eq("action", "campaign.test_send")
      .eq("actor_id", profile.id)
      .gte("created_at", since);
    if ((count ?? 0) >= TEST_SENDS_PER_HOUR) return { ok: false, error: `Limit reached: ${TEST_SENDS_PER_HOUR} test sends per hour.` };

    // Never bypass approval: ask Meta for the template's current status.
    const live = await getTemplate(cfg, t.meta_template_id);
    await supabase
      .from("whatsapp_templates")
      .update({ status: live.status, components: live.components, last_synced_at: new Date().toISOString() })
      .eq("id", t.id);
    if (live.status !== "APPROVED") return { ok: false, error: `Template status on Meta is ${live.status}. Only APPROVED templates can be sent.` };

    const snapshot = { name: t.name, language: t.language, category: t.category, components: live.components };
    const phone = planTestSend({ phone: p.phone, defaultCountry: settings.default_country, template: snapshot, mapping: c.variable_mapping, media: c.header_media, lead: null });
    if (!phone.ok) return { ok: false, error: phone.errors[0] };
    const { data: suppressed } = await supabase.from("opt_outs").select("phone_e164").eq("phone_e164", phone.plan.to).maybeSingle();
    if (suppressed) return { ok: false, error: "That number has opted out and is permanently suppressed." };
    const lead = await leadForPhone(supabase, phone.plan.to);
    const planned = planTestSend({ phone: p.phone, defaultCountry: settings.default_country, template: snapshot, mapping: c.variable_mapping, media: c.header_media, lead });
    if (!planned.ok) return { ok: false, error: planned.errors[0] };

    const deps = await createInboxDeps(createAdminClient(), async () => {});
    const r = await executeTestSend(deps, { plan: planned.plan, template: snapshot, clientKey, userId: profile.id });
    await audit("campaign.test_send", "campaign", c.id, {
      to: planned.plan.to, template: t.name, result: r.duplicate ? "duplicate" : r.result, wamid: r.wamid ?? null, error_code: r.errorCode ?? null,
    });
    revalidatePath(`/campaigns/${c.id}`);
    if (r.duplicate) return { ok: false, error: "This test was already submitted." };
    if (r.result !== "sent" || !r.wamid) {
      return { ok: false, error: `WhatsApp rejected the test${r.errorCode ? ` (error ${r.errorCode})` : ""}: ${r.error ?? "unknown error"}` };
    }
    return { ok: true, data: { wamid: r.wamid, to: planned.plan.to }, message: `Test accepted by WhatsApp for ${planned.plan.to}. Delivery status appears in the Inbox.` };
  } catch (e) {
    return toFail(e);
  }
}
