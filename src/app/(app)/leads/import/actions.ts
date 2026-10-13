"use server";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { assertRole, audit, AuthError, CAN_EDIT_LEADS } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { CRM_FIELDS, transformRow, type ColumnMapping, type ImportRow, MAX_ROWS, CHUNK_SIZE } from "@/lib/import/fields";

type Result<T> = { ok: true; data: T } | { ok: false; error: string };
const fail = (e: unknown): { ok: false; error: string } => ({
  ok: false,
  error: e instanceof AuthError || e instanceof Error ? e.message : "Unexpected error",
});


const targets = z.enum(["custom", "ignore", ...CRM_FIELDS.map((f) => f.key)]);

const startSchema = z
  .object({
    fileName: z.string().trim().min(1).max(255),
    fileType: z.enum(["csv", "xlsx"]),
    segmentId: z.union([z.uuid(), z.literal("")]).transform((v) => v || null),
    tagIds: z.array(z.uuid()).max(50),
    duplicateStrategy: z.enum(["skip", "update"]),
    defaultCountry: z.string().regex(/^[A-Z]{2}$/),
    mapping: z.record(z.string().max(255), targets),
    totalRows: z.number().int().min(1).max(MAX_ROWS),
    consentDeclared: z.boolean(),
    consentEvidence: z.string().trim().max(1000),
  })
  .refine((v) => Object.values(v.mapping).filter((t) => t === "phone").length === 1, "Map exactly one column to Phone")
  .refine((v) => !v.consentDeclared || v.consentEvidence.length >= 10, "Describe how these contacts opted in (at least 10 characters)");

export async function startImport(input: z.input<typeof startSchema>): Promise<Result<{ importId: string }>> {
  try {
    const { profile } = await assertRole(CAN_EDIT_LEADS);
    const p = startSchema.safeParse(input);
    if (!p.success) return { ok: false, error: p.error.issues[0].message };
    const d = p.data;
    const supabase = await createClient();
    const { data, error } = await supabase
      .from("imports")
      .insert({
        file_name: d.fileName,
        file_type: d.fileType,
        segment_id: d.segmentId,
        tag_ids: d.tagIds,
        duplicate_strategy: d.duplicateStrategy,
        default_country: d.defaultCountry,
        column_mapping: d.mapping,
        total_rows: d.totalRows,
        // A non-null consent_basis means the uploader declared that every row
        // without an explicit opt-in/opt-out value has opted in.
        consent_basis: d.consentDeclared ? d.consentEvidence : null,
        created_by: profile.id,
      })
      .select("id")
      .single();
    if (error) return { ok: false, error: error.message };
    await audit("import.start", "import", data.id, { file: d.fileName, rows: d.totalRows, consentDeclared: d.consentDeclared });
    return { ok: true, data: { importId: data.id } };
  } catch (e) {
    return fail(e);
  }
}

const chunkSchema = z.object({
  importId: z.uuid(),
  headers: z.array(z.string().max(255)).min(1).max(200),
  /** Spreadsheet row number of rows[0] (header = row 1). */
  firstRowNumber: z.number().int().min(2),
  rows: z.array(z.array(z.union([z.string(), z.number(), z.boolean(), z.null()]))).max(CHUNK_SIZE),
});

export interface ChunkResult {
  inserted: number;
  updated: number;
  duplicates: number;
  errors: number;
}

/**
 * Validate, normalise and write one chunk. The column mapping and options
 * are read from the stored import record — not trusted from the client.
 */
export async function importChunk(input: z.input<typeof chunkSchema>): Promise<Result<ChunkResult>> {
  try {
    await assertRole(CAN_EDIT_LEADS);
    const p = chunkSchema.safeParse(input);
    if (!p.success) return { ok: false, error: p.error.issues[0].message };
    const { importId, headers, rows, firstRowNumber } = p.data;
    const supabase = await createClient();
    const { data: imp, error: impErr } = await supabase
      .from("imports")
      .select("id, status, column_mapping, default_country, consent_basis")
      .eq("id", importId)
      .single();
    if (impErr || !imp) return { ok: false, error: "Import not found" };
    if (imp.status !== "processing") return { ok: false, error: "Import is no longer processing" };

    const mapping = imp.column_mapping as ColumnMapping;
    const good: ImportRow[] = [];
    const errors: { import_id: string; row_number: number; error: string; raw: Record<string, string> }[] = [];
    const seen = new Map<string, number>();

    rows.forEach((values, i) => {
      const rowNumber = firstRowNumber + i;
      const r = transformRow(headers, values, mapping, rowNumber, imp.default_country);
      if (!r.ok) {
        errors.push({ import_id: importId, row_number: rowNumber, error: r.error, raw: r.raw });
        return;
      }
      const prev = seen.get(r.row.phone_e164);
      if (prev) {
        errors.push({
          import_id: importId,
          row_number: rowNumber,
          error: `Duplicate phone ${r.row.phone_e164} — same as row ${prev} in this file`,
          raw: { phone: r.row.phone_raw, name: r.row.full_name ?? "" },
        });
        return;
      }
      seen.set(r.row.phone_e164, rowNumber);
      if (r.row.consent === null && imp.consent_basis) r.row.consent = "opted_in";
      good.push(r.row);
    });

    if (errors.length) {
      const { error } = await supabase.from("import_errors").insert(errors);
      if (error) return { ok: false, error: `Could not record row errors: ${error.message}` };
    }

    let res = { inserted: 0, updated: 0, duplicates: 0 };
    if (good.length) {
      const { data, error } = await supabase.rpc("import_leads_batch", { p_import_id: importId, p_rows: good });
      if (error) return { ok: false, error: error.message };
      res = data as typeof res;
    }
    const invalid = errors.filter((e) => !e.error.startsWith("Duplicate")).length;
    const inFileDupes = errors.length - invalid;
    if (invalid || inFileDupes) {
      const { data: cur } = await supabase.from("imports").select("error_count, duplicate_count").eq("id", importId).single();
      await supabase
        .from("imports")
        .update({ error_count: (cur?.error_count ?? 0) + invalid, duplicate_count: (cur?.duplicate_count ?? 0) + inFileDupes })
        .eq("id", importId);
    }
    return { ok: true, data: { ...res, duplicates: res.duplicates + inFileDupes, errors: invalid } };
  } catch (e) {
    return fail(e);
  }
}

export async function finishImport(importId: string, failed: boolean, reason?: string): Promise<Result<null>> {
  try {
    await assertRole(CAN_EDIT_LEADS);
    const id = z.uuid().parse(importId);
    const supabase = await createClient();
    const { error } = await supabase
      .from("imports")
      .update({ status: failed ? "failed" : "completed", completed_at: new Date().toISOString() })
      .eq("id", id)
      .eq("status", "processing");
    if (error) return { ok: false, error: error.message };
    await audit(failed ? "import.failed" : "import.complete", "import", id, reason ? { reason } : {});
    revalidatePath("/leads");
    revalidatePath("/imports");
    revalidatePath("/dashboard");
    return { ok: true, data: null };
  } catch (e) {
    return fail(e);
  }
}
