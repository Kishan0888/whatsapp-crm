/**
 * Runs the real migrations in PGlite and exercises RLS, the import RPC,
 * opt-out suppression and webhook status transitions.
 */
import { beforeAll, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { ADMIN, VIEWER, createTestDb } from "./helpers/db";

let db: PGlite;
let as: Awaited<ReturnType<typeof createTestDb>>["as"];

beforeAll(async () => {
  ({ db, as } = await createTestDb());
}, 60_000);

describe("schema", () => {
  it("seeds the six segments", async () => {
    const r = await db.query<{ n: number }>("select count(*)::int n from segments");
    expect(r.rows[0].n).toBe(6);
  });

  it("makes the first user admin and later users viewer", async () => {
    const r = await db.query<{ id: string; role: string }>("select id, role from profiles order by email");
    expect(r.rows).toEqual([
      { id: ADMIN, role: "admin" },
      { id: VIEWER, role: "viewer" },
    ]);
  });
});

describe("RLS", () => {
  it("blocks anonymous reads", async () => {
    await db.exec("reset role; set role anon;");
    await expect(db.query("select * from leads")).rejects.toThrow();
    await db.exec("reset role;");
  });

  it("lets viewers read but not write leads", async () => {
    await as(VIEWER, async () => {
      const r = await db.query("select * from segments");
      expect(r.rows.length).toBe(6);
      await expect(db.query("insert into leads (full_name) values ('x')")).rejects.toThrow(/row-level security/);
    });
  });

  it("hides webhook events from signed-in users", async () => {
    await db.query("insert into webhook_events (event_key, event_type, payload) values ('k1','status','{}')");
    await as(ADMIN, async () => {
      const r = await db.query("select * from webhook_events");
      expect(r.rows.length).toBe(0);
    });
  });
});

describe("import_leads_batch", () => {
  let segmentId: string;
  let tagId: string;

  beforeAll(async () => {
    segmentId = (await db.query<{ id: string }>("select id from segments where slug='gic'")).rows[0].id;
    tagId = (await db.query<{ id: string }>("insert into tags (name) values ('Delhi') returning id")).rows[0].id;
  });

  async function newImport(strategy: "skip" | "update") {
    return as(ADMIN, async () => {
      const r = await db.query<{ id: string }>(
        `insert into imports (file_name, file_type, segment_id, tag_ids, duplicate_strategy, consent_basis)
         values ('leads.csv', 'csv', $1, $2, $3, 'Website form opt-in') returning id`,
        [segmentId, [tagId], strategy],
      );
      return r.rows[0].id;
    });
  }

  it("inserts rows, tags them and records duplicates on skip", async () => {
    const importId = await newImport("skip");
    const rows = [
      { row_number: 2, full_name: "A", phone_raw: "98100 00001", phone_e164: "+919810000001", consent: "opted_in" },
      { row_number: 3, full_name: "B", phone_raw: "9810000002", phone_e164: "+919810000002" },
    ];
    const first = await as(ADMIN, () =>
      db.query<{ r: { inserted: number } }>("select import_leads_batch($1, $2) r", [importId, JSON.stringify(rows)]),
    );
    expect(first.rows[0].r).toEqual({ inserted: 2, updated: 0, duplicates: 0 });

    const importId2 = await newImport("skip");
    const second = await as(ADMIN, () =>
      db.query<{ r: object }>("select import_leads_batch($1, $2) r", [importId2, JSON.stringify(rows.slice(0, 1))]),
    );
    expect(second.rows[0].r).toEqual({ inserted: 0, updated: 0, duplicates: 1 });

    const errs = await db.query("select * from import_errors where import_id = $1", [importId2]);
    expect(errs.rows.length).toBe(1);

    const lead = await db.query<{ marketing_consent: string; segment_id: string; tags: number }>(
      `select marketing_consent, segment_id, (select count(*)::int from lead_tags t where t.lead_id = l.id) tags
       from leads l where phone_e164 = '+919810000001'`,
    );
    expect(lead.rows[0]).toEqual({ marketing_consent: "opted_in", segment_id: segmentId, tags: 1 });
  });

  it("updates existing leads on update strategy without wiping fields", async () => {
    const importId = await newImport("update");
    const rows = [{ row_number: 2, phone_e164: "+919810000002", city: "Jaipur" }];
    const r = await as(ADMIN, () =>
      db.query<{ r: object }>("select import_leads_batch($1, $2) r", [importId, JSON.stringify(rows)]),
    );
    expect(r.rows[0].r).toEqual({ inserted: 0, updated: 1, duplicates: 1 });
    const lead = await db.query("select full_name, city from leads where phone_e164='+919810000002'");
    expect(lead.rows[0]).toEqual({ full_name: "B", city: "Jaipur" });
  });

  it("refuses viewers", async () => {
    const importId = await newImport("skip");
    await expect(as(VIEWER, () => db.query("select import_leads_batch($1, '[]')", [importId]))).rejects.toThrow(
      /not authorized/,
    );
  });
});

describe("opt-out suppression", () => {
  it("is permanent and cannot be overridden by setting consent", async () => {
    await db.query("insert into opt_outs (phone_e164, reason) values ('+919810000001', 'STOP')");
    await db.query("update leads set marketing_consent = 'opted_in' where phone_e164 = '+919810000001'");
    const r = await db.query<{ marketing_consent: string }>(
      "select marketing_consent from leads where phone_e164 = '+919810000001'",
    );
    expect(r.rows[0].marketing_consent).toBe("opted_out");
  });
});

describe("apply_message_status", () => {
  it("only moves forward and is idempotent", async () => {
    const c = await db.query<{ id: string }>("insert into campaigns (name, status) values ('t', 'running') returning id");
    await db.query(
      "insert into campaign_recipients (campaign_id, phone_e164, status, wa_message_id) values ($1, '+919810000009', 'sent', 'wamid.1')",
      [c.rows[0].id],
    );
    const apply = (s: string) => db.query("select apply_message_status('wamid.1', $1, now())", [s]);
    await apply("read");
    await apply("delivered"); // late, out of order
    await apply("failed"); // must not override read
    await apply("read"); // replay
    const r = await db.query<{ status: string; delivered: boolean; read: boolean }>(
      "select status, delivered_at is not null delivered, read_at is not null read from campaign_recipients where wa_message_id='wamid.1'",
    );
    expect(r.rows[0]).toEqual({ status: "read", delivered: true, read: true });
  });

  it("returns false for unknown message ids", async () => {
    const r = await db.query<{ ok: boolean }>("select apply_message_status('wamid.nope', 'sent', now()) ok");
    expect(r.rows[0].ok).toBe(false);
  });
});

describe("claim_recipients", () => {
  it("claims only queued rows of running campaigns, once", async () => {
    const running = await db.query<{ id: string }>("insert into campaigns (name, status) values ('r', 'running') returning id");
    const paused = await db.query<{ id: string }>("insert into campaigns (name, status) values ('p', 'paused') returning id");
    await db.query(
      "insert into campaign_recipients (campaign_id, phone_e164) values ($1, '+911111111111'), ($2, '+912222222222')",
      [running.rows[0].id, paused.rows[0].id],
    );
    const a = await db.query<{ phone_e164: string }>("select phone_e164 from claim_recipients(10)");
    const b = await db.query("select * from claim_recipients(10)");
    expect(a.rows.map((x) => x.phone_e164)).toEqual(["+911111111111"]);
    expect(b.rows.length).toBe(0);
  });
});

describe("dashboard_metrics", () => {
  it("returns real counts", async () => {
    const r = await as(ADMIN, () => db.query<{ m: { total_leads: number; segments: unknown[] } }>("select dashboard_metrics() m"));
    expect(r.rows[0].m.total_leads).toBe(2);
    expect(r.rows[0].m.segments.length).toBe(6);
  });
});
