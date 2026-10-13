import { NextResponse, type NextRequest } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { processQueue } from "@/lib/worker/process";

export const maxDuration = 60;

function authorized(req: NextRequest) {
  const header = req.headers.get("authorization") ?? "";
  const secrets = [process.env.WORKER_SECRET, process.env.CRON_SECRET].filter((s): s is string => !!s && s.length >= 16);
  return secrets.some((s) => {
    const a = Buffer.from(header);
    const b = Buffer.from(`Bearer ${s}`);
    return a.length === b.length && timingSafeEqual(a, b);
  });
}

/** Background sender. Call every minute from a scheduler (Vercel Cron, pg_cron, or scripts/worker.mjs). */
async function handle(req: NextRequest) {
  if (!authorized(req)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try {
    const stats = await processQueue({ budgetMs: 50_000 });
    return NextResponse.json({ ok: true, ...stats });
  } catch (e) {
    console.error("[worker] failed", e);
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : "Worker failed" }, { status: 500 });
  }
}

export const GET = handle;
export const POST = handle;
