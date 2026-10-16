import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getCountryCallingCode, type CountryCode } from "libphonenumber-js/max";
import { estimateMinor, formatMinor, formatRate, rateToUnits } from "@/lib/money";

export interface AudienceFilter {
  segment_ids: string[];
  tag_ids: string[];
  tag_match: "any" | "all";
}

export interface AudienceSummary {
  matching: number;
  invalid_phone: number;
  no_consent: number;
  opted_out: number;
  duplicate_phone: number;
  eligible: number;
  /** Eligible recipients in the country the configured rates apply to. */
  eligible_home: number;
  computed_at: string;
}

export interface CostEstimate {
  category: "MARKETING" | "UTILITY" | null;
  country: string;
  countryName: string;
  dialPrefix: string;
  currency: string;
  rateConfigured: boolean;
  /** Exact decimal string for the DB, e.g. "0.8631"; "0" when not configured. */
  rateDecimal: string;
  rateLabel: string | null;
  pricedRecipients: number;
  unpricedRecipients: number;
  totalMinor: string; // bigint as string (serialisable)
  totalLabel: string | null;
  settingsHint: string;
}

export interface PricingSettings {
  default_country: string;
  currency: string;
  est_rate_marketing: number | string | null;
  est_rate_utility: number | string | null;
}

export function homeCountry(s: Pick<PricingSettings, "default_country">) {
  const country = (s.default_country || "IN").toUpperCase();
  let dialPrefix = "+91";
  try {
    dialPrefix = `+${getCountryCallingCode(country as CountryCode)}`;
  } catch {
    /* fall back to India */
  }
  let countryName = country;
  try {
    countryName = new Intl.DisplayNames(["en"], { type: "region" }).of(country) ?? country;
  } catch {
    /* keep code */
  }
  return { country, dialPrefix, countryName };
}

/** The same server-side classifier launch_campaign uses. Throws on query errors (never returns a silent zero). */
export async function loadAudienceSummary(supabase: SupabaseClient, filter: AudienceFilter, dialPrefix: string): Promise<AudienceSummary> {
  const { data, error } = await supabase.rpc("campaign_audience_summary", { p_filter: filter, p_home_prefix: dialPrefix });
  if (error) throw new Error(`Could not calculate the audience: ${error.message}`);
  if (!data) throw new Error("Could not calculate the audience: empty response");
  const s = data as Record<string, unknown>;
  const n = (k: string) => Number(s[k] ?? 0);
  return {
    matching: n("matching"), invalid_phone: n("invalid_phone"), no_consent: n("no_consent"), opted_out: n("opted_out"),
    duplicate_phone: n("duplicate_phone"), eligible: n("eligible"), eligible_home: n("eligible_home"),
    computed_at: String(s.computed_at ?? new Date().toISOString()),
  };
}

/** eligible × configured rate for the template category and home country. Pure. */
export function estimateCost(summary: Pick<AudienceSummary, "eligible" | "eligible_home">, category: string | null, settings: PricingSettings): CostEstimate {
  const { country, dialPrefix, countryName } = homeCountry(settings);
  const cat = category === "MARKETING" || category === "UTILITY" ? category : null;
  const raw = cat === "MARKETING" ? settings.est_rate_marketing : cat === "UTILITY" ? settings.est_rate_utility : null;
  const units = cat ? rateToUnits(raw) : null;
  const priced = units ? summary.eligible_home : 0;
  const total = units ? estimateMinor(priced, units) : null;
  return {
    category: cat,
    country,
    countryName,
    dialPrefix,
    currency: settings.currency || "INR",
    rateConfigured: !!units,
    rateDecimal: units ? `${units / 10000n}.${(units % 10000n).toString().padStart(4, "0")}` : "0",
    rateLabel: units ? formatRate(units, settings.currency || "INR") : null,
    pricedRecipients: priced,
    unpricedRecipients: summary.eligible - priced,
    totalMinor: (total ?? 0n).toString(),
    totalLabel: total !== null ? formatMinor(total, settings.currency || "INR") : null,
    settingsHint: `Settings → WhatsApp Cloud API → “Estimated cost per ${cat === "UTILITY" ? "utility" : "marketing"} message” (rate for ${countryName})`,
  };
}

export async function loadPricingSettings(supabase: SupabaseClient): Promise<PricingSettings> {
  const { data, error } = await supabase
    .from("app_settings")
    .select("default_country, currency, est_rate_marketing, est_rate_utility")
    .eq("id", 1)
    .single();
  if (error || !data) throw new Error(`Could not load pricing settings: ${error?.message ?? "not found"}`);
  return data as PricingSettings;
}
