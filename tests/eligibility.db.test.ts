/**
 * Shared campaign eligibility: the summary shown in the builder/review and
 * the recipients launch_campaign enqueues come from the same classifier.
 */
import { beforeAll, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { ADMIN, VIEWER, createTestDb } from "./helpers/db";

let db: PGlite;
let as: Awaited<ReturnType<typeof createTestDb>>["as"];
let hospital: string;
let ayush: string;
let delhi: string;
let vip: string;
let tpl: string;
const snap = JSON.stringify({ name: "promo", language: "en", category: "MARKETING", components: [] });

type Summary = { matching: number; invalid_phone: number; no_consent: number; opted_out: number; duplicate_phone: number; eligible: number; eligible_home: number };

async function lead(phone: string | null, seg: string, consent: string, tags: string[] = [], archived = false) {
  const r = await db.query<{ id: string }>(
    "insert into leads (phone_e164, segment_id, marketing_consent, is_archived) values ($1,$2,$3,$4) returning id",
    [phone, seg, consent, archived],
  );
  for (const t of tags) await db.query("insert into lead_tags values ($1,$2)", [r.rows[0].id, t]);
  return r.rows[0].id;
}
const summary = (filter: object, prefix: string | null = "+91") =>
  as(ADMIN, async () => (await db.query<{ s: Summary }>("select campaign_audience_summary($1, $2) s", [JSON.stringify(filter), prefix])).rows[0].s);

beforeAll(async () => {
  ({ db, as } = await createTestDb());
  const segs = await db.query<{ slug: string; id: string }>("select slug, id from segments");
  hospital = segs.rows.find((s) => s.slug === "hospital-marketing")!.id;
  ayush = segs.rows.find((s) => s.slug === "ayushman")!.id;
  delhi = (await db.query<{ id: string }>("insert into tags (name) values ('Delhi') returning id")).rows[0].id;
  vip = (await db.query<{ id: string }>("insert into tags (name) values ('VIP') returning id")).rows[0].id;
  tpl = (await db.query<{ id: string }>("insert into whatsapp_templates (name, language, category, status) values ('promo','en','MARKETING','APPROVED') returning id")).rows[0].id;

  // Hospital segment: 2 eligible (+91), 1 eligible abroad, 1 no consent, 1 opted out via suppression,
  // 1 opted out via consent, 1 no phone, 1 archived (never matches).
  await lead("+919000000001", hospital, "opted_in", [delhi, vip]);
  await lead("+919000000002", hospital, "opted_in", [delhi]);
  await lead("+971500000003", hospital, "opted_in", [vip]);
  await lead("+919000000004", hospital, "unknown", [delhi]);
  await lead("+919000000005", hospital, "opted_in");
  await db.query("insert into opt_outs (phone_e164) values ('+919000000005')");
  await lead("+919000000006", hospital, "opted_out");
  await lead(null, hospital, "opted_in", [delhi]);
  await lead("+919000000008", hospital, "opted_in", [], true);
  // Ayushman segment: 1 eligible, 1 no consent.
  await lead("+919000000009", ayush, "opted_in", [delhi]);
  await lead("+919000000010", ayush, "unknown");
}, 60_000);

describe("campaign_audience_summary", () => {
  it("breaks down a segment and counts the priced (home-country) portion", async () => {
    expect(await summary({ segment_ids: [hospital] })).toMatchObject({
      matching: 7, invalid_phone: 1, no_consent: 1, opted_out: 2, duplicate_phone: 0, eligible: 3, eligible_home: 2,
    });
  });

  it("treats no selected segment as all segments", async () => {
    expect(await summary({})).toMatchObject({ matching: 9, eligible: 4, no_consent: 2 });
  });

  it("applies tags with any/all semantics across segments", async () => {
    expect(await summary({ tag_ids: [delhi], tag_match: "any" })).toMatchObject({ matching: 5, eligible: 3, no_consent: 1, invalid_phone: 1 });
    expect(await summary({ tag_ids: [delhi, vip], tag_match: "all" })).toMatchObject({ matching: 1, eligible: 1 });
    expect(await summary({ segment_ids: [ayush], tag_ids: [delhi] })).toMatchObject({ matching: 1, eligible: 1 });
  });

  it("never assumes consent for imported leads", async () => {
    const s = await summary({ segment_ids: [ayush] });
    expect(s).toMatchObject({ matching: 2, eligible: 1, no_consent: 1 });
  });

  it("counts a duplicated phone once, preferring the opted-in copy", async () => {
    // leads.phone_e164 is unique in the schema; use an isolated DB without the
    // constraint to prove the classifier itself never double-counts a phone.
    const iso = await createTestDb();
    await iso.db.exec("alter table leads drop constraint leads_phone_e164_key");
    await iso.db.query("insert into leads (phone_e164, marketing_consent) values ('+919111111111','unknown'), ('+919111111111','opted_in'), ('+919111111111','opted_in')");
    const r = await iso.as(ADMIN, () => iso.db.query<{ s: Summary }>("select campaign_audience_summary('{}', '+91') s"));
    expect(r.rows[0].s).toMatchObject({ matching: 3, eligible: 1, duplicate_phone: 1, no_consent: 1 });
  }, 60_000);

  it("respects RLS (viewers can read counts; anonymous cannot)", async () => {
    const v = await as(VIEWER, async () => (await db.query<{ s: Summary }>("select campaign_audience_summary('{}', '+91') s")).rows[0].s);
    expect(v.eligible).toBe(4);
    await db.exec("reset role; set role anon;");
    await expect(db.query("select campaign_audience_summary('{}', '+91')")).rejects.toThrow();
    await db.exec("reset role;");
  });
});

describe("launch_campaign v2", () => {
  const campaign = async (filter: object) =>
    (await db.query<{ id: string }>("insert into campaigns (name, template_id, audience_filter) values ('c', $1, $2) returning id", [tpl, JSON.stringify(filter)])).rows[0].id;
  const launch = (id: string, n: number, rate: number | null, dry = false) =>
    as(ADMIN, () => db.query<{ n: number }>("select launch_campaign($1, $2, $3, $4, $5, '+91', 'IN') n", [id, n, dry, snap, rate]));

  it("enqueues exactly the summary's eligible recipients, prices only home-country ones", async () => {
    const filter = { segment_ids: [hospital] };
    const s = await summary(filter);
    const id = await campaign(filter);
    expect((await launch(id, s.eligible, 0.8631)).rows[0].n).toBe(3);
    const phones = await db.query<{ phone_e164: string }>("select phone_e164 from campaign_recipients where campaign_id=$1 order by 1", [id]);
    expect(phones.rows.map((r) => r.phone_e164)).toEqual(["+919000000001", "+919000000002", "+971500000003"]);
    const c = await db.query("select status, total_recipients, est_cost, est_unpriced, est_country from campaigns where id=$1", [id]);
    expect(c.rows[0]).toEqual({ status: "running", total_recipients: 3, est_cost: "1.73", est_unpriced: 1, est_country: "IN" });
  });

  it("marks everything unpriced when no rate is configured", async () => {
    const id = await campaign({ segment_ids: [ayush] });
    await launch(id, 1, 0);
    const c = await db.query("select est_cost, est_unpriced from campaigns where id=$1", [id]);
    expect(c.rows[0]).toEqual({ est_cost: "0.00", est_unpriced: 1 });
  });

  it("is idempotent: a second launch (double click / retry) fails without adding recipients", async () => {
    const id = await campaign({ segment_ids: [ayush] });
    await launch(id, 1, 0.5);
    await expect(launch(id, 1, 0.5)).rejects.toThrow(/already been launched/);
    const n = await db.query<{ n: number }>("select count(*)::int n from campaign_recipients where campaign_id=$1", [id]);
    expect(n.rows[0].n).toBe(1);
  });

  it("refuses when the audience changed since confirmation, leaving the draft untouched", async () => {
    const id = await campaign({ segment_ids: [ayush] });
    await expect(launch(id, 5, 0.5)).rejects.toThrow(/audience changed: 1 eligible now/);
    const c = await db.query<{ status: string; n: number }>("select status, (select count(*)::int from campaign_recipients where campaign_id=$1) n from campaigns where id=$1", [id]);
    expect(c.rows[0]).toEqual({ status: "draft", n: 0 });
  });
});

describe("test-send support", () => {
  it("creates or reuses a conversation for a phone and allows the campaign_test source", async () => {
    const a = (await db.query<{ id: string }>("select inbox_ensure_conversation('+919000000001') id")).rows[0].id;
    const b = (await db.query<{ id: string }>("select inbox_ensure_conversation('+919000000001') id")).rows[0].id;
    expect(a).toBe(b);
    const q = await db.query<{ r: { id: number } }>("select inbox_queue_outbound($1, 'test:1', 'template', 'Hi', '{}', 'campaign_test', null) r", [a]);
    expect(q.rows[0].r.id).toBeGreaterThan(0);
    await as(VIEWER, async () => {
      await expect(db.query("select inbox_ensure_conversation('+919000000002')")).rejects.toThrow(/permission denied/);
    });
  });
});
