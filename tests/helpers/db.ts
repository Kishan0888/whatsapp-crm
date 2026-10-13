/**
 * Spins up PGlite (in-process Postgres) with a minimal stub of Supabase's
 * auth schema/roles and runs every migration in supabase/migrations.
 */
import { PGlite } from "@electric-sql/pglite";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const AUTH_STUB = `
create role anon nologin;
create role authenticated nologin;
create role service_role nologin bypassrls;
create schema auth;
create table auth.users (id uuid primary key, email text, raw_user_meta_data jsonb default '{}'::jsonb);
create function auth.uid() returns uuid language sql stable as
  $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
grant usage on schema public, auth to anon, authenticated, service_role;
`;

const GRANTS = `
grant select, insert, update, delete on all tables in schema public to authenticated, service_role;
grant usage, select on all sequences in schema public to authenticated, service_role;
`;

export const ADMIN = "00000000-0000-0000-0000-000000000001";
export const VIEWER = "00000000-0000-0000-0000-000000000002";

export async function createTestDb() {
  const db = new PGlite();
  await db.exec(AUTH_STUB);
  const dir = join(__dirname, "..", "..", "supabase", "migrations");
  for (const f of readdirSync(dir).sort()) await db.exec(readFileSync(join(dir, f), "utf8"));
  await db.exec(GRANTS);
  await db.query("insert into auth.users (id, email) values ($1, 'admin@x.com'), ($2, 'viewer@x.com')", [ADMIN, VIEWER]);

  /** Run fn as a signed-in user (RLS applies) or as superuser when userId is null. */
  async function as<T>(userId: string | null, fn: () => Promise<T>): Promise<T> {
    await db.exec(`reset role; select set_config('request.jwt.claim.sub', '${userId ?? ""}', false);`);
    if (userId) await db.exec("set role authenticated;");
    try {
      return await fn();
    } finally {
      await db.exec("reset role;");
    }
  }
  return { db, as };
}
