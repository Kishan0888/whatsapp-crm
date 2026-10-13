"use server";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { assertRole, audit, CAN_MANAGE_CAMPAIGNS } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { loadWaConfig } from "@/lib/whatsapp/config";
import { createTemplate, deleteTemplate, editTemplate, getTemplate, listTemplates, type MetaTemplate } from "@/lib/whatsapp/api";
import { buildComponents, draftFromTemplate, validateDraft, type TemplateDraft } from "@/lib/whatsapp/templates";
import { toFail, type Result } from "@/lib/action-result";
import type { WhatsAppTemplate } from "@/lib/types";

const EDITABLE = ["DRAFT", "REJECTED", "PAUSED", "APPROVED"];

const draftSchema = z.object({
  name: z.string().trim().regex(/^[a-z0-9_]+$/, "Name: lowercase letters, numbers and underscores only").max(512),
  language: z.string().min(2).max(10),
  category: z.enum(["MARKETING", "UTILITY"]),
  header: z.object({
    format: z.enum(["NONE", "TEXT", "IMAGE", "VIDEO", "DOCUMENT"]),
    text: z.string().max(200),
    example: z.string().max(200),
    handle: z.string().max(2000),
  }),
  body: z.object({ text: z.string().max(4000), examples: z.array(z.string().max(500)).max(100) }),
  footer: z.string().max(200),
  buttons: z
    .array(
      z.discriminatedUnion("type", [
        z.object({ type: z.literal("QUICK_REPLY"), text: z.string().max(100) }),
        z.object({ type: z.literal("URL"), text: z.string().max(100), url: z.string().max(2100), example: z.string().max(500) }),
        z.object({ type: z.literal("PHONE_NUMBER"), text: z.string().max(100), phone: z.string().max(30) }),
      ]),
    )
    .max(10),
});

function toRow(t: MetaTemplate) {
  return {
    meta_template_id: t.id,
    name: t.name,
    language: t.language,
    category: t.category,
    status: t.status,
    rejected_reason: t.rejected_reason && t.rejected_reason !== "NONE" ? t.rejected_reason : null,
    quality_score: t.quality_score?.score ?? null,
    components: t.components ?? [],
    last_synced_at: new Date().toISOString(),
  };
}

/** Save a local draft (or local edits to a submitted template). Never contacts Meta. */
export async function saveTemplateDraft(id: string | null, input: TemplateDraft): Promise<Result<{ id: string }>> {
  try {
    const { profile } = await assertRole(CAN_MANAGE_CAMPAIGNS);
    const p = draftSchema.safeParse(input);
    if (!p.success) return { ok: false, error: p.error.issues[0].message };
    const draft = p.data as TemplateDraft;
    const supabase = await createClient();
    const components = buildComponents(draft);

    if (id) {
      const { data: cur } = await supabase.from("whatsapp_templates").select("*").eq("id", id).single<WhatsAppTemplate>();
      if (!cur) return { ok: false, error: "Template not found" };
      if (!EDITABLE.includes(cur.status)) return { ok: false, error: `Templates with status ${cur.status} can't be edited.` };
      const submitted = !!cur.meta_template_id;
      if (submitted && (cur.name !== draft.name || cur.language !== draft.language || cur.category !== draft.category))
        return { ok: false, error: "Name, language and category can't change after submission. Create a new template instead." };
      const { error } = await supabase
        .from("whatsapp_templates")
        .update(submitted ? { example_data: { draft, dirty: true } } : { name: draft.name, language: draft.language, category: draft.category, components, example_data: { draft } })
        .eq("id", id);
      if (error) return { ok: false, error: error.code === "23505" ? "A template with this name and language already exists." : error.message };
      await audit("template.save_draft", "template", id, { name: draft.name });
      revalidatePath("/templates");
      return { ok: true, data: { id }, message: submitted ? "Changes saved locally — submit to send them to Meta" : "Draft saved" };
    }
    const { data, error } = await supabase
      .from("whatsapp_templates")
      .insert({ name: draft.name, language: draft.language, category: draft.category, components, example_data: { draft }, created_by: profile.id })
      .select("id")
      .single();
    if (error) return { ok: false, error: error.code === "23505" ? "A template with this name and language already exists." : error.message };
    await audit("template.create_draft", "template", data.id, { name: draft.name });
    revalidatePath("/templates");
    return { ok: true, data: { id: data.id }, message: "Draft saved" };
  } catch (e) {
    return toFail(e);
  }
}

