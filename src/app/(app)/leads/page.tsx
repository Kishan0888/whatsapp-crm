import Link from "next/link";
import { Download, Plus, Upload } from "lucide-react";
import { requireUser, CAN_EDIT_LEADS } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { leadsQuery, parseLeadFilters, filtersToSearch } from "@/lib/leads/filters";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { Card } from "@/components/ui/card";
import { fmtInt } from "@/lib/utils";
import type { Segment, Tag } from "@/lib/types";
import { LeadsTable, type LeadRow } from "./leads-table";

export const metadata = { title: "Leads" };
const PAGE_SIZE = 50;

export default async function LeadsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { profile } = await requireUser();
  const sp = await searchParams;
  const f = parseLeadFilters(sp);
  const page = Math.max(1, Number(sp.page) || 1);
  const supabase = await createClient();

  const [{ data: segments }, { data: tags }, result] = await Promise.all([
    supabase.from("segments").select("*").order("sort_order"),
    supabase.from("tags").select("*").order("name"),
    leadsQuery(
      supabase,
      "id, full_name, organization, phone_e164, email, city, status, marketing_consent, created_at, segment_id, lead_tags(tag_id)",
      f,
      true,
    )
      .order("created_at", { ascending: false })
      .order("id")
      .range((page - 1) * PAGE_SIZE, page * PAGE_SIZE - 1),
  ]);

  const total = result.count ?? 0;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const qs = filtersToSearch(f);
  const pageHref = (p: number) => {
    const s = new URLSearchParams(qs);
    s.set("page", String(p));
    return `/leads?${s}`;
  };
  const canEdit = CAN_EDIT_LEADS.includes(profile.role);

  return (
    <>
      <PageHeader
        title="Leads"
        description={`${fmtInt(total)} ${f.archived ? "archived" : "active"} lead(s) match your filters`}
        actions={
          <>
            <Button variant="outline" asChild>
              <a href={`/leads/export?${qs}`}>
                <Download /> Export CSV
              </a>
            </Button>
            {canEdit && (
              <>
                <Button variant="outline" asChild>
                  <Link href="/leads/import">
                    <Upload /> Import
                  </Link>
                </Button>
                <Button asChild>
                  <Link href="/leads/new">
                    <Plus /> Add lead
                  </Link>
                </Button>
              </>
            )}
          </>
        }
      />

      <Card className="mb-4 py-3">
        <form className="grid gap-2 px-3 sm:grid-cols-2 lg:grid-cols-7" method="get">
          <Input name="q" defaultValue={f.q} placeholder="Search name, org, email, city, phone" className="lg:col-span-2" />
          <NativeSelect name="segment" defaultValue={f.segment ?? ""} aria-label="Segment">
            <option value="">All segments</option>
            {(segments as Segment[] | null)?.map((s) => (
              <option key={s.id} value={s.id}>{s.name}</option>
            ))}
            <option value="none">No segment</option>
          </NativeSelect>
          <NativeSelect name="tag" defaultValue={f.tag ?? ""} aria-label="Tag">
            <option value="">All tags</option>
            {(tags as Tag[] | null)?.map((t) => (
              <option key={t.id} value={t.id}>{t.name}</option>
            ))}
          </NativeSelect>
          <NativeSelect name="consent" defaultValue={f.consent ?? ""} aria-label="Consent">
            <option value="">Any consent</option>
            <option value="opted_in">Opted in</option>
            <option value="unknown">Unknown</option>
            <option value="opted_out">Opted out</option>
          </NativeSelect>
          <NativeSelect name="archived" defaultValue={f.archived ?? ""} aria-label="Archived">
            <option value="">Active</option>
            <option value="1">Archived</option>
          </NativeSelect>
          <div className="flex gap-2">
            <Button type="submit" className="flex-1">Filter</Button>
            <Button variant="ghost" asChild>
              <Link href="/leads">Reset</Link>
            </Button>
          </div>
          {f.importId && <input type="hidden" name="import" value={f.importId} />}
        </form>
      </Card>

      {result.error ? (
        <p className="text-sm text-destructive">Could not load leads: {result.error.message}</p>
      ) : (
        <LeadsTable
          rows={(result.data ?? []) as unknown as LeadRow[]}
          segments={(segments ?? []) as Segment[]}
          tags={(tags ?? []) as Tag[]}
          canEdit={canEdit}
          archivedView={!!f.archived}
        />
      )}

      {pages > 1 && (
        <div className="mt-4 flex items-center justify-between text-sm">
          <span className="text-muted-foreground">Page {page} of {pages}</span>
          <div className="flex gap-2">
            {page > 1 && <Button variant="outline" size="sm" asChild><Link href={pageHref(page - 1)}>Previous</Link></Button>}
            {page < pages && <Button variant="outline" size="sm" asChild><Link href={pageHref(page + 1)}>Next</Link></Button>}
          </div>
        </div>
      )}
    </>
  );
}
