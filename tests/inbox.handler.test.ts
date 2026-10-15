/**
 * End-to-end inbox handling against the real SQL (PGlite) with the
 * WhatsApp Cloud API mocked at the fetch level. No network calls are made.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { createTestDb } from "./helpers/db";
import { deliverOutbound, handleInbound, type InboxDeps, type Rpc } from "@/lib/inbox/handler";
import { MESSAGES } from "@/lib/inbox/flows";
import type { WaConfig } from "@/lib/whatsapp/config";
import type { InboundEvent } from "@/lib/whatsapp/webhook";

let db: PGlite;
const MEETING = "https://calendly.com/medscale/30min";
const NOW = new Date("2026-10-15T10:00:00Z");

const cfg = (mode: "live" | "mock" = "live"): WaConfig => ({
  mode, token: "test-token", version: "v23.0", phoneNumberId: "PNID", wabaId: "WABA",
  sendRatePerSecond: 20, currency: "INR", estRates: { MARKETING: 0, UTILITY: 0 },
});

/** Call SQL functions the way supabase.rpc does (named args, jsonb result). */
const pgRpc: Rpc = async <T,>(fn: string, args: Record<string, unknown>) => {
  const keys = Object.keys(args);
  const sql = `select public.${fn}(${keys.map((k, i) => `${k} => $${i + 1}`).join(", ")}) as r`;
  const vals = keys.map((k) => (args[k] !== null && typeof args[k] === "object" ? JSON.stringify(args[k]) : args[k]));
  const res = await db.query<{ r: T }>(sql, vals);
  return res.rows[0]?.r as T;
};

let sent: { url: string; body: Record<string, unknown> }[] = [];
let failNext: { status: number; body: object } | null = null;
let optOuts: string[] = [];

function deps(over: Partial<InboxDeps> = {}, meetingUrl: string | null = MEETING): InboxDeps {
  return {
    rpc: pgRpc,
    cfg: cfg(),
    flowSettings: async () => ({ meetingUrl, growthTemplate: null }),
    optOut: async (phone) => {
      optOuts.push(phone);
      await db.query("insert into opt_outs (phone_e164, reason, source) values ($1, 'test', 'webhook_keyword') on conflict do nothing", [phone]);
    },
    now: () => NOW,
    ...over,
  };
}

let seq = 0;
const inbound = (from: string, text: string, msgType = "text", extra: Partial<InboundEvent> = {}): InboundEvent => {
  const wamid = `wamid.in.${++seq}`;
  return { key: `in:${wamid}`, type: "inbound", wamid, from, text, msgType, timestamp: String(Math.floor(NOW.getTime() / 1000)), ...extra };
};
const tap = (from: string, label: string) => inbound(from, label, "button", { buttonPayload: label, contextId: "wamid.campaign" });

const thread = async (phone: string) =>
  (
    await db.query<{ direction: string; type: string; status: string; body: string; wa_message_id: string | null; error_code: string | null }>(
      `select m.direction, m.type, m.status, m.body, m.wa_message_id, m.error_code from messages m
       join conversations c on c.id = m.conversation_id where c.phone_e164 = $1 order by m.id`,
      [phone],
    )
  ).rows;

beforeAll(async () => {
  ({ db } = await createTestDb());
}, 60_000);

beforeEach(() => {
  sent = [];
  failNext = null;
  optOuts = [];
  let n = 0;
  vi.stubGlobal("fetch", vi.fn(async (url: URL | string, init?: RequestInit) => {
    if (failNext) {
      const f = failNext;
      failNext = null;
      return new Response(JSON.stringify(f.body), { status: f.status });
    }
    sent.push({ url: String(url), body: JSON.parse(String(init?.body)) });
    return new Response(JSON.stringify({ messaging_product: "whatsapp", messages: [{ id: `wamid.out.${seq}.${++n}` }] }), { status: 200 });
  }));
});
afterEach(() => vi.unstubAllGlobals());

describe("Free Growth Report", () => {
  it("records the tap, links the lead, sends one CTA reply, and ignores webhook retries", async () => {
    await db.query("insert into leads (phone_e164, full_name) values ('+919810000101', 'Dr. Mehta')");
    const ev = tap("919810000101", "Free Growth Report");
    const r = await handleInbound(deps(), ev);
    expect(r).toEqual({ action: "growth_report", sent: 1 });
    expect(sent).toHaveLength(1);
    expect(sent[0].url).toBe("https://graph.facebook.com/v23.0/PNID/messages");
    expect(sent[0].body).toMatchObject({
      to: "919810000101",
      type: "interactive",
      interactive: { type: "cta_url", action: { name: "cta_url", parameters: { display_text: "Schedule Meeting", url: MEETING } } },
    });

    // Meta redelivers the same webhook.
    await handleInbound(deps(), ev);
    expect(sent).toHaveLength(1);

    const t = await thread("+919810000101");
    expect(t.map((m) => [m.direction, m.type, m.status])).toEqual([["in", "button", "received"], ["out", "cta_url", "sent"]]);
    expect(t[1].wa_message_id).toMatch(/^wamid\.out/);
    const c = await db.query<{ lead: string }>("select l.full_name lead from conversations c join leads l on l.id = c.lead_id where c.phone_e164 = '+919810000101'");
    expect(c.rows[0].lead).toBe("Dr. Mehta");
  });

  it("holds the reply as a staff note when the meeting URL is missing", async () => {
    await handleInbound(deps({}, null), tap("919810000102", "Free Growth Report"));
    expect(sent).toHaveLength(0);
    const t = await thread("+919810000102");
    expect(t[1]).toMatchObject({ direction: "out", type: "note", status: "skipped" });
  });
});

