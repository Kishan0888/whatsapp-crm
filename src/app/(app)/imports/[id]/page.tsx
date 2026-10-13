import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, Download } from "lucide-react";
import { requireUser } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { PageHeader } from "@/components/page-header";
import { StatCard } from "@/components/stat-card";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ImportStatusBadge } from "@/components/import-status-badge";
import { fmtDate, fmtInt } from "@/lib/utils";
import type { ImportRecord } from "@/lib/types";

export default async function ImportDetailPage({ params }: { params: Promise<{ id: string }> }) {
  await requireUser();
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const supabase = await createClient();
  const [{ data: imp }, { data: errors, count }] = await Promise.all([
    supabase.from("imports").select("*, segments(name)").eq("id", id).maybeSingle(),
    supabase.from("import_errors").select("row_number, error, raw", { count: "exact" }).eq("import_id", id).order("row_number").limit(200),
  ]);
  if (!imp) notFound();
  const i = imp as ImportRecord & { segments: { name: string } | null };
  const mapped = Object.entries(i.column_mapping).filter(([, t]) => t !== "ignore");

  return (
    <>
      <Link href="/imports" className="mb-3 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="size-4" /> Import history
      </Link>
      <PageHeader
        title={i.file_name}
        description={`Imported ${fmtDate(i.created_at)} · segment: ${i.segments?.name ?? "none"} · duplicates: ${i.duplicate_strategy}`}
        actions={
          <>
            <ImportStatusBadge status={i.status} />
            <Button variant="outline" asChild><Link href={`/leads?import=${i.id}`}>View leads</Link></Button>
            {(count ?? 0) > 0 && (
              <Button asChild>
                <a href={`/imports/${i.id}/errors`}><Download /> Error report (CSV)</a>
              </Button>
            )}
          </>
        }
      />
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <StatCard label="Rows in file" value={fmtInt(i.total_rows)} />
        <StatCard label="New leads" value={fmtInt(i.inserted_count)} />
        <StatCard label="Updated" value={fmtInt(i.updated_count)} />
        <StatCard label="Duplicates" value={fmtInt(i.duplicate_count)} />
        <StatCard label="Invalid rows" value={fmtInt(i.error_count)} />
      </div>
      {i.consent_basis && (
        <p className="mt-4 rounded-md bg-primary/10 p-3 text-sm">
          <strong>Opt-in declared for this file:</strong> {i.consent_basis}
        </p>
      )}
      <div className="mt-6 grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2 gap-2">
          <CardHeader><CardTitle>Row issues {count ? `(${fmtInt(count)})` : ""}</CardTitle></CardHeader>
          <CardContent className="px-0">
            {!count ? (
              <p className="px-5 text-sm text-muted-foreground">No row errors or duplicates.</p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow><TableHead className="w-20">Row</TableHead><TableHead>Issue</TableHead><TableHead>Data</TableHead></TableRow>
                </TableHeader>
                <TableBody>
                  {(errors ?? []).map((e) => (
                    <TableRow key={`${e.row_number}-${e.error}`}>
                      <TableCell className="tabular-nums">{e.row_number}</TableCell>
                      <TableCell className="text-sm">{e.error}</TableCell>
                      <TableCell className="max-w-72 truncate text-xs text-muted-foreground">{Object.values(e.raw as Record<string, string>).join(" · ")}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
            {(count ?? 0) > 200 && <p className="px-5 pt-2 text-xs text-muted-foreground">Showing first 200 — download the CSV for all rows.</p>}
          </CardContent>
        </Card>
        <Card className="gap-2">
          <CardHeader><CardTitle>Column mapping</CardTitle></CardHeader>
          <CardContent>
            <dl className="grid gap-1.5 text-sm">
              {mapped.map(([col, t]) => (
                <div key={col} className="flex justify-between gap-2"><dt className="truncate">{col}</dt><dd className="text-muted-foreground">{t}</dd></div>
              ))}
            </dl>
          </CardContent>
        </Card>
      </div>
    </>
  );
}
