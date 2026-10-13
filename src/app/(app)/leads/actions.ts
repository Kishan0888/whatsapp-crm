"use server";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { assertRole, audit, AuthError, CAN_EDIT_LEADS } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { normalizePhone } from "@/lib/phone";

export type ActionResult<T = undefined> = { ok: true; data?: T; message?: string } | { ok: false; error: string };

const fail = (e: unknown): { ok: false; error: string } => ({
  ok: false,
  error: e instanceof AuthError || e instanceof Error ? e.message : "Unexpected error",
});

const ids = z.array(z.uuid()).min(1).max(5000);
const opt = (s: z.ZodString) => s.trim().max(500).optional().transform((v) => (v ? v : null));

const leadSchema = z.object({
  id: z.uuid().optional(),
  full_name: opt(z.string()),
  organization: opt(z.string()),
  phone: z.string().trim().min(1, "Phone is required"),
  email: z
    .string()
    .trim()
    .max(320)
    .optional()
    .transform((v) => (v ? v.toLowerCase() : null))
    .refine((v) => !v || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v), "Invalid email"),
  city: opt(z.string()),
  state: opt(z.string()),
  country: opt(z.string()),
  source: opt(z.string()),
  notes: z.string().trim().max(5000).optional().transform((v) => v || null),
  segment_id: z.union([z.uuid(), z.literal("")]).transform((v) => v || null),
  status: z.enum(["new", "contacted", "interested", "not_interested", "converted"]),
  tag_ids: z.array(z.uuid()).default([]),
  default_country: z.string().length(2).default("IN"),
});

export async function saveLead(input: z.input<typeof leadSchema>): Promise<ActionResult<{ id: string }>> {
  try {
    const { profile } = await assertRole(CAN_EDIT_LEADS);
    const parsed = leadSchema.safeParse(input);
    if (!parsed.success) return { ok: false, error: parsed.error.issues[0].message };
    const { id, phone, tag_ids, default_country, ...fields } = parsed.data;
    const norm = normalizePhone(phone, default_country);
    if (!norm.ok) return { ok: false, error: norm.error };

    const supabase = await createClient();
    const row = { ...fields, phone_raw: phone, phone_e164: norm.e164 };
    const res = id
      ? await supabase.from("leads").update(row).eq("id", id).select("id").single()
      : await supabase.from("leads").insert({ ...row, created_by: profile.id, source: row.source ?? "manual" }).select("id").single();

    if (res.error) {
      if (res.error.code === "23505") {
        const { data: other } = await supabase.from("leads").select("id").eq("phone_e164", norm.e164).single();
        return { ok: false, error: `Another lead already uses ${norm.e164}${other ? ` (lead ${other.id.slice(0, 8)})` : ""}.` };
      }
      return { ok: false, error: res.error.message };
    }
    const leadId = res.data.id as string;

    // Replace tag set.
    const del = await supabase.from("lead_tags").delete().eq("lead_id", leadId);
    if (del.error) return { ok: false, error: del.error.message };
    if (tag_ids.length) {
      const ins = await supabase.from("lead_tags").insert(tag_ids.map((tag_id) => ({ lead_id: leadId, tag_id })));
      if (ins.error) return { ok: false, error: ins.error.message };
    }

    await audit(id ? "lead.update" : "lead.create", "lead", leadId, { phone: norm.e164 });
    revalidatePath("/leads");
    return { ok: true, data: { id: leadId } };
  } catch (e) {
    return fail(e);
  }
}

export async function setArchived(leadIds: string[], archived: boolean): Promise<ActionResult> {
  try {
    await assertRole(CAN_EDIT_LEADS);
    const parsed = ids.parse(leadIds);
    const supabase = await createClient();
    const { error } = await supabase
      .from("leads")
      .update({ is_archived: archived, archived_at: archived ? new Date().toISOString() : null })
      .in("id", parsed);
    if (error) return { ok: false, error: error.message };
    await audit(archived ? "lead.archive" : "lead.unarchive", "lead", null, { count: parsed.length, ids: parsed.slice(0, 50) });
    revalidatePath("/leads");
    return { ok: true, message: `${parsed.length} lead(s) ${archived ? "archived" : "restored"}` };
  } catch (e) {
    return fail(e);
  }
}

