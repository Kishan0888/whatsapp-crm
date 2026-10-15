"use server";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { ADMIN_ONLY, assertRole, audit, AuthError } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { isGrowthTemplateUsable } from "@/lib/inbox/deps";
import { saveTemplateDraft } from "../templates/actions";

type R = { ok: true; message?: string } | { ok: false; error: string };
const fail = (e: unknown): R => ({ ok: false, error: e instanceof AuthError || e instanceof Error ? e.message : "Unexpected error" });

const role = z.enum(["admin", "manager", "agent", "viewer"]);

export async function updateUser(input: { id: string; role: string; is_active: boolean }): Promise<R> {
  try {
    const { profile } = await assertRole(ADMIN_ONLY);
    const p = z.object({ id: z.uuid(), role, is_active: z.boolean() }).parse(input);
    if (p.id === profile.id && (p.role !== "admin" || !p.is_active)) return { ok: false, error: "You can't demote or deactivate yourself." };
    const supabase = await createClient();
    const { error } = await supabase.from("profiles").update({ role: p.role, is_active: p.is_active }).eq("id", p.id);
    if (error) return { ok: false, error: error.message };
    await audit("user.update", "profile", p.id, { role: p.role, is_active: p.is_active });
    revalidatePath("/settings");
    return { ok: true, message: "User updated" };
  } catch (e) {
    return fail(e);
  }
}

export async function inviteUser(input: { email: string; full_name: string; role: string }): Promise<R> {
  try {
    await assertRole(ADMIN_ONLY);
    const p = z.object({ email: z.email(), full_name: z.string().trim().max(120), role }).parse(input);
    const admin = createAdminClient();
    const { data, error } = await admin.auth.admin.inviteUserByEmail(p.email, {
      data: { full_name: p.full_name },
      redirectTo: `${process.env.NEXT_PUBLIC_APP_URL ?? ""}/login`,
    });
    if (error) return { ok: false, error: error.message };
    // The auth trigger creates the profile as viewer; apply the chosen role.
    if (data.user && p.role !== "viewer") {
      const { error: e } = await admin.from("profiles").update({ role: p.role }).eq("id", data.user.id);
      if (e) return { ok: false, error: e.message };
    }
    await audit("user.invite", "profile", data.user?.id, { email: p.email, role: p.role });
    revalidatePath("/settings");
    return { ok: true, message: `Invitation sent to ${p.email}` };
  } catch (e) {
    return fail(e);
  }
}

const settingsSchema = z.object({
  waba_id: z.string().trim().regex(/^\d*$/, "WABA ID must be numeric").max(40),
  phone_number_id: z.string().trim().regex(/^\d*$/, "Phone number ID must be numeric").max(40),
  business_display_name: z.string().trim().max(120),
  graph_api_version: z.string().trim().regex(/^v\d+\.\d+$/, "Use the form v23.0"),
  currency: z.string().trim().regex(/^[A-Z]{3}$/),
  est_rate_marketing: z.coerce.number().min(0).max(1000),
  est_rate_utility: z.coerce.number().min(0).max(1000),
  send_rate_per_second: z.coerce.number().int().min(1).max(80),
});

export async function saveSettings(input: Record<string, string>): Promise<R> {
  try {
    const { profile } = await assertRole(ADMIN_ONLY);
    const p = settingsSchema.safeParse(input);
    if (!p.success) return { ok: false, error: p.error.issues[0].message };
    const d = p.data;
    const supabase = await createClient();
    const { error } = await supabase
      .from("app_settings")
      .update({ ...d, waba_id: d.waba_id || null, phone_number_id: d.phone_number_id || null, business_display_name: d.business_display_name || null, updated_by: profile.id })
      .eq("id", 1);
    if (error) return { ok: false, error: error.message };
    await audit("settings.update", "app_settings", "1", d);
    revalidatePath("/settings");
    return { ok: true, message: "Settings saved" };
  } catch (e) {
    return fail(e);
  }
}

const automationSchema = z.object({
  meeting_url: z
    .string()
    .trim()
    .max(2000)
    .refine((v) => v === "" || /^https:\/\/\S+$/.test(v), "Meeting URL must start with https://"),
  growth_report_template_id: z.union([z.uuid(), z.literal("")]),
});

/** Meeting link + optional approved template for the "Free Growth Report" reply. */
export async function saveAutomationSettings(input: { meeting_url: string; growth_report_template_id: string }): Promise<R> {
  try {
    const { profile } = await assertRole(ADMIN_ONLY);
    const p = automationSchema.safeParse(input);
    if (!p.success) return { ok: false, error: p.error.issues[0].message };
    const supabase = await createClient();
    if (p.data.growth_report_template_id) {
      const { data: t } = await supabase.from("whatsapp_templates").select("status, components").eq("id", p.data.growth_report_template_id).single();
      if (!t || !isGrowthTemplateUsable(t)) return { ok: false, error: "That template must be APPROVED, have a URL button and no variables or media header." };
    }
    const { error } = await supabase
      .from("app_settings")
      .update({ meeting_url: p.data.meeting_url || null, growth_report_template_id: p.data.growth_report_template_id || null, updated_by: profile.id })
      .eq("id", 1);
    if (error) return { ok: false, error: error.message };
    await audit("settings.automation", "app_settings", "1", p.data);
    revalidatePath("/settings");
    return { ok: true, message: "Automation settings saved" };
  } catch (e) {
    return fail(e);
  }
}

/** Local draft (not submitted) of a template with a 25-char "Schedule Your Meeting" URL button. */
export async function createGrowthTemplateDraft(): Promise<R & { id?: string }> {
  try {
    await assertRole(ADMIN_ONLY);
    const supabase = await createClient();
    const { data: s } = await supabase.from("app_settings").select("meeting_url").eq("id", 1).single();
    if (!s?.meeting_url) return { ok: false, error: "Save a meeting URL first." };
    const r = await saveTemplateDraft(null, {
      name: "growth_report_meeting",
      language: "en",
      category: "UTILITY",
      header: { format: "NONE", text: "", example: "", handle: "" },
      body: {
        text: "Thank you for requesting your Free Growth Report! Our team will prepare it for your hospital. Pick a convenient time for a short call so we can walk you through it.",
        examples: [],
      },
      footer: "",
      buttons: [{ type: "URL", text: "Schedule Your Meeting", url: s.meeting_url, example: "" }],
    });
    if (!r.ok) return { ok: false, error: r.error };
    return { ok: true, id: r.data.id, message: "Draft created — review and submit it in Templates" };
  } catch (e) {
    return fail(e);
  }
}
