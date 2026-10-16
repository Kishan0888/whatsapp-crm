import type { PGlite } from "@electric-sql/pglite";
import type { Rpc } from "@/lib/inbox/handler";

/** Call SQL functions the way supabase.rpc does (named args, scalar/jsonb result). */
export function pgRpc(db: PGlite): Rpc {
  return async <T,>(fn: string, args: Record<string, unknown>) => {
    const keys = Object.keys(args);
    const sql = `select public.${fn}(${keys.map((k, i) => `${k} => $${i + 1}`).join(", ")}) as r`;
    const vals = keys.map((k) => (args[k] !== null && typeof args[k] === "object" ? JSON.stringify(args[k]) : args[k]));
    const res = await db.query<{ r: T }>(sql, vals);
    return res.rows[0]?.r as T;
  };
}
