import { AuthError } from "@/lib/auth";
import { MetaApiError } from "@/lib/whatsapp/graph";
import { WaConfigError } from "@/lib/whatsapp/config";

export type Result<T = null> = { ok: true; data: T; message?: string } | { ok: false; error: string };

/** Convert thrown errors into a user-facing message (never leaks secrets). */
export function toFail(e: unknown): { ok: false; error: string } {
  if (e instanceof MetaApiError)
    return { ok: false, error: `Meta API error ${e.code}: ${e.message}${e.details ? ` (${e.details})` : ""}` };
  if (e instanceof AuthError || e instanceof WaConfigError) return { ok: false, error: e.message };
  console.error(e);
  return { ok: false, error: e instanceof Error ? e.message : "Unexpected error" };
}
