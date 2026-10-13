import { NextResponse, type NextRequest } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { leadsQuery, parseLeadFilters } from "@/lib/leads/filters";
import { toCsv } from "@/lib/utils";

const BATCH = 1000;

/** CSV export of all leads matching the current filters (RLS-scoped). */
export async function GET(req: NextRequest) {
  const current = await getCurrentUser();
  if (!current?.profile.is_active) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const f = parseLeadFilters(Object.fromEntries(req.nextUrl.searchParams));
  const supabase = await createClient();
  const [{ data: segments }, { data: tags }] = await Promise.all([
    supabase.from("segments").select("id, name"),
    supabase.from("tags").select("id, name"),
  ]);
  const segName = new Map((segments ?? []).map((s) => [s.id, s.name]));
  const tagName = new Map((tags ?? []).map((t) => [t.id, t.name]));

  const rows: unknown[][] = [];
  for (let from = 0; ; from += BATCH) {
    const { data, error } = await leadsQuery(
      supabase,
      "id, full_name, organization, phone_e164, email, city, state, country, segment_id, status, marketing_consent, consent_source, source, notes, custom_fields, created_at, lead_tags(tag_id)",
      f,
    )
      .order("created_at")
      .order("id")
      .range(from, from + BATCH - 1);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    type Row = Record<string, unknown> & { lead_tags: { tag_id: string }[]; segment_id: string | null };
    for (const l of (data ?? []) as unknown as Row[]) {
      rows.push([
        l.id, l.full_name, l.organization, l.phone_e164, l.email, l.city, l.state, l.country,
        l.segment_id ? segName.get(l.segment_id) : "",
        l.lead_tags.map((t) => tagName.get(t.tag_id)).filter(Boolean).join("; "),
        l.status, l.marketing_consent, l.consent_source, l.source, l.notes, l.custom_fields, l.created_at,
      ]);
    }
    if (!data || data.length < BATCH) break;
  }

  const csv = toCsv(
    ["id", "name", "organization", "phone", "email", "city", "state", "country", "segment", "tags", "status", "marketing_consent", "consent_source", "source", "notes", "custom_fields", "created_at"],
    rows,
  );
  const stamp = new Date().toISOString().slice(0, 10);
  return new NextResponse("﻿" + csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="leads-${stamp}.csv"`,
      "Cache-Control": "no-store",
    },
  });
}
