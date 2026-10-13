# Project status — WhatsApp CRM

_Last updated: 2026-10-13_

All planned modules are implemented. What remains is configuration against your real Supabase project and Meta app, and a live end-to-end test (see "Not yet verified").

## Completed

**Foundation** — Next.js 16 (App Router, Cache Components/PPR), TypeScript, Tailwind v4, shadcn/ui, Supabase SSR auth, `src/proxy.ts`, roles admin/manager/agent/viewer, server-side permission checks on every page/action, RLS on every table.

**Database** (`supabase/migrations/`, 3 files)
- Leads, segments (6 seeded), tags, imports + row errors, consent events, permanent opt-out suppression, settings, templates, campaigns, recipients (= send queue), webhook events, audit log, Meta cost reports.
- `launch_campaign` — atomic: materialises only opted-in, non-suppressed recipients and refuses if the count differs from what the user confirmed.
- `campaign_control` — pause / resume / cancel unsent / retry failed (only rows Meta never accepted, with retryable codes).
- `claim_recipients` (SKIP LOCKED), `release_stale_recipients` (marks interrupted sends failed instead of re-sending), `complete_finished_campaigns`.
- `apply_message_status` — forward-only, idempotent webhook statuses; `campaign_stats` — counts only from Meta message ids and webhook timestamps.

**Leads & import** — search/filter/bulk edit/archive/export, consent with evidence, CSV/XLSX import with mapping, segments + tags, phone normalisation, duplicate handling, history and error-report CSV.

**WhatsApp library** (`src/lib/whatsapp/`) — Graph client with typed errors; template create/edit/get/list/delete; Resumable Upload for media header samples; send template message; pricing analytics; error classification from Meta's error-code reference (retry / opt-out / pause campaign / permanent).

**Webhook** (`/api/webhooks/whatsapp`) — verification handshake, `X-Hub-Signature-256` HMAC validation (timing-safe), idempotent storage by event key, statuses → recipients, template status/rejection reasons → templates, STOP / "Stop promotions" replies and error 131050 → permanent opt-out, retry of events that arrive before the message id is recorded.

**Template manager** — editor (Marketing/Utility, 14 languages, text/image/video/document header, body with variables + samples, footer, quick-reply/URL/phone buttons) with Meta's limits validated live and a WhatsApp-style preview; drafts; submit/edit/delete via Meta; status read back from Meta after every submission; Sync pulls all WABA templates. Approval is never assumed.

**Campaigns** — builder (approved templates only, segments, tags any/all, live eligibility breakdown, variable mapping to lead fields/imported columns/fixed text with fallbacks, media header link, real-lead preview, cost estimate); review page; launch dialog requiring the typed recipient count and an authorisation checkbox; live mode re-checks the template with Meta before launch; mock mode runs a labelled dry run that never calls Meta.

**Background sender** — `/api/worker/send` (Bearer `WORKER_SECRET`/`CRON_SECRET`), `vercel.json` cron (every minute), `npm run worker` loop for VPS. Throttled to the configured messages/second, re-checks consent at send time, retries with backoff, auto-pauses on account/template errors, never re-sends a message Meta may have accepted.

**Analytics** — per-campaign stats, rates, failure reasons, recipient table with filters, recipient CSV export, auto-refresh while sending; analytics page with funnel and campaign history; CRM estimates shown separately from Meta-reported charges (pricing_analytics, labelled approximate per Meta); audit log viewer.

## Checks
- `npm run typecheck` ✅  `npm run lint` ✅  `npm run test` ✅ — 56 tests: migrations executed in PGlite (RLS, import, opt-out, audience counts, atomic launch, controls, stale handling, stats, status transitions), template validation/build/round-trip, send payloads (positional, named, media, URL button), error classification, webhook signature + parsing.
- `next build` ✅ (26 routes). Production smoke test ✅: login redirect, webhook verify (200/403), bad/missing signature (401), valid signature (200), worker auth (401).

## Not yet verified (needs your credentials)
- UI flows against a live Supabase project.
- Real Meta calls: template submission/sync, media sample upload, sending, webhook deliveries from Meta, pricing analytics. These are implemented against Meta's current docs but have not been exercised against the live API.

## Suggested next steps
1. Configure Supabase + Meta (README), sync templates, run a **dry run** campaign.
2. Switch to `WHATSAPP_MODE=live` and send a campaign to a 2–3 person test segment of your own numbers; confirm delivered/read appear via webhooks.
3. Optional: generate Supabase types (`npx supabase gen types typescript`) to replace `src/lib/types.ts`; add a shared inbox if you want to reply to inbound messages.
