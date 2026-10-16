/**
 * Exact money maths for cost estimates. Rates are stored as numeric(10,4);
 * we work in integer ten-thousandths of the currency unit (BigInt) and round
 * half-up to whole paise/cents only at the end, matching Postgres round(x, 2).
 */
const SCALE = 4;

/** Parse a rate into integer 1/10,000 units. Returns null when missing, invalid or ≤ 0 ("not configured"). */
export function rateToUnits(rate: number | string | null | undefined): bigint | null {
  if (rate === null || rate === undefined || rate === "") return null;
  const s = typeof rate === "number" ? (Number.isFinite(rate) ? rate.toFixed(SCALE) : "") : rate.trim();
  const m = /^(\d+)(?:\.(\d{1,4}))?\d*$/.exec(s);
  if (!m) return null;
  const units = BigInt(m[1]) * 10n ** BigInt(SCALE) + BigInt((m[2] ?? "").padEnd(SCALE, "0"));
  return units > 0n ? units : null;
}

/** count × rate, rounded half-up to minor units (paise). */
export function estimateMinor(count: number, rateUnits: bigint): bigint {
  if (!Number.isInteger(count) || count < 0) throw new Error("count must be a non-negative integer");
  const raw = BigInt(count) * rateUnits; // in 1/10,000
  return (raw + 50n) / 100n; // → 1/100
}

export function formatMinor(minor: bigint, currency = "INR"): string {
  const neg = minor < 0n;
  const abs = neg ? -minor : minor;
  const whole = abs / 100n;
  const frac = (abs % 100n).toString().padStart(2, "0");
  const fmt = new Intl.NumberFormat("en-IN", { style: "currency", currency, maximumFractionDigits: 0, minimumFractionDigits: 0 });
  // Group the whole part (exact for any realistic total), then append exact paise.
  return `${neg ? "-" : ""}${fmt.format(Number(whole))}.${frac}`;
}

export function formatRate(units: bigint, currency = "INR"): string {
  const whole = units / 10000n;
  const frac = (units % 10000n).toString().padStart(4, "0").replace(/0{1,2}$/, (z) => (z.length === 2 ? "" : z.slice(1)));
  const sym = new Intl.NumberFormat("en-IN", { style: "currency", currency }).formatToParts(0).find((p) => p.type === "currency")?.value ?? currency;
  return `${sym}${whole}.${frac.length < 2 ? frac.padEnd(2, "0") : frac}`;
}
