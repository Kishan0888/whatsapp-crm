import Link from "next/link";
import { Plus } from "lucide-react";
import { requireUser, CAN_MANAGE_CAMPAIGNS } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { CampaignStatusBadge } from "@/components/campaign-status-badge";
import { campaignCostLabel, emptyStats, normalizeStats, rates } from "@/lib/campaign-metrics";
import { fmtDate, fmtInt } from "@/lib/utils";
import type { Campaign } from "@/lib/types";

export const metadata = { title: "Campaigns" };

export default async function CampaignsPage() {
  const { profile } = await requireUser();
  const supabase = await createClient();
  const [{ data, error }, { data: stats }] = await Promise.all([
    supabase.from("campaigns").select("*, whatsapp_templates(name)").order("created_at", { ascending: false }).limit(200),
    supabase.rpc("campaign_stats"),
  ]);
  const byId = new Map(((stats ?? []) as Record<string, unknown>[]).map((s) => [String(s.campaign_id), normalizeStats(s)]));
  const rows = (data ?? []) as (Campaign & { whatsapp_templates: { name: string } | null })[];

  return (
    <>
      <PageHeader
        title="Campaigns"
        description="Delivered and read figures come only from Meta webhooks."
        actions={CAN_MANAGE_CAMPAIGNS.includes(profile.role) && <Button asChild><Link href="/campaigns/new"><Plus /> New campaign</Link></Button>}
      />
      {error && <p className="mb-3 text-sm text-destructive">{error.message}</p>}
      <Card className="py-0">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Campaign</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="text-right">Recipients</TableHead>
              <TableHead className="text-right">Submitted</TableHead>
              <TableHead className="text-right">Delivered</TableHead>
              <TableHead className="text-right">Read</TableHead>
              <TableHead className="text-right">Failed</TableHead>
              <TableHead className="text-right">Est. cost</TableHead>
              <TableHead>Created</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.length === 0 && <TableRow><TableCell colSpan={9} className="py-10 text-center text-muted-foreground">No campaigns yet.</TableCell></TableRow>}
            {rows.map((c) => {
              const s = byId.get(c.id) ?? emptyStats(c.id);
              const r = rates(s);
              return (
                <TableRow key={c.id}>
                  <TableCell>
                    <Link href={`/campaigns/${c.id}`} className="font-medium hover:underline">{c.name}</Link>
                    <div className="text-xs text-muted-foreground">{c.whatsapp_templates?.name ?? "—"}</div>
                  </TableCell>
                  <TableCell><CampaignStatusBadge status={c.status} dryRun={c.is_dry_run} /></TableCell>
                  <TableCell className="text-right tabular-nums">{fmtInt(c.total_recipients)}</TableCell>
                  <TableCell className="text-right tabular-nums">{c.is_dry_run ? "—" : fmtInt(s.submitted)}</TableCell>
                  <TableCell className="text-right tabular-nums">{c.is_dry_run ? "—" : <>{fmtInt(s.delivered)} <span className="text-xs text-muted-foreground">{r.delivery}</span></>}</TableCell>
                  <TableCell className="text-right tabular-nums">{c.is_dry_run ? "—" : <>{fmtInt(s.read)} <span className="text-xs text-muted-foreground">{r.read}</span></>}</TableCell>
                  <TableCell className="text-right tabular-nums">{fmtInt(s.failed)}</TableCell>
                  <TableCell className="text-right tabular-nums">{campaignCostLabel(c)}</TableCell>
                  <TableCell className="text-xs text-muted-foreground">{fmtDate(c.created_at)}</TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </Card>
    </>
  );
}
