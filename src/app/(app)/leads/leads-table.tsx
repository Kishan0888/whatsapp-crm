"use client";
import Link from "next/link";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { Card } from "@/components/ui/card";
import { ConsentBadge } from "@/components/consent-badge";
import type { ConsentStatus, Segment, Tag } from "@/lib/types";
import { bulkAddTag, bulkSetSegment, setArchived, type ActionResult } from "./actions";

export interface LeadRow {
  id: string;
  full_name: string | null;
  organization: string | null;
  phone_e164: string | null;
  email: string | null;
  city: string | null;
  status: string;
  marketing_consent: ConsentStatus;
  segment_id: string | null;
  lead_tags: { tag_id: string }[];
}

export function LeadsTable({
  rows,
  segments,
  tags,
  canEdit,
  archivedView,
}: {
  rows: LeadRow[];
  segments: Segment[];
  tags: Tag[];
  canEdit: boolean;
  archivedView: boolean;
}) {
  const router = useRouter();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [pending, start] = useTransition();
  const [tagName, setTagName] = useState("");
  const segById = new Map(segments.map((s) => [s.id, s]));
  const tagById = new Map(tags.map((t) => [t.id, t]));
  const allSelected = rows.length > 0 && rows.every((r) => selected.has(r.id));

  const run = (fn: () => Promise<ActionResult>) =>
    start(async () => {
      const r = await fn();
      if (r.ok) {
        toast.success(r.message ?? "Done");
        setSelected(new Set());
        router.refresh();
      } else toast.error(r.error);
    });

  const toggle = (id: string) =>
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  const ids = [...selected];

  return (
    <Card className="gap-0 py-0">
      {canEdit && selected.size > 0 && (
        <div className="flex flex-wrap items-center gap-2 border-b bg-muted/40 px-3 py-2 text-sm">
          <span className="font-medium">{selected.size} selected</span>
          <NativeSelect
            className="h-8 w-56"
            defaultValue=""
            disabled={pending}
            onChange={(e) => {
              const v = e.target.value;
              e.target.value = "";
              if (v) run(() => bulkSetSegment(ids, v === "none" ? null : v));
            }}
          >
            <option value="">Move to segment…</option>
            {segments.map((s) => (
              <option key={s.id} value={s.id}>{s.name}</option>
            ))}
            <option value="none">Remove segment</option>
          </NativeSelect>
          <form
            className="flex gap-1"
            onSubmit={(e) => {
              e.preventDefault();
              if (tagName.trim()) run(() => bulkAddTag(ids, tagName));
              setTagName("");
            }}
          >
            <Input className="h-8 w-40" placeholder="Add tag" value={tagName} onChange={(e) => setTagName(e.target.value)} list="tag-list" />
            <datalist id="tag-list">{tags.map((t) => <option key={t.id} value={t.name} />)}</datalist>
            <Button size="sm" variant="outline" disabled={pending}>Tag</Button>
          </form>
          <Button size="sm" variant="outline" disabled={pending} onClick={() => run(() => setArchived(ids, !archivedView))}>
            {archivedView ? "Restore" : "Archive"}
          </Button>
        </div>
      )}
      <Table>
        <TableHeader>
          <TableRow>
            {canEdit && (
              <TableHead className="w-8">
                <input
                  type="checkbox"
                  aria-label="Select all"
                  checked={allSelected}
                  onChange={() => setSelected(allSelected ? new Set() : new Set(rows.map((r) => r.id)))}
                />
              </TableHead>
            )}
            <TableHead>Name / Organization</TableHead>
            <TableHead>Phone</TableHead>
            <TableHead>Segment</TableHead>
            <TableHead>Tags</TableHead>
            <TableHead>City</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Consent</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.length === 0 && (
            <TableRow>
              <TableCell colSpan={8} className="py-10 text-center text-muted-foreground">No leads match these filters.</TableCell>
            </TableRow>
          )}
          {rows.map((r) => {
            const seg = r.segment_id ? segById.get(r.segment_id) : undefined;
            return (
              <TableRow key={r.id} data-state={selected.has(r.id) ? "selected" : undefined} className="data-[state=selected]:bg-accent/60">
                {canEdit && (
                  <TableCell>
                    <input type="checkbox" aria-label="Select lead" checked={selected.has(r.id)} onChange={() => toggle(r.id)} />
                  </TableCell>
                )}
                <TableCell className="max-w-64">
                  <Link href={`/leads/${r.id}`} className="block truncate font-medium hover:underline">
                    {r.full_name || r.organization || "Unnamed lead"}
                  </Link>
                  {r.full_name && r.organization && <div className="truncate text-xs text-muted-foreground">{r.organization}</div>}
                </TableCell>
                <TableCell className="font-mono text-xs">{r.phone_e164 ?? "—"}</TableCell>
                <TableCell>
                  {seg ? (
                    <span className="inline-flex items-center gap-1.5 text-xs">
                      <span className="size-2 rounded-full" style={{ background: seg.color }} />
                      {seg.name}
                    </span>
                  ) : (
                    <span className="text-xs text-muted-foreground">—</span>
                  )}
                </TableCell>
                <TableCell className="max-w-48">
                  <div className="flex flex-wrap gap-1">
                    {r.lead_tags.slice(0, 3).map((lt) => (
                      <span key={lt.tag_id} className="rounded bg-muted px-1.5 py-0.5 text-xs">{tagById.get(lt.tag_id)?.name}</span>
                    ))}
                    {r.lead_tags.length > 3 && <span className="text-xs text-muted-foreground">+{r.lead_tags.length - 3}</span>}
                  </div>
                </TableCell>
                <TableCell className="text-sm">{r.city ?? "—"}</TableCell>
                <TableCell className="text-xs capitalize">{r.status.replace("_", " ")}</TableCell>
                <TableCell><ConsentBadge status={r.marketing_consent} /></TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </Card>
  );
}
