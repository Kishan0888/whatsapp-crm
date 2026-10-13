"use server";
import { revalidatePath } from "next/cache";
import { after } from "next/server";
import { z } from "zod";
import { assertRole, audit, CAN_MANAGE_CAMPAIGNS } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { loadWaConfig } from "@/lib/whatsapp/config";
import { getTemplate } from "@/lib/whatsapp/api";
import { validateMapping, type HeaderMedia, type LeadForRender, type VariableMapping } from "@/lib/whatsapp/send";
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
  counts: { matching: number; eligible: number; no_phone: number; opted_out: number; no_consent: number };
  sample: LeadForRender[];
}

export async function previewAudience(filter: z.input<typeof audienceSchema>): Promise<Result<AudiencePreview>> {
  try {
    await assertRole(CAN_MANAGE_CAMPAIGNS);
    const f = audienceSchema.parse(filter);
    const supabase = await createClient();
    const [{ data: counts, error }, { data: ids }] = await Promise.all([
      supabase.rpc("audience_counts", { p_filter: f }),
      supabase.rpc("audience_leads", { p_filter: f }).eq("marketing_consent", "opted_in").eq("suppressed", false).not("phone_e164", "is", null).limit(3),
    ]);
    if (error) return { ok: false, error: error.message };
    const leadIds = ((ids ?? []) as { lead_id: string }[]).map((r) => r.lead_id);
    const { data: sample } = leadIds.length
      ? await supabase.from("leads").select("full_name, organization, city, state, country, email, phone_e164, custom_fields").in("id", leadIds)
      : { data: [] };
    return { ok: true, data: { counts: counts as AudiencePreview["counts"], sample: (sample ?? []) as LeadForRender[] } };
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
    const { data: n, error } = await supabase.rpc("launch_campaign", {
      p_campaign_id: c.id,
      p_expected_count: confirmedCount,
      p_dry_run: dryRun,
      p_template_snapshot: snapshot,
      p_est_rate: cfg.estRates[t.category as "MARKETING" | "UTILITY"] ?? 0,
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
      message: dryRun ? `Dry run started for ${n} recipients — nothing will be sent to Meta.` : `Campaign launched to ${n} recipients.`,
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
