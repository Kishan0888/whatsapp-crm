import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { loadWaConfig } from "@/lib/whatsapp/config";
import { renderPreview, templateShape, type MetaComponent } from "@/lib/whatsapp/templates";
import type { FlowContext } from "./flows";
import type { InboxDeps, Rpc } from "./handler";

export function supabaseRpc(admin: SupabaseClient): Rpc {
  return async <T,>(fn: string, args: Record<string, unknown>) => {
    const { data, error } = await admin.rpc(fn, args);
    if (error) throw new Error(`${fn}: ${error.message}`);
    return data as T;
  };
}

/** A template usable for the growth-report reply: approved, no variables, no media header, has a URL button. */
export function isGrowthTemplateUsable(t: { status: string; components: MetaComponent[] }): boolean {
  const shape = templateShape(t.components ?? []);
  const hasUrl = (t.components ?? []).some((c) => c.type === "BUTTONS" && c.buttons?.some((b) => b.type.toUpperCase() === "URL"));
  return t.status === "APPROVED" && !shape.unsupported && !shape.mediaHeader && shape.variables.length === 0 && hasUrl;
}

export async function loadFlowSettings(admin: SupabaseClient): Promise<Omit<FlowContext, "now">> {
  const { data: s } = await admin.from("app_settings").select("meeting_url, growth_report_template_id").eq("id", 1).single();
  let growthTemplate: FlowContext["growthTemplate"] = null;
  if (s?.growth_report_template_id) {
    const { data: t } = await admin
      .from("whatsapp_templates")
      .select("name, language, category, status, components")
      .eq("id", s.growth_report_template_id)
      .maybeSingle();
    if (t && isGrowthTemplateUsable(t)) {
      growthTemplate = {
        snapshot: { name: t.name, language: t.language, category: t.category, components: t.components },
        body: renderPreview(t.components).body,
      };
    }
  }
  return { meetingUrl: s?.meeting_url ?? null, growthTemplate };
}

export async function createInboxDeps(
  admin: SupabaseClient,
  optOut: InboxDeps["optOut"],
): Promise<InboxDeps> {
  let settings: Promise<Omit<FlowContext, "now">> | null = null;
  return {
    rpc: supabaseRpc(admin),
    cfg: await loadWaConfig(),
    flowSettings: () => (settings ??= loadFlowSettings(admin)),
    optOut,
  };
}
