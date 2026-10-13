import type { SupabaseClient } from "@supabase/supabase-js";

export interface LeadFilters {
  q?: string;
  segment?: string;
  tag?: string;
  consent?: string;
  status?: string;
  archived?: "1";
  importId?: string;
}

const UUID = /^[0-9a-f-]{36}$/i;

export function parseLeadFilters(sp: Record<string, string | string[] | undefined>): LeadFilters {
  const one = (k: string) => (typeof sp[k] === "string" ? (sp[k] as string) : undefined);
  const uuid = (k: string) => (one(k) && UUID.test(one(k)!) ? one(k) : undefined);
  return {
    q: one("q")?.slice(0, 100),
    segment: one("segment") === "none" ? "none" : uuid("segment"),
    tag: uuid("tag"),
    consent: ["unknown", "opted_in", "opted_out"].includes(one("consent") ?? "") ? one("consent") : undefined,
    status: ["new", "contacted", "interested", "not_interested", "converted"].includes(one("status") ?? "") ? one("status") : undefined,
    archived: one("archived") === "1" ? "1" : undefined,
    importId: uuid("import"),
  };
}

/**
 * Build a leads query with filters applied. `select` must include
 * `tagfilter:lead_tags!inner(tag_id)` when filtering by tag — this helper
 * adds it automatically.
 */
export function leadsQuery(supabase: SupabaseClient, select: string, f: LeadFilters, count = false) {
  const sel = f.tag ? `${select}, tagfilter:lead_tags!inner(tag_id)` : select;
  let q = supabase.from("leads").select(sel, count ? { count: "exact" } : undefined);
  q = q.eq("is_archived", f.archived === "1");
  if (f.segment === "none") q = q.is("segment_id", null);
  else if (f.segment) q = q.eq("segment_id", f.segment);
  if (f.tag) q = q.eq("tagfilter.tag_id", f.tag);
  if (f.consent) q = q.eq("marketing_consent", f.consent);
  if (f.status) q = q.eq("status", f.status);
  if (f.importId) q = q.eq("import_id", f.importId);
  if (f.q) {
    // Strip PostgREST filter syntax characters before building the OR filter.
    const term = f.q.replace(/[%,()*:\\"']/g, " ").trim();
    if (term) {
      const digits = term.replace(/\D/g, "");
      const ors = ["full_name", "organization", "email", "city"].map((c) => `${c}.ilike.%${term}%`);
      if (digits.length >= 4) ors.push(`phone_e164.like.%${digits}%`);
      q = q.or(ors.join(","));
    }
  }
  return q;
}

export function filtersToSearch(f: LeadFilters): URLSearchParams {
  const p = new URLSearchParams();
  if (f.q) p.set("q", f.q);
  if (f.segment) p.set("segment", f.segment);
  if (f.tag) p.set("tag", f.tag);
  if (f.consent) p.set("consent", f.consent);
  if (f.status) p.set("status", f.status);
  if (f.archived) p.set("archived", "1");
  if (f.importId) p.set("import", f.importId);
  return p;
}
