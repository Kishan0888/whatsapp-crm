import Link from "next/link";
import { CheckCheck, Eye, Send, Users, XCircle, Upload, Megaphone, IndianRupee, ShieldCheck } from "lucide-react";
import { requireUser } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { PageHeader } from "@/components/page-header";
import { StatCard } from "@/components/stat-card";
import { SegmentChart } from "@/components/segment-chart";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { fmtDate, fmtInt, fmtMoney } from "@/lib/utils";
import type { DashboardMetrics, ImportRecord } from "@/lib/types";

export const metadata = { title: "Dashboard" };

const pct = (a: number, b: number) => (b > 0 ? `${((a / b) * 100).toFixed(1)}%` : "—");

export default async function DashboardPage({ searchParams }: { searchParams: Promise<{ forbidden?: string }> }) {
  await requireUser();
  const sp = await searchParams;
  const supabase = await createClient();
  const [{ data: metrics, error }, { data: imports }, { data: settings }] = await Promise.all([
    supabase.rpc("dashboard_metrics"),
    supabase.from("imports").select("*").order("created_at", { ascending: false }).limit(5),
    supabase.from("app_settings").select("currency").single(),
  ]);

  if (error || !metrics) {
    return (
      <>
        <PageHeader title="Dashboard" />
        <p className="text-sm text-destructive">Could not load metrics: {error?.message ?? "no data"}. Have the migrations been applied?</p>
      </>
    );
  }
  const m = metrics as DashboardMetrics;
  const msg = m.messages;
  const currency = settings?.currency ?? "INR";

  return (
    <>
      {sp.forbidden && (
        <p className="mb-4 rounded-md bg-destructive/10 p-3 text-sm text-destructive">You don&apos;t have permission to open that page.</p>
      )}
      <PageHeader title="Dashboard" description="Live figures from your database. Message statuses come only from Meta webhooks." />

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Active leads" value={fmtInt(m.total_leads)} hint={`${fmtInt(m.archived_leads)} archived`} icon={Users} />
        <StatCard label="Marketing opt-in" value={fmtInt(m.opted_in)} hint={`${fmtInt(m.opted_out)} permanently opted out`} icon={ShieldCheck} />
        <StatCard label="Imports" value={fmtInt(m.imports)} icon={Upload} />
        <StatCard label="Campaigns" value={fmtInt(m.campaigns)} icon={Megaphone} />
      </div>

      <h2 className="mt-8 mb-3 text-sm font-medium text-muted-foreground">WhatsApp messages (all campaigns)</h2>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <StatCard label="Submitted" value={fmtInt(msg.sent)} hint={`${fmtInt(msg.pending)} pending · accepted by Cloud API`} icon={Send} />
        <StatCard label="Delivered" value={fmtInt(msg.delivered)} hint={`${pct(msg.delivered, msg.sent)} of sent`} icon={CheckCheck} />
        <StatCard label="Read" value={fmtInt(msg.read)} hint={`${pct(msg.read, msg.delivered)} of delivered`} icon={Eye} />
        <StatCard label="Failed" value={fmtInt(msg.failed)} hint={`${pct(msg.failed, msg.sent + msg.failed)} failure rate`} icon={XCircle} />
        <StatCard label="Estimated cost" value={fmtMoney(m.est_cost, currency)} hint="Estimate only — not billed amount" icon={IndianRupee} />
      </div>

      <div className="mt-8 grid gap-4 lg:grid-cols-5">
        <Card className="lg:col-span-3">
          <CardHeader>
            <CardTitle>Leads by segment</CardTitle>
            <CardDescription>Active (non-archived) leads</CardDescription>
          </CardHeader>
          <CardContent>
            <SegmentChart data={m.segments} />
          </CardContent>
        </Card>
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>Recent imports</CardTitle>
            <CardDescription>
              <Link href="/imports" className="text-primary hover:underline">View all</Link>
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-3">
            {(imports as ImportRecord[] | null)?.length ? (
              (imports as ImportRecord[]).map((i) => (
                <Link key={i.id} href={`/imports/${i.id}`} className="flex items-center justify-between gap-2 rounded-md border p-3 text-sm hover:bg-muted/50">
                  <div className="min-w-0">
                    <div className="truncate font-medium">{i.file_name}</div>
                    <div className="text-xs text-muted-foreground">{fmtDate(i.created_at)}</div>
                  </div>
                  <div className="text-right text-xs">
                    <div>{fmtInt(i.inserted_count)} new</div>
                    {i.error_count > 0 && <div className="text-destructive">{fmtInt(i.error_count)} errors</div>}
                  </div>
                </Link>
              ))
            ) : (
              <p className="text-sm text-muted-foreground">
                No imports yet. <Link className="text-primary hover:underline" href="/leads/import">Import your first file</Link>.
              </p>
            )}
            {(imports as ImportRecord[] | null)?.some((i) => i.status === "processing") && (
              <Badge variant="warning">An import is still processing</Badge>
            )}
          </CardContent>
        </Card>
      </div>
    </>
  );
}
