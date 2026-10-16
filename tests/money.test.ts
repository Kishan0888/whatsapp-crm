import { describe, expect, it } from "vitest";
import { estimateMinor, formatMinor, formatRate, rateToUnits } from "@/lib/money";

describe("money", () => {
  it("parses rates exactly and treats 0/blank/invalid as not configured", () => {
    expect(rateToUnits("0.8631")).toBe(8631n);
    expect(rateToUnits(0.8631)).toBe(8631n);
    expect(rateToUnits("1.1")).toBe(11000n);
    expect(rateToUnits(0)).toBeNull();
    expect(rateToUnits("0.0000")).toBeNull();
    expect(rateToUnits(null)).toBeNull();
    expect(rateToUnits("abc")).toBeNull();
    expect(rateToUnits(-1)).toBeNull();
  });

  it("multiplies without floating-point drift and rounds half-up like Postgres", () => {
    // 0.1 + 0.2 style traps: 3 × 0.1 must be exactly 0.30
    expect(estimateMinor(3, rateToUnits("0.1")!)).toBe(30n);
    // 4,500 × 0.8631 = 3883.95 exactly
    expect(estimateMinor(4500, rateToUnits("0.8631")!)).toBe(388395n);
    // 2 × 0.8625 = 1.725 → 1.73 (half-up); 3 × 0.8631 = 2.5893 → 2.59
    expect(estimateMinor(2, 8625n)).toBe(173n);
    expect(estimateMinor(3, 8631n)).toBe(259n);
    expect(estimateMinor(0, 8631n)).toBe(0n);
    expect(() => estimateMinor(1.5, 1n)).toThrow();
  });

  it("formats INR with Indian grouping", () => {
    expect(formatMinor(388395n)).toBe("₹3,883.95");
    expect(formatMinor(12345678905n)).toBe("₹12,34,56,789.05");
    expect(formatMinor(0n)).toBe("₹0.00");
    expect(formatRate(8631n)).toBe("₹0.8631");
    expect(formatRate(11000n)).toBe("₹1.10");
  });
});
