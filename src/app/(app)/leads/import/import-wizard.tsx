"use client";
import Link from "next/link";
import { useMemo, useState } from "react";
import { FileSpreadsheet, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { NativeSelect } from "@/components/ui/native-select";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { autoMap, CHUNK_SIZE, CRM_FIELDS, MAX_ROWS, splitSheet, type ColumnMapping, type MappingTarget } from "@/lib/import/mapping";
import { fmtInt } from "@/lib/utils";
import type { Segment, Tag } from "@/lib/types";
import { createTag } from "../actions";
import { finishImport, importChunk, startImport, type ChunkResult } from "./actions";

type Cell = string | number | boolean | null;
interface Parsed {
  fileName: string;
  fileType: "csv" | "xlsx";
  headers: string[];
  data: Cell[][];
}

const COUNTRIES = [
  ["IN", "India (+91)"], ["AE", "UAE (+971)"], ["US", "United States (+1)"], ["GB", "United Kingdom (+44)"],
  ["NP", "Nepal (+977)"], ["BD", "Bangladesh (+880)"], ["SA", "Saudi Arabia (+966)"], ["SG", "Singapore (+65)"],
];

function toCell(v: unknown): Cell {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === "number" || typeof v === "boolean") return v;
  return String(v);
}

async function parseFile(file: File): Promise<Parsed> {
  const lower = file.name.toLowerCase();
  let rows: unknown[][];
  let fileType: "csv" | "xlsx";
  if (lower.endsWith(".csv")) {
    fileType = "csv";
    const Papa = (await import("papaparse")).default;
    rows = await new Promise((resolve, reject) =>
      Papa.parse<string[]>(file, {
        skipEmptyLines: "greedy",
        complete: (r) => resolve(r.data),
        error: (e) => reject(e),
      }),
    );
  } else if (lower.endsWith(".xlsx")) {
    fileType = "xlsx";
    const { readSheet } = await import("read-excel-file/browser");
    rows = (await readSheet(file)) as unknown[][];
  } else {
    throw new Error("Upload a .csv or .xlsx file");
  }
  const { headers, data } = splitSheet(rows);
  if (!headers.length) throw new Error("The file is empty");
  return { fileName: file.name, fileType, headers, data: data.map((r) => headers.map((_, i) => toCell(r[i]))) };
}

