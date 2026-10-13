/**
 * What to do with a failed send, based on Meta's error-code reference
 * (developers.facebook.com/documentation/business-messaging/whatsapp/support/error-codes).
 */
export type ErrorAction = "retry" | "opt_out" | "systemic" | "permanent";

export const MAX_ATTEMPTS = 5;

/** Must match public.retryable_error_codes() in the database. */
export const RETRYABLE_CODES = ["4", "80007", "130429", "131000", "131016", "131056", "131049", "network", "http_5xx"];

/** Account/token/template-level problems: pause the whole campaign, don't burn the list. */
const SYSTEMIC = new Set([
  "0", "3", "10", "190", "200", "368", // auth, permissions, WABA restricted
  "131005", "131031", "131037", "131042", "131045", "131057", "133010", // account, billing, registration
  "132001", "132005", "132007", "132015", "132016", // template missing/paused/disabled
]);

export function classifyError(code: string | undefined, attempts: number): { action: ErrorAction; retryInSec?: number } {
  const c = code ?? "network";
  if (c === "131050") return { action: "opt_out" }; // user stopped marketing messages
  if (SYSTEMIC.has(c)) return { action: "systemic" };
  // 131049 (marketing limit) needs a 24h wait: fail now, allow manual retry later.
  if (c === "131049") return { action: "permanent" };
  if (c === "131000") return attempts < 2 ? { action: "retry", retryInSec: 30 } : { action: "permanent" }; // retry once
  if (RETRYABLE_CODES.includes(c)) {
    if (attempts >= MAX_ATTEMPTS) return { action: "permanent" };
    const base = c === "131056" ? 120 : c === "4" || c === "80007" ? 60 : 15;
    return { action: "retry", retryInSec: Math.min(base * 2 ** (attempts - 1), 3600) };
  }
  return { action: "permanent" };
}
