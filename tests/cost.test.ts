import { describe, expect, it } from "vitest";
import { estimateCost } from "@/lib/campaigns/audience";

const settings = { default_country: "IN", currency: "INR", est_rate_marketing: 0.8631, est_rate_utility: "0.1150" };

describe("estimateCost", () => {
  it("multiplies home-country eligible recipients by the category rate", () => {
    const c = estimateCost({ eligible: 4500, eligible_home: 4500 }, "MARKETING", settings);
    expect(c).toMatchObject({
      category: "MARKETING", country: "IN", countryName: "India", dialPrefix: "+91", rateConfigured: true,
      rateDecimal: "0.8631", rateLabel: "₹0.8631", pricedRecipients: 4500, unpricedRecipients: 0,
      totalMinor: "388395", totalLabel: "₹3,883.95",
    });
    expect(estimateCost({ eligible: 10, eligible_home: 10 }, "UTILITY", settings)).toMatchObject({ rateDecimal: "0.1150", totalLabel: "₹1.15" });
  });

  it("leaves recipients outside the home country unpriced", () => {
    const c = estimateCost({ eligible: 12, eligible_home: 10 }, "MARKETING", settings);
    expect(c).toMatchObject({ pricedRecipients: 10, unpricedRecipients: 2, totalLabel: "₹8.63" });
  });

  it("reports a missing rate instead of ₹0.00", () => {
    const c = estimateCost({ eligible: 50, eligible_home: 50 }, "MARKETING", { ...settings, est_rate_marketing: 0 });
    expect(c).toMatchObject({ rateConfigured: false, rateLabel: null, totalLabel: null, rateDecimal: "0", pricedRecipients: 0, unpricedRecipients: 50 });
    expect(c.settingsHint).toMatch(/Estimated cost per marketing message/);
    expect(estimateCost({ eligible: 5, eligible_home: 5 }, null, settings)).toMatchObject({ category: null, rateConfigured: false });
  });

  it("uses the configured default country's calling code", () => {
    expect(estimateCost({ eligible: 1, eligible_home: 1 }, "MARKETING", { ...settings, default_country: "AE" })).toMatchObject({
      dialPrefix: "+971", countryName: "United Arab Emirates",
    });
  });
});

describe("loadAudienceSummary error handling", () => {
  it("throws on query errors instead of returning a zero count", async () => {
    const { loadAudienceSummary } = await import("@/lib/campaigns/audience");
    const failing = { rpc: async () => ({ data: null, error: { message: "permission denied for function campaign_audience_summary" } }) };
    await expect(loadAudienceSummary(failing as never, { segment_ids: [], tag_ids: [], tag_match: "any" }, "+91")).rejects.toThrow(
      /Could not calculate the audience: permission denied/,
    );
    const empty = { rpc: async () => ({ data: null, error: null }) };
    await expect(loadAudienceSummary(empty as never, { segment_ids: [], tag_ids: [], tag_match: "any" }, "+91")).rejects.toThrow(/empty response/);
  });

  it("passes the filter and home prefix to the shared SQL classifier", async () => {
    const { loadAudienceSummary } = await import("@/lib/campaigns/audience");
    let args: unknown;
    const ok = { rpc: async (_fn: string, a: unknown) => ((args = a), { data: { matching: 5, eligible: 2, eligible_home: 2, no_consent: 3, computed_at: "2026-10-16T07:00:00Z" }, error: null }) };
    const s = await loadAudienceSummary(ok as never, { segment_ids: ["s1"], tag_ids: [], tag_match: "any" }, "+91");
    expect(args).toEqual({ p_filter: { segment_ids: ["s1"], tag_ids: [], tag_match: "any" }, p_home_prefix: "+91" });
    expect(s).toMatchObject({ matching: 5, eligible: 2, no_consent: 3, invalid_phone: 0 });
  });
});
