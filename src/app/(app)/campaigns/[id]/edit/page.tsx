import { notFound, redirect } from "next/navigation";
import { requireUser, CAN_MANAGE_CAMPAIGNS } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { whatsappMode } from "@/lib/env";
import { PageHeader } from "@/components/page-header";
import type { Campaign } from "@/lib/types";
import { CampaignBuilder } from "../../campaign-builder";
import { loadBuilderData } from "../../builder-data";

export default async function EditCampaignPage({ params }: { params: Promise<{ id: string }> }) {
  await requireUser(CAN_MANAGE_CAMPAIGNS);
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const supabase = await createClient();
  const { data } = await supabase.from("campaigns").select("*").eq("id", id).maybeSingle();
  if (!data) notFound();
  const c = data as Campaign;
  if (c.status !== "draft") redirect(`/campaigns/${id}`);
  const builder = await loadBuilderData();
  return (
    <>
      <PageHeader title={`Edit: ${c.name}`} />
      <CampaignBuilder
        id={c.id}
        initial={{
          name: c.name,
          templateId: c.template_id ?? "",
          segmentIds: c.audience_filter.segment_ids ?? [],
          tagIds: c.audience_filter.tag_ids ?? [],
          tagMatch: c.audience_filter.tag_match ?? "any",
          mapping: c.variable_mapping,
          media: c.header_media,
        }}
        {...builder}
        live={whatsappMode() === "live"}
      />
    </>
  );
}
