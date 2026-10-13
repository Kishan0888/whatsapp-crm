import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { whatsappMode } from "@/lib/env";

export interface WaConfig {
  mode: "mock" | "live";
  token?: string;
  appSecret?: string;
  verifyToken?: string;
  appId?: string;
  wabaId?: string;
  phoneNumberId?: string;
  version: string;
  sendRatePerSecond: number;
  currency: string;
  estRates: { MARKETING: number; UTILITY: number };
}

/** Secrets from env; non-secret IDs from Settings (env overrides). */
export async function loadWaConfig(): Promise<WaConfig> {
  const admin = createAdminClient();
  const { data: s } = await admin.from("app_settings").select("*").eq("id", 1).single();
  const env = (k: string) => process.env[k] || undefined;
  return {
    mode: whatsappMode(),
    token: env("WHATSAPP_ACCESS_TOKEN"),
    appSecret: env("WHATSAPP_APP_SECRET"),
    verifyToken: env("WHATSAPP_WEBHOOK_VERIFY_TOKEN"),
    appId: env("WHATSAPP_APP_ID"),
    wabaId: env("WHATSAPP_WABA_ID") ?? s?.waba_id ?? undefined,
    phoneNumberId: env("WHATSAPP_PHONE_NUMBER_ID") ?? s?.phone_number_id ?? undefined,
    version: env("WHATSAPP_GRAPH_API_VERSION") ?? s?.graph_api_version ?? "v23.0",
    sendRatePerSecond: s?.send_rate_per_second ?? 20,
    currency: s?.currency ?? "INR",
    estRates: { MARKETING: Number(s?.est_rate_marketing ?? 0), UTILITY: Number(s?.est_rate_utility ?? 0) },
  };
}

export class WaConfigError extends Error {}

type Need = "token" | "wabaId" | "phoneNumberId" | "appId" | "live";
const LABEL: Record<Need, string> = {
  token: "WHATSAPP_ACCESS_TOKEN",
  wabaId: "WhatsApp Business Account ID (Settings)",
  phoneNumberId: "Phone number ID (Settings)",
  appId: "WHATSAPP_APP_ID",
  live: "WHATSAPP_MODE=live",
};

/** Throw a clear error listing missing configuration. */
export function requireConfig(cfg: WaConfig, needs: Need[]) {
  const missing = needs.filter((n) => (n === "live" ? cfg.mode !== "live" : !cfg[n]));
  if (missing.length) throw new WaConfigError(`WhatsApp is not configured: missing ${missing.map((m) => LABEL[m]).join(", ")}.`);
}
