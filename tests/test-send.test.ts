/**
 * Test-send isolation: exactly one message to the chosen number through the
 * live sender (Meta mocked at fetch), recorded in messages — and nothing
 * enqueued for the campaign audience.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { createTestDb } from "./helpers/db";
import { pgRpc } from "./helpers/rpc";
import { executeTestSend, planTestSend } from "@/lib/campaigns/test-send";
import type { InboxDeps } from "@/lib/inbox/handler";
import type { WaConfig } from "@/lib/whatsapp/config";
import { buildComponents, emptyDraft } from "@/lib/whatsapp/templates";

let db: PGlite;
let campaignId: string;
const template = {
  name: "hospital_offer", language: "en", category: "MARKETING",
  components: buildComponents({ ...emptyDraft(), name: "hospital_offer", body: { text: "Hello {{1}}, grow {{2}} with us.", examples: ["Dr. A", "your hospital"] } }),
};
const mapping = {
  "body.1": { source: "field" as const, value: "first_name", fallback: "Doctor" },
  "body.2": { source: "field" as const, value: "organization", fallback: "your hospital" },
};
const cfg = (mode: "live" | "mock" = "live"): WaConfig => ({
  mode, token: "test-token", version: "v23.0", phoneNumberId: "PNID", wabaId: "WABA", sendRatePerSecond: 20, currency: "INR", estRates: { MARKETING: 0, UTILITY: 0 },
});
const deps = (mode: "live" | "mock" = "live"): InboxDeps => ({ rpc: pgRpc(db), cfg: cfg(mode), flowSettings: async () => ({ meetingUrl: null, growthTemplate: null }), optOut: async () => {} });

let calls: { url: string; body: { to: string; type: string; template: { name: string; components: unknown[] } } }[] = [];
let respond: () => Response;

beforeAll(async () => {
  ({ db } = await createTestDb());
  // A running campaign with an audience of 3 opted-in leads.
  const seg = (await db.query<{ id: string }>("select id from segments where slug='ayushman'")).rows[0].id;
  for (const p of ["+919800000001", "+919800000002", "+919800000003"])
    await db.query("insert into leads (phone_e164, segment_id, marketing_consent) values ($1,$2,'opted_in')", [p, seg]);
  campaignId = (await db.query<{ id: string }>("insert into campaigns (name, audience_filter) values ('c', $1) returning id", [JSON.stringify({ segment_ids: [seg] })])).rows[0].id;
}, 60_000);

beforeEach(() => {
  calls = [];
  respond = () => new Response(JSON.stringify({ messages: [{ id: "wamid.TEST1" }] }), { status: 200 });
  vi.stubGlobal("fetch", vi.fn(async (url: URL | string, init?: RequestInit) => {
    calls.push({ url: String(url), body: JSON.parse(String(init?.body)) });
    return respond();
  }));
});
afterEach(() => vi.unstubAllGlobals());

const counts = async () =>
  (await db.query<{ r: number; c: string }>("select (select count(*)::int from campaign_recipients) r, (select status::text from campaigns where id=$1) c", [campaignId])).rows[0];

describe("planTestSend", () => {
  it("normalises the number and renders variables with fallbacks or the matching lead", () => {
    const a = planTestSend({ phone: "98111 22233", defaultCountry: "IN", template, mapping, media: null, lead: null });
    expect(a).toMatchObject({ ok: true, plan: { to: "+919811122233", body: "Hello Doctor, grow your hospital with us.", personalizedWith: null } });
    const b = planTestSend({
      phone: "+919811122233", defaultCountry: "IN", template, mapping, media: null,
      lead: { full_name: "Anil Kumar", organization: "City Care", city: null, state: null, country: null, email: null, phone_e164: "+919811122233", custom_fields: {} },
    });
    expect(b).toMatchObject({ ok: true, plan: { body: "Hello Anil, grow City Care with us.", personalizedWith: "Anil Kumar" } });
  });

  it("rejects invalid numbers and incomplete variable mappings", () => {
    expect(planTestSend({ phone: "12345", defaultCountry: "IN", template, mapping, media: null, lead: null })).toMatchObject({ ok: false });
    const r = planTestSend({ phone: "9811122233", defaultCountry: "IN", template, mapping: { "body.1": mapping["body.1"] }, media: null, lead: null });
    expect(r).toMatchObject({ ok: false, errors: [expect.stringContaining("Body {{2}}")] });
  });
});

describe("executeTestSend", () => {
  const plan = () => {
    const p = planTestSend({ phone: "9811122233", defaultCountry: "IN", template, mapping, media: null, lead: null });
    if (!p.ok) throw new Error("plan failed");
    return p.plan;
  };

  it("sends exactly one template message to the test number and never touches the campaign queue", async () => {
    const before = await counts();
    const r = await executeTestSend(deps(), { plan: plan(), template, clientKey: "11111111-1111-4111-8111-111111111111", userId: null });
    expect(r).toMatchObject({ result: "sent", wamid: "wamid.TEST1", duplicate: false });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://graph.facebook.com/v23.0/PNID/messages");
    expect(calls[0].body).toMatchObject({ to: "919811122233", type: "template", template: { name: "hospital_offer" } });
    expect(calls[0].body.template.components).toEqual([
      { type: "body", parameters: [{ type: "text", text: "Doctor" }, { type: "text", text: "your hospital" }] },
    ]);
    expect(await counts()).toEqual(before); // no recipients enqueued, campaign still draft
    const m = await db.query("select source, type, status, wa_message_id, direction from messages where wa_message_id='wamid.TEST1'");
    expect(m.rows[0]).toEqual({ source: "campaign_test", type: "template", status: "sent", wa_message_id: "wamid.TEST1", direction: "out" });
  });

  it("does not resend on a repeated submit (same client key)", async () => {
    const key = "22222222-2222-4222-8222-222222222222";
    await executeTestSend(deps(), { plan: plan(), template, clientKey: key, userId: null });
    const again = await executeTestSend(deps(), { plan: plan(), template, clientKey: key, userId: null });
    expect(again.duplicate).toBe(true);
    expect(calls).toHaveLength(1);
  });

  it("returns Meta's error details on failure", async () => {
    respond = () => new Response(JSON.stringify({ error: { message: "Template name does not exist in the translation", code: 132001, error_data: { details: "template name (hospital_offer) does not exist in en" } } }), { status: 404 });
    const r = await executeTestSend(deps(), { plan: plan(), template, clientKey: "33333333-3333-4333-8333-333333333333", userId: null });
    expect(r).toMatchObject({ result: "failed", errorCode: "132001", error: expect.stringContaining("does not exist") });
    const m = await db.query("select status, error_code from messages where idempotency_key = 'test:33333333-3333-4333-8333-333333333333'");
    expect(m.rows[0]).toEqual({ status: "failed", error_code: "132001" });
  });

  it("refuses in mock mode without calling Meta or recording anything", async () => {
    const n0 = (await db.query<{ n: number }>("select count(*)::int n from messages")).rows[0].n;
    await expect(executeTestSend(deps("mock"), { plan: plan(), template, clientKey: "44444444-4444-4444-8444-444444444444", userId: null })).rejects.toThrow(/WHATSAPP_MODE=live/);
    expect(calls).toHaveLength(0);
    expect((await db.query<{ n: number }>("select count(*)::int n from messages")).rows[0].n).toBe(n0);
  });
});
