import { beforeAll, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { ADMIN, VIEWER, createTestDb } from "./helpers/db";

let db: PGlite;
let as: Awaited<ReturnType<typeof createTestDb>>["as"];
let gic: string;
let hospital: string;
let delhi: string;
let vip: string;
let templateId: string;

const snapshot = JSON.stringify({ name: "promo", language: "en", category: "MARKETING", components: [] });

async function lead(phone: string | null, segment: string, consent: string, tags: string[] = [], archived = false) {
  const r = await db.query<{ id: string }>(
    "insert into leads (phone_e164, segment_id, marketing_consent, is_archived) values ($1, $2, $3, $4) returning id",
    [phone, segment, consent, archived],
  );
  for (const t of tags) await db.query("insert into lead_tags (lead_id, tag_id) values ($1, $2)", [r.rows[0].id, t]);
  return r.rows[0].id;
}

async function campaign(filter: object) {
  const r = await db.query<{ id: string }>(
    "insert into campaigns (name, template_id, audience_filter) values ('c', $1, $2) returning id",
    [templateId, JSON.stringify(filter)],
  );
  return r.rows[0].id;
}

beforeAll(async () => {
  ({ db, as } = await createTestDb());
  const seg = await db.query<{ slug: string; id: string }>("select slug, id from segments");
  gic = seg.rows.find((s) => s.slug === "gic")!.id;
  hospital = seg.rows.find((s) => s.slug === "hospital-marketing")!.id;
  delhi = (await db.query<{ id: string }>("insert into tags (name) values ('Delhi') returning id")).rows[0].id;
  vip = (await db.query<{ id: string }>("insert into tags (name) values ('VIP') returning id")).rows[0].id;
  templateId = (
    await db.query<{ id: string }>(
      "insert into whatsapp_templates (name, language, category, status) values ('promo', 'en', 'MARKETING', 'APPROVED') returning id",
    )
  ).rows[0].id;

  await lead("+919000000001", gic, "opted_in", [delhi, vip]);
  await lead("+919000000002", gic, "opted_in", [delhi]);
  await lead("+919000000003", gic, "unknown", [delhi]);
  await lead("+919000000004", gic, "opted_in", [], true); // archived
  await lead(null, gic, "opted_in");
  await lead("+919000000005", hospital, "opted_in", [vip]);
  await lead("+919000000006", gic, "opted_in");
  await db.query("insert into opt_outs (phone_e164) values ('+919000000006')");
}, 60_000);

describe("audience_counts", () => {
  it("counts eligibility by segment", async () => {
    const r = await as(ADMIN, () => db.query<{ c: object }>("select audience_counts($1) c", [JSON.stringify({ segment_ids: [gic] })]));
    expect(r.rows[0].c).toEqual({ matching: 5, eligible: 2, no_phone: 1, opted_out: 1, no_consent: 1 });
  });

  it("supports tag any/all", async () => {
    const any = await as(ADMIN, () =>
      db.query<{ c: { eligible: number } }>("select audience_counts($1) c", [JSON.stringify({ tag_ids: [delhi, vip], tag_match: "any" })]),
    );
    const all = await as(ADMIN, () =>
      db.query<{ c: { eligible: number } }>("select audience_counts($1) c", [JSON.stringify({ tag_ids: [delhi, vip], tag_match: "all" })]),
    );
    expect(any.rows[0].c.eligible).toBe(3);
    expect(all.rows[0].c.eligible).toBe(1);
  });
});

describe("launch_campaign", () => {
  it("rejects a mismatched confirmation and rolls back", async () => {
    const id = await campaign({ segment_ids: [gic] });
    await expect(
      as(ADMIN, () => db.query("select launch_campaign($1, 99, false, $2, 0.8)", [id, snapshot])),
    ).rejects.toThrow(/audience changed/);
    const n = await db.query<{ n: number }>("select count(*)::int n from campaign_recipients where campaign_id = $1", [id]);
    expect(n.rows[0].n).toBe(0);
  });

  it("materialises only eligible recipients, sets cost, and can't launch twice", async () => {
    const id = await campaign({ segment_ids: [gic] });
    const r = await as(ADMIN, () => db.query<{ n: number }>("select launch_campaign($1, 2, false, $2, 0.8) n", [id, snapshot]));
    expect(r.rows[0].n).toBe(2);
    const c = await db.query<{ status: string; est_cost: string; total_recipients: number }>(
      "select status, est_cost, total_recipients from campaigns where id = $1",
      [id],
    );
    expect(c.rows[0]).toEqual({ status: "running", est_cost: "1.60", total_recipients: 2 });
    await expect(as(ADMIN, () => db.query("select launch_campaign($1, 2, false, $2, 0.8)", [id, snapshot]))).rejects.toThrow(
      /already been launched/,
    );
  });

  it("refuses viewers", async () => {
    const id = await campaign({ segment_ids: [gic] });
    await expect(as(VIEWER, () => db.query("select launch_campaign($1, 2, false, $2, 0)", [id, snapshot]))).rejects.toThrow(
      /not authorized/,
    );
  });
});

describe("campaign_control", () => {
  it("pauses, resumes, cancels unsent and requeues only safe failures", async () => {
    const id = await campaign({ segment_ids: [gic] });
    await as(ADMIN, () => db.query("select launch_campaign($1, 2, true, $2, 0)", [id, snapshot]));
    const ctl = (a: string) => as(ADMIN, () => db.query<{ s: string }>("select campaign_control($1, $2) s", [id, a]));

    expect((await ctl("pause")).rows[0].s).toBe("paused");
    await expect(ctl("pause")).rejects.toThrow(/cannot pause/);
    expect((await ctl("resume")).rows[0].s).toBe("running");

    // One accepted-then-failed (has wamid) and one API-rejected retryable failure.
    const rows = await db.query<{ id: number }>("select id from campaign_recipients where campaign_id = $1 order by id", [id]);
    await db.query(
      "update campaign_recipients set status='failed', wa_message_id='wamid.x', last_error_code='130429' where id=$1",
      [rows.rows[0].id],
    );
    await db.query("update campaign_recipients set status='failed', last_error_code='130429' where id=$1", [rows.rows[1].id]);
    await ctl("retry_failed");
    const after = await db.query<{ status: string }>("select status from campaign_recipients where campaign_id=$1 order by id", [id]);
    expect(after.rows.map((r) => r.status)).toEqual(["failed", "queued"]);

    expect((await ctl("cancel")).rows[0].s).toBe("cancelled");
    const final = await db.query<{ status: string }>("select status from campaign_recipients where campaign_id=$1 order by id", [id]);
    expect(final.rows.map((r) => r.status)).toEqual(["failed", "cancelled"]);
  });
});

describe("worker helpers", () => {
  it("marks stale in-flight sends as interrupted instead of re-queuing", async () => {
    const id = await campaign({});
    await db.query("update campaigns set status='running' where id=$1", [id]);
    await db.query(
      "insert into campaign_recipients (campaign_id, phone_e164, status, locked_at) values ($1, '+919111111111', 'sending', now() - interval '1 hour')",
      [id],
    );
    const n = await db.query<{ n: number }>("select release_stale_recipients() n");
    expect(n.rows[0].n).toBe(1);
    const r = await db.query<{ status: string; last_error_code: string }>(
      "select status, last_error_code from campaign_recipients where campaign_id=$1",
      [id],
    );
    expect(r.rows[0]).toEqual({ status: "failed", last_error_code: "interrupted" });
    await db.query("select complete_finished_campaigns()");
    const c = await db.query<{ status: string }>("select status from campaigns where id=$1", [id]);
    expect(c.rows[0].status).toBe("completed");
  });

  it("reports evidence-based stats", async () => {
    const id = await campaign({});
    await db.query(
      `insert into campaign_recipients (campaign_id, phone_e164, status, wa_message_id, delivered_at, read_at, pricing) values
       ($1, '+911', 'read', 'w1', now(), now(), '{"type":"regular","category":"marketing"}'),
       ($1, '+912', 'sent', 'w2', null, null, null),
       ($1, '+913', 'failed', null, null, null, null)`,
      [id],
    );
    const r = await as(ADMIN, () =>
      db.query<Record<string, string>>("select submitted, delivered, read, failed, paid from campaign_stats(array[$1]::uuid[])", [id]),
    );
    expect(r.rows[0]).toEqual({ submitted: 2, delivered: 1, read: 1, failed: 1, paid: 1 });
  });
});