/** Submit a new template (create) or local edits (edit) to Meta, then read back the real status. */
export async function submitTemplate(id: string): Promise<Result<{ status: string }>> {
  try {
    await assertRole(CAN_MANAGE_CAMPAIGNS);
    const supabase = await createClient();
    const { data: t } = await supabase.from("whatsapp_templates").select("*").eq("id", z.uuid().parse(id)).single<WhatsAppTemplate>();
    if (!t) return { ok: false, error: "Template not found" };
    const draft = t.example_data?.draft ?? draftFromTemplate(t);
    if (!draft) return { ok: false, error: "This template can't be edited in the CRM. Edit it in WhatsApp Manager." };
    const v = validateDraft(draft);
    if (v.errors.length) return { ok: false, error: v.errors[0] };
    const components = buildComponents(draft);
    const cfg = await loadWaConfig();

    let metaId = t.meta_template_id;
    if (!metaId) {
      const res = await createTemplate(cfg, { name: draft.name, language: draft.language, category: draft.category, components });
      metaId = res.id;
      await supabase.from("whatsapp_templates").update({ meta_template_id: metaId, status: res.status, category: res.category ?? draft.category, components, submitted_at: new Date().toISOString() }).eq("id", t.id);
    } else {
      if (!["APPROVED", "REJECTED", "PAUSED"].includes(t.status)) return { ok: false, error: `Meta only allows editing APPROVED, REJECTED or PAUSED templates (this one is ${t.status}).` };
      await editTemplate(cfg, metaId, components);
      await supabase.from("whatsapp_templates").update({ submitted_at: new Date().toISOString() }).eq("id", t.id);
    }
    // Read back the actual state from Meta — never assume approval.
    const live = await getTemplate(cfg, metaId);
    await supabase.from("whatsapp_templates").update({ ...toRow(live), example_data: { draft } }).eq("id", t.id);
    await audit(t.meta_template_id ? "template.edit_submit" : "template.submit", "template", t.id, { meta_id: metaId, status: live.status });
    revalidatePath("/templates");
    return { ok: true, data: { status: live.status }, message: `Submitted. Meta status: ${live.status}` };
  } catch (e) {
    return toFail(e);
  }
}

/** Pull every template from the WABA and mirror its real status locally. Read-only on Meta's side. */
export async function syncTemplates(): Promise<Result<{ count: number }>> {
  try {
    await assertRole(CAN_MANAGE_CAMPAIGNS);
    const cfg = await loadWaConfig();
    const remote = await listTemplates(cfg);
    const supabase = await createClient();
    if (remote.length) {
      const { error } = await supabase.from("whatsapp_templates").upsert(remote.map(toRow), { onConflict: "name,language" });
      if (error) return { ok: false, error: error.message };
    }
    // Templates we know by Meta id that no longer exist remotely.
    const ids = new Set(remote.map((t) => t.id));
    const { data: local } = await supabase.from("whatsapp_templates").select("id, meta_template_id").not("meta_template_id", "is", null);
    const gone = (local ?? []).filter((t) => !ids.has(t.meta_template_id!)).map((t) => t.id);
    if (gone.length) await supabase.from("whatsapp_templates").update({ status: "DELETED", last_synced_at: new Date().toISOString() }).in("id", gone);
    await audit("template.sync", "template", null, { count: remote.length, removed: gone.length });
    revalidatePath("/templates");
    return { ok: true, data: { count: remote.length }, message: `Synced ${remote.length} template(s) from Meta` };
  } catch (e) {
    return toFail(e);
  }
}

export async function removeTemplate(id: string): Promise<Result> {
  try {
    await assertRole(CAN_MANAGE_CAMPAIGNS);
    const supabase = await createClient();
    const { data: t } = await supabase.from("whatsapp_templates").select("*").eq("id", z.uuid().parse(id)).single<WhatsAppTemplate>();
    if (!t) return { ok: false, error: "Template not found" };
    if (t.meta_template_id && t.status !== "DELETED") {
      await deleteTemplate(await loadWaConfig(), t.meta_template_id, t.name);
    }
    const { error } = await supabase.from("whatsapp_templates").delete().eq("id", t.id);
    if (error) {
      // Referenced by campaigns: keep the row for history.
      await supabase.from("whatsapp_templates").update({ status: "DELETED" }).eq("id", t.id);
    }
    await audit("template.delete", "template", t.id, { name: t.name, meta_id: t.meta_template_id });
    revalidatePath("/templates");
    return { ok: true, data: null, message: t.meta_template_id ? "Deleted from Meta and the CRM" : "Draft deleted" };
  } catch (e) {
    return toFail(e);
  }
}