export function ImportWizard({ segments, tags: initialTags }: { segments: Segment[]; tags: Tag[] }) {
  const [parsed, setParsed] = useState<Parsed | null>(null);
  const [parsing, setParsing] = useState(false);
  const [mapping, setMapping] = useState<ColumnMapping>({});
  const [segmentId, setSegmentId] = useState("");
  const [tags, setTags] = useState(initialTags);
  const [tagIds, setTagIds] = useState<string[]>([]);
  const [newTag, setNewTag] = useState("");
  const [strategy, setStrategy] = useState<"skip" | "update">("skip");
  const [country, setCountry] = useState("IN");
  const [consentDeclared, setConsentDeclared] = useState(false);
  const [consentEvidence, setConsentEvidence] = useState("");
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState(0);
  const [totals, setTotals] = useState<ChunkResult | null>(null);
  const [importId, setImportId] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const phoneCols = useMemo(() => Object.values(mapping).filter((t) => t === "phone").length, [mapping]);

  async function onFile(file: File | undefined) {
    if (!file) return;
    if (file.size > 25 * 1024 * 1024) return void toast.error("File is larger than 25 MB");
    setParsing(true);
    try {
      const p = await parseFile(file);
      if (p.data.length === 0) throw new Error("No data rows found below the header row");
      if (p.data.length > MAX_ROWS) throw new Error(`Files are limited to ${fmtInt(MAX_ROWS)} rows`);
      setParsed(p);
      setMapping(autoMap(p.headers));
      setTotals(null);
      setDone(false);
      setImportId(null);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not read file");
    } finally {
      setParsing(false);
    }
  }

  async function addTag() {
    if (!newTag.trim()) return;
    const r = await createTag(newTag);
    if (!r.ok || !r.data) return void toast.error(r.ok ? "Failed" : r.error);
    const t = r.data;
    setTags((all) => (all.some((x) => x.id === t.id) ? all : [...all, { id: t.id, name: t.name, color: "#64748b" }]));
    setTagIds((ids) => (ids.includes(t.id) ? ids : [...ids, t.id]));
    setNewTag("");
  }

  async function run() {
    if (!parsed) return;
    setRunning(true);
    setProgress(0);
    const sum: ChunkResult = { inserted: 0, updated: 0, duplicates: 0, errors: 0 };
    setTotals(sum);
    const start = await startImport({
      fileName: parsed.fileName,
      fileType: parsed.fileType,
      segmentId,
      tagIds,
      duplicateStrategy: strategy,
      defaultCountry: country,
      mapping,
      totalRows: parsed.data.length,
      consentDeclared,
      consentEvidence,
    });
    if (!start.ok) {
      setRunning(false);
      return void toast.error(start.error);
    }
    const id = start.data.importId;
    setImportId(id);
    try {
      for (let i = 0; i < parsed.data.length; i += CHUNK_SIZE) {
        const r = await importChunk({
          importId: id,
          headers: parsed.headers,
          firstRowNumber: i + 2,
          rows: parsed.data.slice(i, i + CHUNK_SIZE),
        });
        if (!r.ok) throw new Error(`Rows ${i + 2}–${Math.min(i + CHUNK_SIZE, parsed.data.length) + 1}: ${r.error}`);
        sum.inserted += r.data.inserted;
        sum.updated += r.data.updated;
        sum.duplicates += r.data.duplicates;
        sum.errors += r.data.errors;
        setTotals({ ...sum });
        setProgress(Math.min(1, (i + CHUNK_SIZE) / parsed.data.length));
      }
      await finishImport(id, false);
      setDone(true);
      toast.success(`Import complete: ${fmtInt(sum.inserted)} new lead(s)`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Import failed";
      await finishImport(id, true, msg);
      toast.error(msg);
    } finally {
      setRunning(false);
    }
  }

  if (!parsed) {
    return (
      <Card>
        <CardContent>
          <label className="flex cursor-pointer flex-col items-center justify-center gap-3 rounded-lg border-2 border-dashed p-12 text-center hover:bg-muted/40">
            {parsing ? <Loader2 className="size-8 animate-spin text-muted-foreground" /> : <FileSpreadsheet className="size-8 text-muted-foreground" />}
            <div>
              <div className="font-medium">{parsing ? "Reading file…" : "Choose a CSV or Excel (.xlsx) file"}</div>
              <div className="text-sm text-muted-foreground">First row must contain column headers. Up to {fmtInt(MAX_ROWS)} rows.</div>
            </div>
            <input type="file" accept=".csv,.xlsx" className="sr-only" disabled={parsing} onChange={(e) => onFile(e.target.files?.[0])} />
          </label>
        </CardContent>
      </Card>
    );
  }

  const sample = parsed.data.slice(0, 3);

  return (
    <div className="grid gap-4">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center justify-between">
            <span className="flex items-center gap-2"><FileSpreadsheet className="size-4" /> {parsed.fileName}</span>
            {!running && !done && <Button variant="ghost" size="sm" onClick={() => setParsed(null)}>Choose another file</Button>}
          </CardTitle>
          <CardDescription>{fmtInt(parsed.data.length)} data rows · {parsed.headers.length} columns</CardDescription>
        </CardHeader>
      </Card>

      <fieldset disabled={running || done} className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-1">
          <CardHeader><CardTitle>Import settings</CardTitle></CardHeader>
          <CardContent className="grid gap-4">
            <div className="grid gap-2">
              <Label htmlFor="segment">Assign segment</Label>
              <NativeSelect id="segment" value={segmentId} onChange={(e) => setSegmentId(e.target.value)}>
                <option value="">No segment</option>
                {segments.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </NativeSelect>
            </div>
            <div className="grid gap-2">
              <Label>Add tags</Label>
              <div className="flex flex-wrap gap-1.5">
                {tags.map((t) => (
                  <label key={t.id} className="cursor-pointer rounded-md border px-2 py-1 text-xs has-checked:border-primary has-checked:bg-accent">
                    <input type="checkbox" className="sr-only" checked={tagIds.includes(t.id)} onChange={(e) => setTagIds((ids) => (e.target.checked ? [...ids, t.id] : ids.filter((x) => x !== t.id)))} />
                    {t.name}
                  </label>
                ))}
              </div>
              <div className="flex gap-1">
                <Input className="h-8" placeholder="New tag" value={newTag} onChange={(e) => setNewTag(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addTag(); } }} />
                <Button type="button" size="sm" variant="outline" onClick={addTag}>Add</Button>
              </div>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="country">Default country for numbers without a code</Label>
              <NativeSelect id="country" value={country} onChange={(e) => setCountry(e.target.value)}>
                {COUNTRIES.map(([c, l]) => <option key={c} value={c}>{l}</option>)}
              </NativeSelect>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="strategy">When a phone number already exists</Label>
              <NativeSelect id="strategy" value={strategy} onChange={(e) => setStrategy(e.target.value as "skip" | "update")}>
                <option value="skip">Skip the row (keep existing lead)</option>
                <option value="update">Update existing lead (fill new values, add tags, set segment)</option>
              </NativeSelect>
            </div>
            <div className="grid gap-2 rounded-md border p-3">
              <label className="flex items-start gap-2 text-sm">
                <input type="checkbox" className="mt-0.5" checked={consentDeclared} onChange={(e) => setConsentDeclared(e.target.checked)} />
                <span>All contacts in this file opted in to receive WhatsApp marketing messages from us.</span>
              </label>
              {consentDeclared && (
                <Textarea rows={3} placeholder="How and when did they opt in? e.g. 'WhatsApp opt-in checkbox on hospital enquiry form, Jan–Sep 2026'" value={consentEvidence} onChange={(e) => setConsentEvidence(e.target.value)} />
              )}
              <p className="text-xs text-muted-foreground">
                Leave unchecked if unsure — leads are imported with unknown consent and won&apos;t receive marketing campaigns until opt-in is recorded. A mapped opt-in column overrides this per row.
              </p>
            </div>
          </CardContent>
        </Card>

        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>Map columns</CardTitle>
            <CardDescription>Unmapped columns are kept as custom fields on each lead unless set to Ignore.</CardDescription>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Spreadsheet column</TableHead>
                  <TableHead>Sample values</TableHead>
                  <TableHead className="w-56">CRM field</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {parsed.headers.map((h, i) => (
                  <TableRow key={h}>
                    <TableCell className="font-medium">{h}</TableCell>
                    <TableCell className="max-w-64 truncate text-xs text-muted-foreground">
                      {sample.map((r) => r[i]).filter((v) => v !== null && v !== "").join(" · ") || "—"}
                    </TableCell>
                    <TableCell>
                      <NativeSelect className="h-8" value={mapping[h]} onChange={(e) => setMapping((m) => ({ ...m, [h]: e.target.value as MappingTarget }))}>
                        {CRM_FIELDS.map((f) => <option key={f.key} value={f.key}>{f.label}</option>)}
                        <option value="custom">Custom field</option>
                        <option value="ignore">Ignore</option>
                      </NativeSelect>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            {phoneCols !== 1 && <p className="mt-3 text-sm text-destructive">Map exactly one column to Phone (currently {phoneCols}).</p>}
          </CardContent>
        </Card>
      </fieldset>

      <Card>
        <CardContent className="grid gap-3">
          {totals && (
            <>
              <div className="h-2 overflow-hidden rounded-full bg-muted">
                <div className="h-full bg-primary transition-all" style={{ width: `${Math.round(progress * 100)}%` }} />
              </div>
              <div className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-4">
                <div><div className="text-muted-foreground">New leads</div><div className="text-lg font-semibold tabular-nums">{fmtInt(totals.inserted)}</div></div>
                <div><div className="text-muted-foreground">Updated</div><div className="text-lg font-semibold tabular-nums">{fmtInt(totals.updated)}</div></div>
                <div><div className="text-muted-foreground">Duplicates</div><div className="text-lg font-semibold tabular-nums">{fmtInt(totals.duplicates)}</div></div>
                <div><div className="text-muted-foreground">Invalid rows</div><div className="text-lg font-semibold tabular-nums text-destructive">{fmtInt(totals.errors)}</div></div>
              </div>
            </>
          )}
          <div className="flex flex-wrap gap-2">
            {!done && (
              <Button onClick={run} disabled={running || phoneCols !== 1 || (consentDeclared && consentEvidence.trim().length < 10)}>
                {running ? <><Loader2 className="animate-spin" /> Importing…</> : `Import ${fmtInt(parsed.data.length)} rows`}
              </Button>
            )}
            {importId && (done || !running) && (
              <>
                <Button variant="outline" asChild><Link href={`/imports/${importId}`}>View import report</Link></Button>
                <Button variant="outline" asChild><Link href={`/leads?import=${importId}`}>View imported leads</Link></Button>
              </>
            )}
            {done && <Button variant="ghost" onClick={() => setParsed(null)}>Import another file</Button>}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