describe("Send Details", () => {
  const phone = "919810000103";

  it("runs the full flow, persists state, saves details on the lead (creating it)", async () => {
    const steps = [tap(phone, "Send Details"), inbound(phone, "Ravi Kumar"), inbound(phone, "City Care Hospital"), inbound(phone, "Mon 20 Oct, 11 AM")];
    const actions = [];
    for (const s of steps) actions.push((await handleInbound(deps(), s)).action);
    expect(actions).toEqual(["start", "got_name", "got_hospital", "complete"]);
    expect(sent.map((s) => (s.body.text as { body: string }).body)).toEqual([
      `${MESSAGES.start}\n\n${MESSAGES.askName}`,
      MESSAGES.askHospital("Ravi Kumar"),
      MESSAGES.askDateTime,
      MESSAGES.done({ representative: "Ravi Kumar", hospital: "City Care Hospital", preferred_time: "Mon 20 Oct, 11 AM" }),
    ]);
    const lead = await db.query("select full_name, organization, source, status, marketing_consent, custom_fields->>'WhatsApp: preferred meeting' t from leads where phone_e164 = $1", [`+${phone}`]);
    expect(lead.rows[0]).toEqual({ full_name: "Ravi Kumar", organization: "City Care Hospital", source: "whatsapp", status: "interested", marketing_consent: "unknown", t: "Mon 20 Oct, 11 AM" });
    const conv = await db.query<{ step: string; linked: boolean }>("select flow->>'step' step, lead_id is not null linked from conversations where phone_e164 = $1", [`+${phone}`]);
    expect(conv.rows[0]).toEqual({ step: "done", linked: true });

    // Replaying an earlier answer must not re-advance the flow or resend.
    await handleInbound(deps(), steps[1]);
    expect(sent).toHaveLength(4);
  });

  it("resumes after a crash between saving state and sending", async () => {
    const p = "919810000104";
    await handleInbound(deps(), tap(p, "Send Details"));
    sent = [];
    const answer = inbound(p, "Anita Sharma");
    // First delivery: state + reply queued, then the process "dies" before sending.
    const crashing: Rpc = async (fn, args) => {
      if (fn === "inbox_pending_replies") throw new Error("simulated crash");
      return pgRpc(fn, args);
    };
    await expect(handleInbound(deps({ rpc: crashing }), answer)).rejects.toThrow(/simulated crash/);
    expect(sent).toHaveLength(0);
    // Meta retries the webhook: the queued reply is sent once, state is not advanced twice.
    await handleInbound(deps(), answer);
    await handleInbound(deps(), answer);
    expect(sent.map((s) => (s.body.text as { body: string }).body)).toEqual([MESSAGES.askHospital("Anita Sharma")]);
    const conv = await db.query<{ step: string }>("select flow->>'step' step from conversations where phone_e164 = $1", [`+${p}`]);
    expect(conv.rows[0].step).toBe("hospital");
  });

  it("cancels on STOP: opts out permanently and sends nothing", async () => {
    const p = "919810000105";
    await handleInbound(deps(), tap(p, "Send Details"));
    sent = [];
    const r = await handleInbound(deps(), inbound(p, "STOP"));
    expect(r.action).toBe("opt_out");
    expect(sent).toHaveLength(0);
    expect(optOuts).toEqual([`+${p}`]);
    const conv = await db.query<{ step: string }>("select flow->>'step' step from conversations where phone_e164 = $1", [`+${p}`]);
    expect(conv.rows[0].step).toBe("cancelled");
  });

  it("records the failure when Meta rejects the send", async () => {
    failNext = { status: 400, body: { error: { message: "Message failed to send", code: 131026, error_data: { details: "Receiver incapable" } } } };
    await handleInbound(deps(), tap("919810000106", "Send Details"));
    const t = await thread("+919810000106");
    expect(t[1]).toMatchObject({ status: "failed", error_code: "131026" });
  });
});

describe("mock mode and service window", () => {
  it("never calls Meta in mock mode", async () => {
    await handleInbound(deps({ cfg: cfg("mock") }), tap("919810000107", "Free Growth Report"));
    expect(sent).toHaveLength(0);
    const t = await thread("+919810000107");
    expect(t[1]).toMatchObject({ type: "cta_url", status: "mock" });
  });

  it("refuses free-form replies outside the 24-hour window", async () => {
    await handleInbound(deps(), inbound("919810000108", "Hello"));
    const conv = await db.query<{ id: string }>("select id from conversations where phone_e164 = '+919810000108'");
    const q = await pgRpc<{ id: number }>("inbox_queue_outbound", {
      p_conversation_id: conv.rows[0].id, p_idempotency_key: "inbox:test-1", p_type: "text", p_body: "Hi!", p_payload: {}, p_source: "inbox", p_sent_by: null,
    });
    const later = new Date(NOW.getTime() + 25 * 3600_000);
    expect(await deliverOutbound(deps({ now: () => later }), q.id)).toBe("failed");
    expect(sent).toHaveLength(0);
    const t = await thread("+919810000108");
    expect(t[1]).toMatchObject({ status: "failed", error_code: "window_closed" });
    // Inside the window it sends, exactly once.
    const q2 = await pgRpc<{ id: number }>("inbox_queue_outbound", {
      p_conversation_id: conv.rows[0].id, p_idempotency_key: "inbox:test-2", p_type: "text", p_body: "Hi!", p_payload: {}, p_source: "inbox", p_sent_by: null,
    });
    expect(await deliverOutbound(deps(), q2.id)).toBe("sent");
    expect(await deliverOutbound(deps(), q2.id)).toBe("not_claimed");
    expect(sent).toHaveLength(1);
  });
});
