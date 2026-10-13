import Link from "next/link";
import { Plus } from "lucide-react";
import { requireUser, CAN_MANAGE_CAMPAIGNS } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { whatsappMode } from "@/lib/env";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { NativeSelect } from "@/components/ui/native-select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { TemplateStatusBadge } from "@/components/template-status-badge";
import { fmtDate } from "@/lib/utils";
import type { WhatsAppTemplate } from "@/lib/types";
import { SyncButton } from "./template-buttons";

export const metadata = { title: "WhatsApp templates" };

export default async function TemplatesPage({ searchParams }: { searchParams: Promise<{ status?: string }> }) {
  const { profile } = await requireUser();
  const sp = await searchParams;
  const supabase = await createClient();
  let q = supabase.from("whatsapp_templates").select("*").order("updated_at", { ascending: false });
  if (sp.status && /^[A-Z_]+$/.test(sp.status)) q = q.eq("status", sp.status);
  const { data, error } = await q;
  const rows = (data ?? []) as WhatsAppTemplate[];
  const canManage = CAN_MANAGE_CAMPAIGNS.includes(profile.role);
  const hasCreds = !!process.env.WHATSAPP_ACCESS_TOKEN;

  return (
    <>
      <PageHeader
        title="WhatsApp templates"
        description="Statuses shown here come from Meta (via sync or webhooks). Only APPROVED templates can be used in campaigns."
        actions={canManage && (
          <>
            <SyncButton disabled={!hasCreds} />
            <Button asChild><Link href="/templates/new"><Plus /> New template</Link></Button>
          </>
        )}
      />
      {!hasCreds && (
        <p className="mb-4 rounded-md bg-amber-500/10 p-3 text-sm text-amber-800 dark:text-amber-300">
          Add WHATSAPP_ACCESS_TOKEN and your WABA ID (Settings) to sync templates from Meta. {whatsappMode() === "mock" && "Submitting also requires WHATSAPP_MODE=live."}
        </p>
      )}
      <form className="mb-3 flex gap-2" method="get">
        <NativeSelect name="status" defaultValue={sp.status ?? ""} className="w-48">
          <option value="">All statuses</option>
          {["APPROVED", "PENDING", "REJECTED", "PAUSED", "DRAFT", "DISABLED", "DELETED"].map((s) => <option key={s} value={s}>{s.toLowerCase()}</option>)}
        </NativeSelect>
        <Button variant="outline" type="submit">Filter</Button>
      </form>
      {error && <p className="mb-3 text-sm text-destructive">{error.message}</p>}
      <Card className="py-0">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Language</TableHead>
              <TableHead>Category</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Quality</TableHead>
              <TableHead>Rejection reason</TableHead>
              <TableHead>Last synced</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.length === 0 && (
              <TableRow><TableCell colSpan={7} className="py-10 text-center text-muted-foreground">No templates yet. Create one or sync from Meta.</TableCell></TableRow>
            )}
            {rows.map((t) => (
              <TableRow key={t.id}>
                <TableCell>
                  <Link className="font-medium hover:underline" href={`/templates/${t.id}`}>{t.name}</Link>
                  {t.example_data?.dirty && <span className="ml-2 text-xs text-amber-700">unsent edits</span>}
                </TableCell>
                <TableCell className="text-sm">{t.language}</TableCell>
                <TableCell className="text-xs">{t.category}</TableCell>
                <TableCell><TemplateStatusBadge status={t.status} /></TableCell>
                <TableCell className="text-xs">{t.quality_score ?? "—"}</TableCell>
                <TableCell className="max-w-64 truncate text-xs text-destructive" title={t.rejected_reason ?? ""}>{t.rejected_reason ?? ""}</TableCell>
                <TableCell className="text-xs text-muted-foreground">{fmtDate(t.last_synced_at)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Card>
    </>
  );
}
