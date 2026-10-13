# WhatsApp CRM

Internal CRM for lead management and official WhatsApp Cloud API campaigns. Next.js 16 · Supabase · Tailwind · shadcn/ui.

## 1. Supabase

1. Create a Supabase project. In **Authentication → Providers → Email**, turn off public sign-ups (an admin invites users).
2. Apply the migrations in `supabase/migrations/` (in order), either with the CLI:
   ```bash
   npx supabase link --project-ref <ref>
   npx supabase db push
   ```
   or by pasting each file into the SQL editor.
3. Create the first user in **Authentication → Users → Add user** (with a password). The first user becomes **admin** automatically.

## 2. App

```bash
cp .env.example .env.local   # fill in Supabase URL, anon key, service-role key
npm install
npm run dev                  # http://localhost:3000
```
Keep `WHATSAPP_MODE=mock` until Meta is configured. In mock mode nothing is submitted to or sent through Meta; launching a campaign runs a dry run.

## 3. Meta WhatsApp Cloud API

1. In [Meta for Developers](https://developers.facebook.com/), create a Business app with the WhatsApp product and connect your WhatsApp Business Account and phone number.
2. Create a **System User** in Business Settings with a permanent token that has `whatsapp_business_messaging` and `whatsapp_business_management`. Put it in `WHATSAPP_ACCESS_TOKEN`.
3. Set `WHATSAPP_APP_SECRET` (App settings → Basic), `WHATSAPP_APP_ID`, and a random `WHATSAPP_WEBHOOK_VERIFY_TOKEN`.
4. In the CRM, open **Settings → WhatsApp** and enter your **WABA ID** and **Phone number ID** (WhatsApp Manager → API setup). Enter estimated per-message rates from Meta's current rate card if you want cost estimates.
5. Deploy over HTTPS, then in the Meta app → WhatsApp → **Configuration** set the callback URL to `https://<your-domain>/api/webhooks/whatsapp` with your verify token, and subscribe to **messages** and **message_template_status_update**.
6. In **Templates**, click **Sync from Meta**. When ready to send for real, set `WHATSAPP_MODE=live`.

## 4. Background sender

Campaign messages are sent by `/api/worker/send`, which needs to be called regularly with `Authorization: Bearer <WORKER_SECRET>`:
- **Vercel:** `vercel.json` schedules it every minute (needs a plan with per-minute crons). Set `CRON_SECRET` (16+ characters).
- **VPS / Docker:** run `APP_URL=https://<domain> WORKER_SECRET=... npm run worker` alongside the app.
- **Supabase:** a `pg_cron` + `pg_net` job that POSTs to the endpoint every minute also works.
- In development, use **Process now** on a running campaign.

## Safety
- WhatsApp secrets live only in server environment variables.
- Only APPROVED templates (re-checked with Meta at launch in live mode) can be sent.
- Only opted-in, non-suppressed leads are eligible; consent is re-checked at send time. Opt-outs (manual, STOP replies, error 131050) are permanent.
- Launch requires typing the exact recipient count. Each phone appears at most once per campaign, and a message Meta may have accepted is never re-sent automatically.
- Delivered/read figures come only from Meta webhooks. Cost estimates are shown separately from Meta-reported charges.

## Scripts
- `npm run check` — typecheck + lint + tests (tests run the real migrations in an in-process Postgres)
- `npm run build` / `npm start` / `npm run worker`

See `PROJECT_STATUS.md` for status.
