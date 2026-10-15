import { beforeAll, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { ADMIN, VIEWER, createTestDb } from "./helpers/db";

let db: PGlite;
let as: Awaited<ReturnType<typeof createTestDb>>["as"];

type Rec = { conversation_id: string; lead_id: string | null; message_id: number | null; inserted: boolean; flow: unknown; flow_rev: number };

const record = async (phone: string, wamid: string, body = "hi", name: string | null = "Dr. Rao") =>
  (
    await db.query<{ r: Rec }>("select inbox_record_inbound($1, $2, 'text', $3, '{}', null, now(), $4) r", [phone, wamid, body, name])
  ).rows[0].r;

beforeAll(async () => {
  ({ db, as } = await createTestDb());
}, 60_000);

describe("inbox_record_inbound", () => {
  it("creates the conversation, links an existing lead and counts unread", async () => {
    const lead = await db.query<{ id: string }>("insert into leads (phone_e164, full_name) values ('+919810000001', 'A') returning id");
    const r = await record("+919810000001", "wamid.in1", "Hello");
    expect(r).toMatchObject({ inserted: true, lead_id: lead.rows[0].id, flow: null, flow_rev: 0 });
    const c = await db.query("select unread_count, last_message_preview, last_direction, contact_name, last_inbound_at is not null w from conversations where id=$1", [r.conversation_id]);
    expect(c.rows[0]).toEqual({ unread_count: 1, last_message_preview: "Hello", last_direction: "in", contact_name: "Dr. Rao", w: true });
  });

  it("is idempotent for duplicate message ids", async () => {
    const a = await record("+919810000002", "wamid.dup");
    const b = await record("+919810000002", "wamid.dup");
    expect(a.inserted).toBe(true);
    expect(b.inserted).toBe(false);
    const n = await db.query<{ n: number }>("select count(*)::int n from messages where wa_message_id='wamid.dup'");
    expect(n.rows[0].n).toBe(1);
    const c = await db.query<{ unread_count: number }>("select unread_count from conversations where id=$1", [a.conversation_id]);
    expect(c.rows[0].unread_count).toBe(1);
  });

  it("links conversations to leads created later", async () => {
    const r = await record("+919810000003", "wamid.late");
    expect(r.lead_id).toBeNull();
    const lead = await db.query<{ id: string }>("insert into leads (phone_e164) values ('+919810000003') returning id");
    const c = await db.query<{ lead_id: string }>("select lead_id from conversations where id=$1", [r.conversation_id]);
    expect(c.rows[0].lead_id).toBe(lead.rows[0].id);
  });
});

describe("inbox_apply_flow", () => {
  it("compare-and-sets flow state and queues replies once", async () => {
    const r = await record("+919810000004", "wamid.f1");
    const apply = (rev: number) =>
      db.query<{ r: { ok: boolean } }>("select inbox_apply_flow($1, true, $2, $3, 'wamid.f1', $4, null) r", [
        r.conversation_id,
        rev,
        JSON.stringify({ name: "send_details", step: "name" }),
        JSON.stringify([{ idempotency_key: "auto:wamid.f1:0", type: "text", body: "Q1" }]),
      ]);
    expect((await apply(0)).rows[0].r.ok).toBe(true);
    expect((await apply(0)).rows[0].r).toMatchObject({ ok: false, reason: "stale" });
    // Replaying with the right rev must not duplicate the reply.
    await apply(1);
    const n = await db.query<{ n: number }>("select count(*)::int n from messages where trigger_wa_message_id='wamid.f1'");
    expect(n.rows[0].n).toBe(1);
    const pending = await db.query<{ p: number[] }>("select inbox_pending_replies('wamid.f1') p");
    expect(pending.rows[0].p.length).toBe(1);
  });

  it("saves details: fills empty fields only, keeps a record, creates leads when needed", async () => {
    await db.query("insert into leads (phone_e164, full_name, organization, status) values ('+919810000005', 'Existing', null, 'new')");
    const r = await record("+919810000005", "wamid.d1");
    const details = JSON.stringify({ representative: "Ravi", hospital: "City Care", preferred_time: "Mon 11am" });
    await db.query("select inbox_apply_flow($1, false, 0, null, 'wamid.d1', '[]', $2)", [r.conversation_id, details]);
    const lead = await db.query<{ full_name: string; organization: string; status: string; cf: string; notes: string }>(
      "select full_name, organization, status, custom_fields->>'WhatsApp: hospital name' cf, notes from leads where phone_e164='+919810000005'",
    );
    expect(lead.rows[0]).toMatchObject({ full_name: "Existing", organization: "City Care", status: "interested", cf: "City Care" });
    expect(lead.rows[0].notes).toMatch(/preferred meeting: Mon 11am/);

    const r2 = await record("+919810000006", "wamid.d2");
    const out = await db.query<{ r: { lead: { created: boolean; lead_id: string } } }>(
      "select inbox_apply_flow($1, false, 0, null, 'wamid.d2', '[]', $2) r",
      [r2.conversation_id, details],
    );
    expect(out.rows[0].r.lead.created).toBe(true);
    const c = await db.query<{ lead_id: string }>("select lead_id from conversations where id=$1", [r2.conversation_id]);
    expect(c.rows[0].lead_id).toBe(out.rows[0].r.lead.lead_id);
  });
});

describe("outbound lifecycle", () => {
  it("queues once, claims once, finishes, and applies forward-only webhook statuses", async () => {
    const r = await record("+919810000007", "wamid.o0");
    const q = (key: string) =>
      db.query<{ r: { id: number; duplicate: boolean } }>("select inbox_queue_outbound($1, $2, 'text', 'Hi', '{}', 'inbox', null) r", [r.conversation_id, key]);
    const a = (await q("k1")).rows[0].r;
    const b = (await q("k1")).rows[0].r;
    expect(b).toEqual({ id: a.id, duplicate: true });

    const claim = () => db.query<{ r: { claimed: boolean; phone?: string } }>("select inbox_claim_outbound($1) r", [a.id]);
    expect((await claim()).rows[0].r).toMatchObject({ claimed: true, phone: "+919810000007" });
    expect((await claim()).rows[0].r.claimed).toBe(false);

    await db.query("select inbox_finish_outbound($1, 'sent', 'wamid.out7', null, null)", [a.id]);
    await db.query("select apply_message_status('wamid.out7', 'read', now())");
    await db.query("select apply_message_status('wamid.out7', 'delivered', now())");
    const ok = await db.query<{ ok: boolean }>("select apply_message_status('wamid.out7', 'failed', now(), '131026', 'x') ok");
    expect(ok.rows[0].ok).toBe(true);
    const m = await db.query("select status, delivered_at is not null d, read_at is not null rd from messages where id=$1", [a.id]);
    expect(m.rows[0]).toEqual({ status: "read", d: true, rd: true });
    const c = await db.query<{ last_direction: string; unread_count: number }>("select last_direction, unread_count from conversations where id=$1", [r.conversation_id]);
    expect(c.rows[0]).toEqual({ last_direction: "out", unread_count: 1 });
  });
});

describe("RLS and staff functions", () => {
  it("lets signed-in users read but not write; viewers can't cancel flows", async () => {
    const r = await record("+919810000008", "wamid.r1");
    await as(VIEWER, async () => {
      expect((await db.query("select * from conversations where id=$1", [r.conversation_id])).rows.length).toBe(1);
      await expect(db.query("insert into messages (conversation_id, direction, type, status, source) values ($1,'out','text','sent','inbox')", [r.conversation_id])).rejects.toThrow();
      await expect(db.query("select inbox_record_inbound('+91', 'x', 'text', '', '{}', null, now(), null)")).rejects.toThrow(/permission denied/);
      await expect(db.query("select inbox_cancel_flow($1)", [r.conversation_id])).rejects.toThrow(/not authorized/);
      await db.query("select inbox_mark_read($1)", [r.conversation_id]);
    });
    const c = await db.query<{ unread_count: number }>("select unread_count from conversations where id=$1", [r.conversation_id]);
    expect(c.rows[0].unread_count).toBe(0);
  });

  it("lets agents/admins cancel an active flow", async () => {
    const r = await record("+919810000009", "wamid.c1");
    await db.query("update conversations set flow = '{\"name\":\"send_details\",\"step\":\"hospital\"}' where id=$1", [r.conversation_id]);
    await as(ADMIN, () => db.query("select inbox_cancel_flow($1)", [r.conversation_id]));
    const c = await db.query<{ step: string; flow_rev: number }>("select flow->>'step' step, flow_rev from conversations where id=$1", [r.conversation_id]);
    expect(c.rows[0]).toEqual({ step: "cancelled", flow_rev: 1 });
  });

  it("rejects non-https meeting URLs", async () => {
    await expect(db.query("update app_settings set meeting_url = 'http://x.com'")).rejects.toThrow();
    await db.query("update app_settings set meeting_url = 'https://calendly.com/medscale/30min'");
  });
});
