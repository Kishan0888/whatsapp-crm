import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { requireUser, CAN_MANAGE_CAMPAIGNS } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { whatsappMode } from "@/lib/env";
import { PageHeader } from "@/components/page-header";
import { StatCard } from "@/components/stat-card";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { NativeSelect } from "@/components/ui/native-select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { CampaignStatusBadge } from "@/components/campaign-status-badge";
import { TemplatePreview } from "@/components/template-preview";
import { StatusBarChart } from "@/components/status-bar-chart";
import { emptyStats, normalizeStats, rates, STATUS_COLORS } from "@/lib/campaign-metrics";
import { RETRYABLE_CODES } from "@/lib/whatsapp/errors";
import { fmtDate, fmtInt, fmtMoney } from "@/lib/utils";
import type { Campaign, Segment, Tag, WhatsAppTemplate } from "@/lib/types";
import { AutoRefresh, CampaignControls, LaunchDialog } from "../campaign-controls";

const PAGE = 50;
const STATUSES = ["queued", "sending", "sent", "delivered", "read", "failed", "skipped", "cancelled", "dry_run"];

export default async function CampaignPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ status?: string; page?: string }> }) {
  const { profile } = await requireUser();
  const { id } = await params;
  const sp = await searchParams;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const supabase = await createClient();
  const { data } = await supabase.from("campaigns").select("*, whatsapp_templates(*)").eq("id", id).maybeSingle();
  if (!data) notFound();
  const c = data as Campaign & { whatsapp_templates: WhatsAppTemplate | null };
  const canManage = CAN_MANAGE_CAMPAIGNS.includes(profile.role);
  const live = whatsappMode() === "live";

  const header = (
    <>
      <Link href="/campaigns" className="mb-3 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="size-4" /> Campaigns
      </Link>
      <PageHeader
        title={c.name}
        description={`Template: ${c.template_snapshot?.name ?? c.whatsapp_templates?.name ?? "—"} · created ${fmtDate(c.created_at)}${c.started_at ? ` · launched ${fmtDate(c.started_at)}` : ""}`}
        actions={<CampaignStatusBadge status={c.status} dryRun={c.is_dry_run} />}
      />
      {c.last_error && <p className="mb-4 rounded-md bg-destructive/10 p-3 text-sm text-destructive"><strong>Paused automatically:</strong> {c.last_error}</p>}
    </>
  );

  // ---------- Draft: review & launch ----------
  if (c.status === "draft") {
    const [{ data: counts }, { data: segs }, { data: tags }, { data: settings }] = await Promise.all([
      supabase.rpc("audience_counts", { p_filter: c.audience_filter }),
      supabase.from("segments").select("id, name"),
      supabase.from("tags").select("id, name"),
      supabase.from("app_settings").select("est_rate_marketing, est_rate_utility, currency").single(),
    ]);
    const k = counts as { eligible: number; matching: number; no_consent: number; opted_out: number; no_phone: number };
    const t = c.whatsapp_templates;
    const rate = t?.category === "UTILITY" ? Number(settings?.est_rate_utility ?? 0) : Number(settings?.est_rate_marketing ?? 0);
    const names = (ids: string[] | undefined, list: Pick<Segment | Tag, "id" | "name">[] | null) =>
      ids?.length ? ids.map((i) => list?.find((x) => x.id === i)?.name ?? "?").join(", ") : "Any";
    return (
      <>
        {header}
        <div className="grid gap-4 lg:grid-cols-5">
          <Card className="lg:col-span-3">
            <CardHeader><CardTitle>Review</CardTitle><CardDescription>Nothing has been sent. Launching requires typing the exact recipient count.</CardDescription></CardHeader>
            <CardContent className="grid gap-4">
              <dl className="grid gap-2 text-sm sm:grid-cols-2">
                <div><dt className="text-muted-foreground">Segments</dt><dd>{names(c.audience_filter.segment_ids, segs as Segment[])}</dd></div>
                <div><dt className="text-muted-foreground">Tags ({c.audience_filter.tag_match ?? "any"})</dt><dd>{names(c.audience_filter.tag_ids, tags as Tag[])}</dd></div>
                <div><dt className="text-muted-foreground">Eligible now</dt><dd className="text-lg font-semibold">{fmtInt(k?.eligible)}</dd></div>
                <div><dt className="text-muted-foreground">Excluded</dt><dd>{fmtInt(k?.no_consent)} no opt-in · {fmtInt(k?.opted_out)} opted out · {fmtInt(k?.no_phone)} no phone</dd></div>
                <div><dt className="text-muted-foreground">Template status</dt><dd>{t?.status ?? "—"}{live ? " (re-checked with Meta at launch)" : ""}</dd></div>
                <div><dt className="text-muted-foreground">Estimated cost</dt><dd>{fmtMoney((k?.eligible ?? 0) * rate, settings?.currency ?? "INR")}</dd></div>
              </dl>
              {canManage && (
                <div className="flex flex-wrap gap-2">
                  <LaunchDialog id={c.id} eligible={k?.eligible ?? 0} rate={rate} currency={settings?.currency ?? "INR"} live={live} templateName={t?.name ?? ""} />
                  <CampaignControls id={c.id} status={c.status} hasRetryable={false} />
                </div>
              )}
              {!live && <p className="text-xs text-muted-foreground">Mock mode is on, so launching runs a dry run: recipients are personalised and recorded, but nothing is sent to Meta.</p>}
            </CardContent>
          </Card>
          <Card className="lg:col-span-2">
            <CardHeader><CardTitle>Message</CardTitle></CardHeader>
            <CardContent>{t && <TemplatePreview components={t.components} mediaUrl={c.header_media?.type === "image" ? c.header_media.link : undefined} />}</CardContent>
          </Card>
        </div>
      </>
    );
  }

  // ---------- Launched: analytics ----------
  const status = sp.status && STATUSES.includes(sp.status) ? sp.status : undefined;
  const page = Math.max(1, Number(sp.page) || 1);
  let rq = supabase
    .from("campaign_recipients")
    .select("id, phone_e164, status, wa_message_id, accepted_at, delivered_at, read_at, failed_at, last_error_code, last_error, lead_id, leads(full_name, organization)", { count: "exact" })
    .eq("campaign_id", c.id)
    .order("id")
    .range((page - 1) * PAGE, page * PAGE - 1);
  if (status) rq = rq.eq("status", status);
  const [{ data: statRows }, { data: reasons }, recipients] = await Promise.all([
    supabase.rpc("campaign_stats", { p_campaign_ids: [c.id] }),
    supabase.rpc("campaign_failure_reasons", { p_campaign_id: c.id }),
    rq,
  ]);
  const s = (statRows as Record<string, unknown>[] | null)?.[0] ? normalizeStats((statRows as Record<string, unknown>[])[0]) : emptyStats(c.id);
  const r = rates(s);
  const pending = s.queued + s.sending;
  const reasonRows = (reasons ?? []) as { code: string; reason: string; n: number }[];
  const hasRetryable = reasonRows.some((x) => RETRYABLE_CODES.includes(x.code));
  type RRow = { id: number; phone_e164: string; status: string; wa_message_id: string | null; accepted_at: string | null; delivered_at: string | null; read_at: string | null; last_error_code: string | null; last_error: string | null; lead_id: string | null; leads: { full_name: string | null; organization: string | null } | null };
  const rrows = (recipients.data ?? []) as unknown as RRow[];
  const pages = Math.max(1, Math.ceil((recipients.count ?? 0) / PAGE));
  const href = (p: number, st?: string) => `/campaigns/${c.id}?${new URLSearchParams({ ...(st ? { status: st } : {}), page: String(p) })}`;

  return (
    <>
      {header}
      <AutoRefresh active={c.status === "running"} />
      {canManage && <div className="mb-4"><CampaignControls id={c.id} status={c.status} hasRetryable={hasRetryable} /></div>}
      {c.is_dry_run && (
        <p className="mb-4 rounded-md bg-amber-500/10 p-3 text-sm text-amber-800 dark:text-amber-300">
          Dry run: {fmtInt(s.dry_run)} of {fmtInt(s.total)} recipients processed. No messages were sent to Meta, so there are no delivery or read figures.
        </p>
      )}
      <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <StatCard label="Recipients" value={fmtInt(s.total)} hint={`${fmtInt(s.skipped)} skipped · ${fmtInt(s.cancelled)} cancelled`} />
        <StatCard label="Pending" value={fmtInt(pending)} />
        <StatCard label="Submitted" value={fmtInt(s.submitted)} hint="Accepted by Cloud API" />
        <StatCard label="Delivered" value={fmtInt(s.delivered)} hint={`${r.delivery} of submitted`} />
        <StatCard label="Read" value={fmtInt(s.read)} hint={`${r.read} of delivered`} />
        <StatCard label="Failed" value={fmtInt(s.failed)} hint={`${r.failure} failure rate`} />
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-5">
        <Card className="lg:col-span-3">
          <CardHeader><CardTitle>Message status</CardTitle><CardDescription>From Cloud API responses and Meta webhooks only.</CardDescription></CardHeader>
          <CardContent>
            <StatusBarChart data={[
              { name: "Pending", value: pending, color: STATUS_COLORS.pending },
              { name: "Submitted", value: s.submitted, color: STATUS_COLORS.submitted },
              { name: "Delivered", value: s.delivered, color: STATUS_COLORS.delivered },
              { name: "Read", value: s.read, color: STATUS_COLORS.read },
              { name: "Failed", value: s.failed, color: STATUS_COLORS.failed },
            ]} />
          </CardContent>
        </Card>
        <Card className="lg:col-span-2">
          <CardHeader><CardTitle>Cost</CardTitle></CardHeader>
          <CardContent className="grid gap-2 text-sm">
            <div className="flex justify-between"><span className="text-muted-foreground">Estimated (at launch)</span><span className="tabular-nums">{c.is_dry_run ? "—" : fmtMoney(c.est_cost, c.currency)}</span></div>
            <div className="flex justify-between"><span className="text-muted-foreground">Billable per webhooks</span><span className="tabular-nums">{fmtInt(s.paid)} msgs</span></div>
            <div className="flex justify-between"><span className="text-muted-foreground">Free per webhooks</span><span className="tabular-nums">{fmtInt(s.free)} msgs</span></div>
            <p className="text-xs text-muted-foreground">Meta reports pricing type per message in webhooks; amounts aren&apos;t included. See Analytics for Meta-reported charges.</p>
          </CardContent>
        </Card>
      </div>

      {reasonRows.length > 0 && (
        <Card className="mt-4 gap-2">
          <CardHeader><CardTitle>Failures &amp; skips</CardTitle></CardHeader>
          <CardContent className="px-0">
            <Table>
              <TableHeader><TableRow><TableHead className="w-28">Code</TableHead><TableHead>Reason</TableHead><TableHead className="text-right">Count</TableHead></TableRow></TableHeader>
              <TableBody>
                {reasonRows.map((x) => (
                  <TableRow key={x.code}><TableCell className="font-mono text-xs">{x.code}</TableCell><TableCell className="text-sm">{x.reason}</TableCell><TableCell className="text-right tabular-nums">{fmtInt(Number(x.n))}</TableCell></TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}

      <Card className="mt-4 gap-2">
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle>Recipients ({fmtInt(recipients.count)})</CardTitle>
          <form method="get" className="flex gap-2">
            <NativeSelect name="status" defaultValue={status ?? ""} className="h-8 w-40">
              <option value="">All statuses</option>
              {STATUSES.map((x) => <option key={x} value={x}>{x.replace("_", " ")}</option>)}
            </NativeSelect>
            <Button size="sm" variant="outline">Filter</Button>
          </form>
        </CardHeader>
        <CardContent className="px-0">
          <Table>
            <TableHeader>
              <TableRow><TableHead>Lead</TableHead><TableHead>Phone</TableHead><TableHead>Status</TableHead><TableHead>Delivered</TableHead><TableHead>Read</TableHead><TableHead>Error</TableHead></TableRow>
            </TableHeader>
            <TableBody>
              {rrows.length === 0 && <TableRow><TableCell colSpan={6} className="py-8 text-center text-muted-foreground">No recipients.</TableCell></TableRow>}
              {rrows.map((x) => (
                <TableRow key={x.id}>
                  <TableCell className="max-w-56 truncate">{x.lead_id ? <Link className="hover:underline" href={`/leads/${x.lead_id}`}>{x.leads?.full_name || x.leads?.organization || "Lead"}</Link> : "—"}</TableCell>
                  <TableCell className="font-mono text-xs">{x.phone_e164}</TableCell>
                  <TableCell className="text-xs">{x.status.replace("_", " ")}</TableCell>
                  <TableCell className="text-xs text-muted-foreground">{fmtDate(x.delivered_at)}</TableCell>
                  <TableCell className="text-xs text-muted-foreground">{fmtDate(x.read_at)}</TableCell>
                  <TableCell className="max-w-72 truncate text-xs text-destructive" title={x.last_error ?? ""}>{x.last_error_code ? `${x.last_error_code}: ${x.last_error ?? ""}` : ""}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          {pages > 1 && (
            <div className="flex items-center justify-between px-5 pt-3 text-sm">
              <span className="text-muted-foreground">Page {page} of {pages}</span>
              <div className="flex gap-2">
                {page > 1 && <Button size="sm" variant="outline" asChild><Link href={href(page - 1, status)}>Previous</Link></Button>}
                {page < pages && <Button size="sm" variant="outline" asChild><Link href={href(page + 1, status)}>Next</Link></Button>}
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </>
  );
}