export async function bulkSetSegment(leadIds: string[], segmentId: string | null): Promise<ActionResult> {
  try {
    await assertRole(CAN_EDIT_LEADS);
    const parsed = ids.parse(leadIds);
    const seg = segmentId ? z.uuid().parse(segmentId) : null;
    const supabase = await createClient();
    const { error } = await supabase.from("leads").update({ segment_id: seg }).in("id", parsed);
    if (error) return { ok: false, error: error.message };
    await audit("lead.bulk_segment", "lead", null, { count: parsed.length, segment_id: seg });
    revalidatePath("/leads");
    return { ok: true, message: `Segment updated for ${parsed.length} lead(s)` };
  } catch (e) {
    return fail(e);
  }
}

/** Find or create a tag by name (case-insensitive). */
async function ensureTag(supabase: Awaited<ReturnType<typeof createClient>>, name: string): Promise<string> {
  const clean = name.trim().slice(0, 60);
  if (!clean) throw new Error("Tag name is required");
  const { data: existing } = await supabase.from("tags").select("id").ilike("name", clean.replace(/[%_\\]/g, "\\$&")).maybeSingle();
  if (existing) return existing.id;
  const { data, error } = await supabase.from("tags").insert({ name: clean }).select("id").single();
  if (error) throw new Error(error.message);
  return data.id;
}

export async function createTag(name: string): Promise<ActionResult<{ id: string; name: string }>> {
  try {
    await assertRole(CAN_EDIT_LEADS);
    const supabase = await createClient();
    const id = await ensureTag(supabase, name);
    revalidatePath("/leads");
    return { ok: true, data: { id, name: name.trim() } };
  } catch (e) {
    return fail(e);
  }
}

export async function bulkAddTag(leadIds: string[], tagName: string): Promise<ActionResult> {
  try {
    await assertRole(CAN_EDIT_LEADS);
    const parsed = ids.parse(leadIds);
    const supabase = await createClient();
    const tagId = await ensureTag(supabase, tagName);
    const { error } = await supabase
      .from("lead_tags")
      .upsert(parsed.map((lead_id) => ({ lead_id, tag_id: tagId })), { onConflict: "lead_id,tag_id", ignoreDuplicates: true });
    if (error) return { ok: false, error: error.message };
    await audit("lead.bulk_tag", "lead", null, { count: parsed.length, tag: tagName });
    revalidatePath("/leads");
    return { ok: true, message: `Tagged ${parsed.length} lead(s) "${tagName.trim()}"` };
  } catch (e) {
    return fail(e);
  }
}

const consentSchema = z.object({
  leadId: z.uuid(),
  status: z.enum(["opted_in", "opted_out"]),
  evidence: z.string().trim().min(3, "Describe how/when consent was given or withdrawn").max(1000),
});

/**
 * Record marketing consent. Opt-outs go into the permanent suppression list
 * and cannot be reversed from the UI.
 */
export async function recordConsent(input: z.input<typeof consentSchema>): Promise<ActionResult> {
  try {
    const { profile } = await assertRole(CAN_EDIT_LEADS);
    const p = consentSchema.safeParse(input);
    if (!p.success) return { ok: false, error: p.error.issues[0].message };
    const supabase = await createClient();
    const { data: lead, error } = await supabase.from("leads").select("id, phone_e164, marketing_consent").eq("id", p.data.leadId).single();
    if (error || !lead) return { ok: false, error: "Lead not found" };
    if (!lead.phone_e164) return { ok: false, error: "Lead has no phone number" };

    if (p.data.status === "opted_out") {
      const { error: e } = await supabase
        .from("opt_outs")
        .upsert({ phone_e164: lead.phone_e164, reason: p.data.evidence, source: "manual", created_by: profile.id }, { onConflict: "phone_e164", ignoreDuplicates: true });
      if (e) return { ok: false, error: e.message };
    } else {
      if (lead.marketing_consent === "opted_out") return { ok: false, error: "This number is permanently opted out and cannot be re-opted in." };
      const { error: e } = await supabase
        .from("leads")
        .update({ marketing_consent: "opted_in", consent_source: "manual", consent_at: new Date().toISOString() })
        .eq("id", lead.id);
      if (e) return { ok: false, error: e.message };
    }
    await supabase.from("consent_events").insert({
      lead_id: lead.id,
      phone_e164: lead.phone_e164,
      status: p.data.status,
      source: "manual",
      evidence: p.data.evidence,
      created_by: profile.id,
    });
    await audit(`consent.${p.data.status}`, "lead", lead.id, { evidence: p.data.evidence });
    revalidatePath(`/leads/${lead.id}`);
    return { ok: true, message: p.data.status === "opted_out" ? "Number permanently suppressed" : "Opt-in recorded" };
  } catch (e) {
    return fail(e);
  }
}
