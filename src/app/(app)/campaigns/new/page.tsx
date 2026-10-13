import { requireUser, CAN_MANAGE_CAMPAIGNS } from "@/lib/auth";
import { whatsappMode } from "@/lib/env";
import { PageHeader } from "@/components/page-header";
import { CampaignBuilder } from "../campaign-builder";
import { loadBuilderData } from "../builder-data";

export const metadata = { title: "New campaign" };

export default async function NewCampaignPage() {
  await requireUser(CAN_MANAGE_CAMPAIGNS);
  const data = await loadBuilderData();
  return (
    <>
      <PageHeader title="New campaign" />
      <CampaignBuilder id={null} {...data} live={whatsappMode() === "live"} />
    </>
  );
}
