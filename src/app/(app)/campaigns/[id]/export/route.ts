import { NextResponse, type NextRequest } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { toCsv } from "@/lib/utils";

/** Recipient-level campaign report. */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const current = await getCurrentUser();
  if (!current?.profile.is_active) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const supabase = await createClient();
  const { data: c } = await supabase.from("campaigns").select("name").eq("id", id).maybeSingle();
  if (!c) return NextResponse.json({ error: "Not found" }, { status: 404 });

  type Row = Record<string, unknown> & { leads: { full_name: string | null; organization: string | null } | null; pricing: { category?: string; type?: string } | null };
  const rows: unknown[][] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase
      .from("campaign_recipients")
      .select("phone_e164, status, wa_message_id, accepted_at, sent_at, delivered_at, read_at, failed_at, last_error_code, last_error, attempts, pricing, leads(full_name, organization)")
      .eq("campaign_id", id)
      .order("id")
      .range(from, from + 999);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    for (const r of (data ?? []) as unknown as Row[]) {
      rows.push([
        r.leads?.full_name, r.leads?.organization, r.phone_e164, r.status, r.wa_message_id, r.accepted_at, r.sent_at,
        r.delivered_at, r.read_at, r.failed_at, r.last_error_code, r.last_error, r.attempts, r.pricing?.category, r.pricing?.type,
      ]);
    }
    if (!data || data.length < 1000) break;
  }
  const csv = toCsv(
    ["name", "organization", "phone", "status", "wa_message_id", "accepted_at", "sent_at", "delivered_at", "read_at", "failed_at", "error_code", "error", "attempts", "pricing_category", "pricing_type"],
    rows,
  );
  const file = c.name.replace(/[^\w.-]+/g, "_").slice(0, 60) || "campaign";
  return new NextResponse("﻿" + csv, {
    headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="${file}-recipients.csv"`, "Cache-Control": "no-store" },
  });
}
