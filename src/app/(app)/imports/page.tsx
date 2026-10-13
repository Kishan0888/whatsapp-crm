import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { PageHeader } from "@/components/page-header";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ImportStatusBadge } from "@/components/import-status-badge";
import { fmtDate, fmtInt } from "@/lib/utils";
import type { ImportRecord } from "@/lib/types";

export const metadata = { title: "Import history" };

export default async function ImportsPage() {
  await requireUser();
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("imports")
    .select("*, segments(name), profiles:created_by(full_name, email)")
    .order("created_at", { ascending: false })
    .limit(200);
  type Row = ImportRecord & { segments: { name: string } | null; profiles: { full_name: string | null; email: string | null } | null };
  const rows = (data ?? []) as unknown as Row[];

  return (
    <>
      <PageHeader title="Import history" actions={<Button asChild><Link href="/leads/import">New import</Link></Button>} />
      {error && <p className="mb-4 text-sm text-destructive">{error.message}</p>}
      <Card className="py-0">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>File</TableHead>
              <TableHead>Segment</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="text-right">Rows</TableHead>
              <TableHead className="text-right">New</TableHead>
              <TableHead className="text-right">Updated</TableHead>
              <TableHead className="text-right">Duplicates</TableHead>
              <TableHead className="text-right">Errors</TableHead>
              <TableHead>By / when</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.length === 0 && (
              <TableRow><TableCell colSpan={9} className="py-10 text-center text-muted-foreground">No imports yet.</TableCell></TableRow>
            )}
            {rows.map((i) => (
              <TableRow key={i.id}>
                <TableCell><Link className="font-medium hover:underline" href={`/imports/${i.id}`}>{i.file_name}</Link></TableCell>
                <TableCell className="text-sm">{i.segments?.name ?? "—"}</TableCell>
                <TableCell><ImportStatusBadge status={i.status} /></TableCell>
                <TableCell className="text-right tabular-nums">{fmtInt(i.total_rows)}</TableCell>
                <TableCell className="text-right tabular-nums">{fmtInt(i.inserted_count)}</TableCell>
                <TableCell className="text-right tabular-nums">{fmtInt(i.updated_count)}</TableCell>
                <TableCell className="text-right tabular-nums">{fmtInt(i.duplicate_count)}</TableCell>
                <TableCell className="text-right tabular-nums">{i.error_count ? <span className="text-destructive">{fmtInt(i.error_count)}</span> : 0}</TableCell>
                <TableCell className="text-xs text-muted-foreground">
                  {i.profiles?.full_name ?? i.profiles?.email ?? "—"}<br />{fmtDate(i.created_at)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Card>
    </>
  );
}
