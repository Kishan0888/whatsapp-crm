import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { requireUser, CAN_MANAGE_CAMPAIGNS } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { whatsappMode } from "@/lib/env";
import { PageHeader } from "@/components/page-header";
import { Card, CardContent } from "@/components/ui/card";
import { TemplatePreview } from "@/components/template-preview";
import { TemplateStatusBadge } from "@/components/template-status-badge";
import { draftFromTemplate } from "@/lib/whatsapp/templates";
import { fmtDate } from "@/lib/utils";
import type { WhatsAppTemplate } from "@/lib/types";
import { TemplateEditor } from "../template-editor";
import { DeleteTemplateButton } from "../template-buttons";

const EDITABLE = ["DRAFT", "REJECTED", "PAUSED", "APPROVED"];

export default async function TemplatePage({ params }: { params: Promise<{ id: string }> }) {
  const { profile } = await requireUser();
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const supabase = await createClient();
  const { data } = await supabase.from("whatsapp_templates").select("*").eq("id", id).maybeSingle();
  if (!data) notFound();
  const t = data as WhatsAppTemplate;
  const canManage = CAN_MANAGE_CAMPAIGNS.includes(profile.role);
  const live = whatsappMode() === "live";
  const draft = t.example_data?.draft ?? draftFromTemplate(t);
  const editable = canManage && !!draft && EDITABLE.includes(t.status);

  return (
    <>
      <Link href="/templates" className="mb-3 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="size-4" /> Templates
      </Link>
      <PageHeader
        title={t.name}
        description={`${t.language} · ${t.category}${t.meta_template_id ? ` · Meta ID ${t.meta_template_id}` : " · not submitted"} · last synced ${fmtDate(t.last_synced_at)}`}
        actions={
          <>
            <TemplateStatusBadge status={t.status} />
            {canManage && t.status !== "DELETED" && <DeleteTemplateButton id={t.id} submitted={!!t.meta_template_id} live={live} />}
          </>
        }
      />
      {t.rejected_reason && (
        <p className="mb-4 rounded-md bg-destructive/10 p-3 text-sm text-destructive"><strong>Rejected by Meta:</strong> {t.rejected_reason}</p>
      )}
      {t.status === "APPROVED" && t.meta_template_id && (
        <p className="mb-4 rounded-md bg-primary/10 p-3 text-sm">
          Approved by Meta. Editing an approved template sends it for review again (Meta allows limited edits: 1 per 24 hours, 10 per 30 days).
        </p>
      )}
      {editable && draft ? (
        <TemplateEditor id={t.id} initial={draft} locked={!!t.meta_template_id} status={t.status} live={live} canEdit={canManage} />
      ) : (
        <Card className="max-w-md">
          <CardContent className="grid gap-3">
            <TemplatePreview components={t.components} />
            <p className="text-xs text-muted-foreground">
              {t.status === "PENDING" ? "Waiting for Meta's review. Status updates arrive via webhook or Sync." : "This template is read-only in the CRM."}
            </p>
          </CardContent>
        </Card>
      )}
    </>
  );
}
