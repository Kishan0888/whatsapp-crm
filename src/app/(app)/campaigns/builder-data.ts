import "server-only";
import { createClient } from "@/lib/supabase/server";
import { templateShape } from "@/lib/whatsapp/templates";
import type { Segment, Tag, WhatsAppTemplate } from "@/lib/types";

/** Everything the campaign builder needs, loaded as the signed-in user. */
export async function loadBuilderData() {
  const supabase = await createClient();
  const [{ data: templates }, { data: segments }, { data: tags }, { data: custom }] = await Promise.all([
    supabase.from("whatsapp_templates").select("*").eq("status", "APPROVED").in("category", ["MARKETING", "UTILITY"]).order("name"),
    supabase.from("segments").select("*").order("sort_order"),
    supabase.from("tags").select("*").order("name"),
    supabase.from("leads").select("custom_fields").neq("custom_fields", "{}").limit(1000),
  ]);
  const customKeys = [...new Set((custom ?? []).flatMap((r) => Object.keys((r.custom_fields as Record<string, unknown>) ?? {})))].sort().slice(0, 100);
  return {
    templates: ((templates ?? []) as WhatsAppTemplate[]).filter((t) => !templateShape(t.components).unsupported),
    segments: (segments ?? []) as Segment[],
    tags: (tags ?? []) as Tag[],
    customKeys,
  };
}
