import "server-only";
import { cache } from "react";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import type { AppRole, Profile } from "@/lib/types";

/** Verified current user + profile (cached per request). */
export const getCurrentUser = cache(async () => {
  const supabase = await createClient();
  const { data } = await supabase.auth.getUser();
  if (!data.user) return null;
  const { data: profile } = await supabase.from("profiles").select("*").eq("id", data.user.id).single<Profile>();
  return profile ? { user: data.user, profile } : null;
});

/** For pages: redirect unless signed in with an active profile (and one of `roles`, if given). */
export async function requireUser(roles?: AppRole[]) {
  const current = await getCurrentUser();
  if (!current) redirect("/login");
  if (!current.profile.is_active) redirect("/login?inactive=1");
  if (roles && !roles.includes(current.profile.role)) redirect("/dashboard?forbidden=1");
  return current;
}

export class AuthError extends Error {}

/** For server actions / route handlers: throw instead of redirecting. */
export async function assertRole(roles: AppRole[]) {
  const current = await getCurrentUser();
  if (!current || !current.profile.is_active) throw new AuthError("Not signed in");
  if (!roles.includes(current.profile.role)) throw new AuthError("You do not have permission for this action");
  return current;
}

export const CAN_EDIT_LEADS: AppRole[] = ["admin", "manager", "agent"];
export const CAN_MANAGE_CAMPAIGNS: AppRole[] = ["admin", "manager"];
export const ADMIN_ONLY: AppRole[] = ["admin"];

export async function audit(action: string, entityType: string, entityId?: string | null, details?: object) {
  const supabase = await createClient();
  const { error } = await supabase.rpc("log_audit", {
    p_action: action,
    p_entity_type: entityType,
    p_entity_id: entityId ?? null,
    p_details: details ?? {},
  });
  if (error) console.error("[audit] failed to write audit log", action, error.message);
}
