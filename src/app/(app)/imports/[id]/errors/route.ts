import { NextResponse, type NextRequest } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { toCsv } from "@/lib/utils";

/** Row-level error report for an import, including the original row data. */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const current = await getCurrentUser();
  if (!current?.profile.is_active) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const supabase = await createClient();
  const { data: imp } = await supabase.from("imports").select("file_name").eq("id", id).maybeSingle();
  if (!imp) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const all: { row_number: number; error: string; raw: Record<string, string> }[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase
      .from("import_errors")
      .select("row_number, error, raw")
      .eq("import_id", id)
      .order("row_number")
      .range(from, from + 999);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    all.push(...((data ?? []) as typeof all));
    if (!data || data.length < 1000) break;
  }
  const cols = [...new Set(all.flatMap((e) => Object.keys(e.raw ?? {})))];
  const csv = toCsv(["row_number", "error", ...cols], all.map((e) => [e.row_number, e.error, ...cols.map((c) => e.raw?.[c] ?? "")]));
  const base = imp.file_name.replace(/\.[^.]+$/, "").replace(/[^\w.-]+/g, "_");
  return new NextResponse("﻿" + csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${base}-errors.csv"`,
      "Cache-Control": "no-store",
    },
  });
}
