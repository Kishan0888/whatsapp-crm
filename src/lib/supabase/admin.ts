import "server-only";
import { createClient } from "@supabase/supabase-js";
import { serviceRoleKey, supabaseEnv } from "@/lib/env";

/**
 * Service-role client: bypasses RLS. Use only in trusted server code
 * (webhooks, background worker) — never with user-controlled filters
 * without an explicit permission check first.
 */
export function createAdminClient() {
  return createClient(supabaseEnv().url, serviceRoleKey(), {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
