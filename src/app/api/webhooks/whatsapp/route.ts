import { NextResponse, type NextRequest } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { createAdminClient } from "@/lib/supabase/admin";
import { parseWebhook, verifySignature } from "@/lib/whatsapp/webhook";
import { ingestEvents } from "@/lib/whatsapp/events";


const safeEqual = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

/** Meta's verification handshake. */
export async function GET(req: NextRequest) {
  const p = req.nextUrl.searchParams;
  const expected = process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN;
  if (expected && p.get("hub.mode") === "subscribe" && safeEqual(p.get("hub.verify_token") ?? "", expected)) {
    return new NextResponse(p.get("hub.challenge") ?? "", { status: 200, headers: { "Content-Type": "text/plain" } });
  }
  return new NextResponse("Forbidden", { status: 403 });
}

/** Event notifications. The body is only trusted after HMAC validation. */
export async function POST(req: NextRequest) {
  const secret = process.env.WHATSAPP_APP_SECRET;
  if (!secret) {
    console.error("[webhook] WHATSAPP_APP_SECRET is not set; rejecting webhook");
    return NextResponse.json({ error: "Webhook not configured" }, { status: 503 });
  }
  const raw = await req.text();
  if (!verifySignature(raw, req.headers.get("x-hub-signature-256"), secret)) {
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  try {
    const result = await ingestEvents(createAdminClient(), parseWebhook(body));
    // If an inbound message couldn't be processed, ask Meta to redeliver; the
    // stored event is re-driven on retry and replies stay idempotent.
    if (result.failedInbound > 0) return NextResponse.json({ ok: false, ...result }, { status: 500 });
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    // Non-200 makes Meta retry delivery; events are stored idempotently.
    console.error("[webhook] failed to ingest", e);
    return NextResponse.json({ error: "Temporary failure" }, { status: 500 });
  }
}
