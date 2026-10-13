import { requireUser } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { PageHeader } from "@/components/page-header";
import { Card } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { fmtDate } from "@/lib/utils";

export const metadata = { title: "Audit log" };

export default async function AuditPage() {
  await requireUser(["admin", "manager"]);
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("audit_logs")
    .select("id, action, entity_type, entity_id, details, created_at, profiles:actor_id(full_name, email)")
    .order("created_at", { ascending: false })
    .limit(300);
  type Row = { id: number; action: string; entity_type: string; entity_id: string | null; details: object; created_at: string; profiles: { full_name: string | null; email: string | null } | null };
  const rows = (data ?? []) as unknown as Row[];
  return (
    <>
      <PageHeader title="Audit log" description="Latest 300 actions. Entries are append-only." />
      {error && <p className="mb-3 text-sm text-destructive">{error.message}</p>}
      <Card className="py-0">
        <Table>
          <TableHeader><TableRow><TableHead>When</TableHead><TableHead>Who</TableHead><TableHead>Action</TableHead><TableHead>Entity</TableHead><TableHead>Details</TableHead></TableRow></TableHeader>
          <TableBody>
            {rows.length === 0 && <TableRow><TableCell colSpan={5} className="py-8 text-center text-muted-foreground">No entries.</TableCell></TableRow>}
            {rows.map((r) => (
              <TableRow key={r.id}>
                <TableCell className="whitespace-nowrap text-xs text-muted-foreground">{fmtDate(r.created_at)}</TableCell>
                <TableCell className="text-sm">{r.profiles?.full_name ?? r.profiles?.email ?? "system"}</TableCell>
                <TableCell className="font-mono text-xs">{r.action}</TableCell>
                <TableCell className="text-xs">{r.entity_type}{r.entity_id ? ` ${r.entity_id.slice(0, 8)}` : ""}</TableCell>
                <TableCell className="max-w-96 truncate font-mono text-xs text-muted-foreground" title={JSON.stringify(r.details)}>{JSON.stringify(r.details)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Card>
    </>
  );
}
