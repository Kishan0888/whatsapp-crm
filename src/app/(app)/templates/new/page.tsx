import { requireUser, CAN_MANAGE_CAMPAIGNS } from "@/lib/auth";
import { whatsappMode } from "@/lib/env";
import { PageHeader } from "@/components/page-header";
import { emptyDraft } from "@/lib/whatsapp/templates";
import { TemplateEditor } from "../template-editor";

export const metadata = { title: "New template" };

export default async function NewTemplatePage() {
  await requireUser(CAN_MANAGE_CAMPAIGNS);
  return (
    <>
      <PageHeader title="New WhatsApp template" description="Meta reviews every template. Approval usually takes minutes but can take up to 24 hours." />
      <TemplateEditor id={null} initial={emptyDraft()} locked={false} status="DRAFT" live={whatsappMode() === "live"} canEdit />
    </>
  );
}
