import Link from "next/link";
import { requireUser, CAN_MANAGE_CAMPAIGNS } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { PageHeader } from "@/components/page-header";
import { StatCard } from "@/components/stat-card";
import { StatusBarChart } from "@/components/status-bar-chart";
import { CampaignStatusBadge } from "@/components/campaign-status-badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { emptyStats, normalizeStats, rates, STATUS_COLORS } from "@/lib/campaign-metrics";
import { fmtInt, fmtMoney } from "@/lib/utils";
import type { Campaign, CampaignStats } from "@/lib/types";
import { MetaCostForm } from "./meta-cost-form";

export const metadata = { title: "Analytics" };

const isoDay = (d: Date) => d.toISOString().slice(0, 10);

export default async function AnalyticsPage({ searchParams }: { searchParams: Promise<{ from?: string; to?: string }> }) {
  const { profile } = await requireUser();
  const sp = await searchParams;
  const today = new Date();
  const to = /^\d{4}-\d{2}-\d{2}$/.test(sp.to ?? "") ? sp.to! : isoDay(today);
  const from = /^\d{4}-\d{2}-\d{2}$/.test(sp.from ?? "") ? sp.from! : isoDay(new Date(today.getTime() - 29 * 86400_000));
  const supabase = await createClient();

  const [{ data: campaigns }, { data: statRows }, { data: costs }, { data: settings }] = await Promise.all([
    supabase.from("campaigns").select("*").neq("status", "draft").order("started_at", { ascending: false }).limit(200),
    supabase.rpc("campaign_stats"),
    supabase.from("meta_cost_reports").select("*").gte("period_start", `${from}T00:00:00Z`).lte("period_end", `${to}T23:59:59Z`),
    supabase.from("app_settings").select("currency, waba_id").single(),
  ]);
  const list = (campaigns ?? []) as Campaign[];
  const stats = new Map(((statRows ?? []) as Record<string, unknown>[]).map((s) => [String(s.campaign_id), normalizeStats(s)]));
  const liveCampaigns = list.filter((c) => !c.is_dry_run);
  const total = liveCampaigns.reduce<CampaignStats>((acc, c) => {
    const s = stats.get(c.id) ?? emptyStats(c.id);
    for (const k of Object.keys(acc) as (keyof CampaignStats)[]) if (k !== "campaign_id") (acc[k] as number) += s[k] as number;
    return acc;
  }, emptyStats("all"));
  const r = rates(total);
  const currency = settings?.currency ?? "INR";
  const estInRange = liveCampaigns
    .filter((c) => c.started_at && c.started_at.slice(0, 10) >= from && c.started_at.slice(0, 10) <= to)
    .reduce((a, c) => a + Number(c.est_cost), 0);

  type CostRow = { pricing_category: string | null; pricing_type: string | null; volume: number; cost: number | null };
  const costRows = (costs ?? []) as CostRow[];
  const byCat = new Map<string, { volume: number; cost: number; hasCost: boolean }>();
  for (const c of costRows) {
    const key = `${c.pricing_category ?? "unknown"} · ${c.pricing_type ?? "unknown"}`;
    const cur = byCat.get(key) ?? { volume: 0, cost: 0, hasCost: false };
    cur.volume += Number(c.volume);
    if (c.cost !== null) { cur.cost += Number(c.cost); cur.hasCost = true; }
    byCat.set(key, cur);
  }
  const metaTotal = [...byCat.values()].reduce((a, v) => a + v.cost, 0);
  const metaHasCost = [...byCat.values()].some((v) => v.hasCost);
  const canFetch = CAN_MANAGE_CAMPAIGNS.includes(profile.role) && !!process.env.WHATSAPP_ACCESS_TOKEN && !!settings?.waba_id;

  return (
    <>
      <PageHeader title="Analytics" description="All live (non-dry-run) campaigns. Delivered and read come only from Meta webhooks." />
      <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <StatCard label="Submitted" value={fmtInt(total.submitted)} hint="Accepted by Cloud API" />
        <StatCard label="Delivered" value={fmtInt(total.delivered)} hint={`${r.delivery} delivery rate`} />
        <StatCard label="Read" value={fmtInt(total.read)} hint={`${r.read} read rate`} />
        <StatCard label="Failed" value={fmtInt(total.failed)} hint={`${r.failure} failure rate`} />
        <StatCard label="Pending" value={fmtInt(total.queued + total.sending)} />
        <StatCard label="Status unknown" value={fmtInt(Math.max(0, total.submitted - total.delivered - total.failed))} hint="Submitted, no delivery webhook yet" />
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-5">
        <Card className="lg:col-span-3">
          <CardHeader><CardTitle>Funnel</CardTitle></CardHeader>
          <CardContent>
            <StatusBarChart data={[
              { name: "Submitted", value: total.submitted, color: STATUS_COLORS.submitted },
              { name: "Delivered", value: total.delivered, color: STATUS_COLORS.delivered },
              { name: "Read", value: total.read, color: STATUS_COLORS.read },
              { name: "Failed", value: total.failed, color: STATUS_COLORS.failed },
            ]} />
          </CardContent>
        </Card>
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>Costs {from} → {to}</CardTitle>
            <CardDescription>Estimates and Meta-reported charges are kept separate.</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-3 text-sm">
            <div className="flex justify-between"><span className="text-muted-foreground">CRM estimate (campaigns launched in range)</span><span className="tabular-nums">{fmtMoney(estInRange, currency)}</span></div>
            <div className="flex justify-between font-medium">
              <span>Meta-reported charges</span>
              <span className="tabular-nums">{costRows.length === 0 ? "Not fetched" : metaHasCost ? `${metaTotal.toFixed(2)} (WABA currency)` : "Not provided by Meta"}</span>
            </div>
            <p className="text-xs text-muted-foreground">
              From Meta&apos;s pricing analytics for the whole WhatsApp Business Account. Meta describes these figures as approximate; your invoice is authoritative. Cost isn&apos;t returned when billing goes through a Solution Partner&apos;s credit line.
            </p>
            <MetaCostForm from={from} to={to} disabled={!canFetch} />
            {byCat.size > 0 && (
              <Table>
                <TableHeader><TableRow><TableHead>Category · type</TableHead><TableHead className="text-right">Messages</TableHead><TableHead className="text-right">Cost</TableHead></TableRow></TableHeader>
                <TableBody>
                  {[...byCat.entries()].map(([k, v]) => (
                    <TableRow key={k}><TableCell className="text-xs">{k.toLowerCase()}</TableCell><TableCell className="text-right tabular-nums">{fmtInt(v.volume)}</TableCell><TableCell className="text-right tabular-nums">{v.hasCost ? v.cost.toFixed(2) : "—"}</TableCell></TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      </div>

      <Card className="mt-4 gap-2">
        <CardHeader><CardTitle>Campaign history</CardTitle></CardHeader>
        <CardContent className="px-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Campaign</TableHead><TableHead>Status</TableHead><TableHead className="text-right">Recipients</TableHead>
                <TableHead className="text-right">Delivery</TableHead><TableHead className="text-right">Read</TableHead><TableHead className="text-right">Failure</TableHead>
                <TableHead className="text-right">Billable</TableHead><TableHead className="text-right">Est. cost</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {list.length === 0 && <TableRow><TableCell colSpan={8} className="py-8 text-center text-muted-foreground">No launched campaigns yet.</TableCell></TableRow>}
              {list.map((c) => {
                const s = stats.get(c.id) ?? emptyStats(c.id);
                const cr = rates(s);
                return (
                  <TableRow key={c.id}>
                    <TableCell><Link href={`/campaigns/${c.id}`} className="font-medium hover:underline">{c.name}</Link></TableCell>
                    <TableCell><CampaignStatusBadge status={c.status} dryRun={c.is_dry_run} /></TableCell>
                    <TableCell className="text-right tabular-nums">{fmtInt(s.total)}</TableCell>
                    <TableCell className="text-right tabular-nums">{c.is_dry_run ? "—" : cr.delivery}</TableCell>
                    <TableCell className="text-right tabular-nums">{c.is_dry_run ? "—" : cr.read}</TableCell>
                    <TableCell className="text-right tabular-nums">{c.is_dry_run ? "—" : cr.failure}</TableCell>
                    <TableCell className="text-right tabular-nums">{c.is_dry_run ? "—" : fmtInt(s.paid)}</TableCell>
                    <TableCell className="text-right tabular-nums">{c.is_dry_run ? "—" : fmtMoney(c.est_cost, c.currency)}</TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </>
  );
}
