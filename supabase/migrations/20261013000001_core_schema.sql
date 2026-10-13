-- =====================================================================
-- WhatsApp CRM — core schema
-- Leads, segments, tags, consent/opt-out, imports, templates, campaigns,
-- recipients (also the send queue), webhook events, audit logs.
-- =====================================================================

-- gen_random_uuid() is built into Postgres 13+.

-- ---------- Enums ----------------------------------------------------
create type public.app_role as enum ('admin', 'manager', 'agent', 'viewer');
create type public.lead_status as enum ('new', 'contacted', 'interested', 'not_interested', 'converted');
create type public.consent_status as enum ('unknown', 'opted_in', 'opted_out');
create type public.import_status as enum ('processing', 'completed', 'failed');
create type public.duplicate_strategy as enum ('skip', 'update');
create type public.template_category as enum ('MARKETING', 'UTILITY', 'AUTHENTICATION');
create type public.campaign_status as enum (
  'draft', 'queued', 'running', 'paused', 'completed', 'cancelled', 'failed'
);
-- Recipient lifecycle. 'sent' = accepted by the Cloud API (has wa_message_id) or
-- confirmed by a 'sent' webhook. delivered/read only ever set from webhooks.
-- 'dry_run' = processed in mock mode; nothing was sent to Meta.
create type public.recipient_status as enum (
  'queued', 'sending', 'sent', 'delivered', 'read', 'failed', 'cancelled', 'skipped', 'dry_run'
);

-- ---------- Helpers --------------------------------------------------
create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

-- ---------- Profiles & roles ----------------------------------------
create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  email text,
  full_name text,
  role public.app_role not null default 'viewer',
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger profiles_updated_at before update on public.profiles
  for each row execute function public.set_updated_at();

-- First user to sign up becomes admin; everyone after starts as viewer.
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, email, full_name, role)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data ->> 'full_name', split_part(new.email, '@', 1)),
    case when exists (select 1 from public.profiles) then 'viewer'::public.app_role
         else 'admin'::public.app_role end
  );
  return new;
end $$;

create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- Role of the calling user (null if no active profile).
create or replace function public.current_app_role()
returns public.app_role language sql stable security definer set search_path = public as $$
  select role from public.profiles where id = auth.uid() and is_active
$$;

create or replace function public.has_role(roles public.app_role[])
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce(public.current_app_role() = any (roles), false)
$$;

-- ---------- Segments & tags -----------------------------------------
create table public.segments (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  name text not null unique,
  description text,
  color text not null default '#64748b',
  sort_order int not null default 0,
  created_at timestamptz not null default now()
);

create table public.tags (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  color text not null default '#64748b',
  created_at timestamptz not null default now()
);
create unique index tags_name_lower_key on public.tags (lower(name));

-- ---------- Imports --------------------------------------------------
create table public.imports (
  id uuid primary key default gen_random_uuid(),
  file_name text not null,
  file_type text not null check (file_type in ('csv', 'xlsx')),
  segment_id uuid references public.segments (id) on delete set null,
  tag_ids uuid[] not null default '{}',
  duplicate_strategy public.duplicate_strategy not null default 'skip',
  default_country text not null default 'IN',
  column_mapping jsonb not null default '{}'::jsonb,
  consent_basis text,
  status public.import_status not null default 'processing',
  total_rows int not null default 0,
  inserted_count int not null default 0,
  updated_count int not null default 0,
  duplicate_count int not null default 0,
  error_count int not null default 0,
  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  completed_at timestamptz
);

create table public.import_errors (
  id bigint generated always as identity primary key,
  import_id uuid not null references public.imports (id) on delete cascade,
  row_number int not null,
  error text not null,
  raw jsonb not null default '{}'::jsonb
);
create index import_errors_import_idx on public.import_errors (import_id, row_number);

-- ---------- Leads ----------------------------------------------------
create table public.leads (
  id uuid primary key default gen_random_uuid(),
  full_name text,
  organization text,
  phone_raw text,
  phone_e164 text,
  email text,
  city text,
  state text,
  country text,
  segment_id uuid references public.segments (id) on delete set null,
  status public.lead_status not null default 'new',
  source text,
  notes text,
  custom_fields jsonb not null default '{}'::jsonb,
  -- WhatsApp marketing eligibility. Only 'opted_in' leads are eligible for
  -- marketing campaigns. 'opted_out' is also enforced via public.opt_outs.
  marketing_consent public.consent_status not null default 'unknown',
  consent_source text,
  consent_at timestamptz,
  is_archived boolean not null default false,
  archived_at timestamptz,
  import_id uuid references public.imports (id) on delete set null,
  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint leads_phone_e164_format check (phone_e164 is null or phone_e164 ~ '^\+[1-9][0-9]{6,14}$')
);
-- One lead per phone number: the basis for duplicate detection.
-- (Plain unique constraint so ON CONFLICT works; NULLs remain distinct.)
alter table public.leads add constraint leads_phone_e164_key unique (phone_e164);
create index leads_segment_idx on public.leads (segment_id) where not is_archived;
create index leads_created_idx on public.leads (created_at desc);
create index leads_consent_idx on public.leads (marketing_consent);
create index leads_search_idx on public.leads using gin (
  to_tsvector('simple',
    coalesce(full_name, '') || ' ' || coalesce(organization, '') || ' ' ||
    coalesce(email, '') || ' ' || coalesce(city, ''))
);
create trigger leads_updated_at before update on public.leads
  for each row execute function public.set_updated_at();

create table public.lead_tags (
  lead_id uuid not null references public.leads (id) on delete cascade,
  tag_id uuid not null references public.tags (id) on delete cascade,
  primary key (lead_id, tag_id)
);
create index lead_tags_tag_idx on public.lead_tags (tag_id);

-- ---------- Consent & permanent opt-out suppression ------------------
-- Keyed by phone so an opt-out survives lead deletion and re-import.
create table public.opt_outs (
  phone_e164 text primary key,
  reason text,
  source text not null default 'manual', -- manual | webhook_keyword | import
  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now()
);

create table public.consent_events (
  id bigint generated always as identity primary key,
  lead_id uuid references public.leads (id) on delete set null,
  phone_e164 text,
  status public.consent_status not null,
  source text not null,
  evidence text,
  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now()
);
create index consent_events_lead_idx on public.consent_events (lead_id, created_at desc);

-- A suppressed phone can never be (re)marked as opted in.
create or replace function public.enforce_opt_out()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.phone_e164 is not null
     and exists (select 1 from public.opt_outs o where o.phone_e164 = new.phone_e164) then
    new.marketing_consent := 'opted_out';
  end if;
  return new;
end $$;
create trigger leads_enforce_opt_out before insert or update of phone_e164, marketing_consent
  on public.leads for each row execute function public.enforce_opt_out();

-- Adding an opt-out immediately flips matching leads and cancels queued sends.
create or replace function public.apply_opt_out()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  update public.leads set marketing_consent = 'opted_out'
   where phone_e164 = new.phone_e164 and marketing_consent <> 'opted_out';
  update public.campaign_recipients
     set status = 'skipped', last_error = 'Recipient opted out'
   where phone_e164 = new.phone_e164 and status = 'queued';
  return new;
end $$;

-- ---------- App settings (non-secret Meta configuration) -------------
-- Secrets (access token, app secret, verify token) live only in server env.
create table public.app_settings (
  id int primary key default 1 check (id = 1),
  waba_id text,
  phone_number_id text,
  business_display_name text,
  graph_api_version text not null default 'v23.0',
  default_country text not null default 'IN',
  currency text not null default 'INR',
  -- Estimated per-message rates used only for cost *estimates*.
  est_rate_marketing numeric(10, 4) not null default 0,
  est_rate_utility numeric(10, 4) not null default 0,
  send_rate_per_second int not null default 20 check (send_rate_per_second between 1 and 80),
  updated_by uuid references public.profiles (id) on delete set null,
  updated_at timestamptz not null default now()
);
insert into public.app_settings (id) values (1);
create trigger app_settings_updated_at before update on public.app_settings
  for each row execute function public.set_updated_at();

-- ---------- WhatsApp templates ---------------------------------------
create table public.whatsapp_templates (
  id uuid primary key default gen_random_uuid(),
  meta_template_id text unique,
  name text not null check (name ~ '^[a-z0-9_]+$' and char_length(name) <= 512),
  language text not null,
  category public.template_category not null,
  -- Local 'DRAFT' until submitted; afterwards mirrors Meta's status verbatim
  -- (PENDING, APPROVED, REJECTED, PAUSED, DISABLED, IN_APPEAL, ...).
  status text not null default 'DRAFT',
  rejected_reason text,
  quality_score text,
  components jsonb not null default '[]'::jsonb,
  -- Sample values/media used for submission examples.
  example_data jsonb not null default '{}'::jsonb,
  last_synced_at timestamptz,
  submitted_at timestamptz,
  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (name, language)
);
create trigger whatsapp_templates_updated_at before update on public.whatsapp_templates
  for each row execute function public.set_updated_at();

-- ---------- Campaigns ------------------------------------------------
create table public.campaigns (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  template_id uuid references public.whatsapp_templates (id) on delete restrict,
  status public.campaign_status not null default 'draft',
  -- { segment_ids: uuid[], tag_ids: uuid[], tag_match: 'any'|'all' }
  audience_filter jsonb not null default '{}'::jsonb,
  -- { "body.1": {"source":"field","value":"full_name","fallback":"there"}, ... }
  variable_mapping jsonb not null default '{}'::jsonb,
  header_media jsonb,
  is_dry_run boolean not null default false,
  total_recipients int not null default 0,
  est_rate numeric(10, 4) not null default 0,
  est_cost numeric(12, 2) not null default 0,
  currency text not null default 'INR',
  confirmed_by uuid references public.profiles (id) on delete set null,
  confirmed_at timestamptz,
  started_at timestamptz,
  completed_at timestamptz,
  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index campaigns_created_idx on public.campaigns (created_at desc);
create trigger campaigns_updated_at before update on public.campaigns
  for each row execute function public.set_updated_at();

-- Recipients double as the send queue (claimed with SKIP LOCKED).
create table public.campaign_recipients (
  id bigint generated always as identity primary key,
  campaign_id uuid not null references public.campaigns (id) on delete cascade,
  lead_id uuid references public.leads (id) on delete set null,
  phone_e164 text not null,
  status public.recipient_status not null default 'queued',
  rendered_components jsonb,
  wa_message_id text unique,
  attempts int not null default 0,
  next_attempt_at timestamptz not null default now(),
  locked_at timestamptz,
  last_error_code text,
  last_error text,
  -- From webhook 'pricing' object (billable, category, pricing_model, type).
  pricing jsonb,
  sent_at timestamptz,
  delivered_at timestamptz,
  read_at timestamptz,
  failed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- Duplicate-send prevention: a phone appears at most once per campaign.
  unique (campaign_id, phone_e164)
);
create index campaign_recipients_queue_idx on public.campaign_recipients (next_attempt_at)
  where status = 'queued';
create index campaign_recipients_campaign_status_idx on public.campaign_recipients (campaign_id, status);
create trigger campaign_recipients_updated_at before update on public.campaign_recipients
  for each row execute function public.set_updated_at();

create trigger opt_outs_apply after insert on public.opt_outs
  for each row execute function public.apply_opt_out();

-- ---------- Webhooks -------------------------------------------------
create table public.webhook_events (
  id bigint generated always as identity primary key,
  -- Idempotency key, e.g. "status:<wamid>:<status>:<timestamp>".
  event_key text not null unique,
  event_type text not null,
  payload jsonb not null,
  processed_at timestamptz,
  error text,
  received_at timestamptz not null default now()
);

-- Apply a message status from a webhook. Statuses only move forward
-- (sent < delivered < read); 'failed' wins over sent/delivered but not read.
create or replace function public.apply_message_status(
  p_wa_message_id text,
  p_status text,
  p_timestamp timestamptz,
  p_error_code text default null,
  p_error text default null,
  p_pricing jsonb default null
) returns boolean language plpgsql security definer set search_path = public as $$
declare
  rank_new int := case p_status when 'sent' then 1 when 'delivered' then 2 when 'read' then 3
                                when 'failed' then 2 else 0 end;
  updated int;
begin
  if rank_new = 0 then
    return false;
  end if;

  update public.campaign_recipients r set
    status = case
      when p_status = 'failed' and r.status in ('sending', 'sent', 'delivered') then 'failed'::public.recipient_status
      when p_status <> 'failed' and rank_new > (case r.status when 'sent' then 1 when 'delivered' then 2
                                                 when 'read' then 3 when 'sending' then 0 else 99 end)
        then p_status::public.recipient_status
      else r.status end,
    sent_at = coalesce(r.sent_at, case when p_status in ('sent', 'delivered', 'read') then p_timestamp end),
    delivered_at = coalesce(r.delivered_at, case when p_status in ('delivered', 'read') then p_timestamp end),
    read_at = coalesce(r.read_at, case when p_status = 'read' then p_timestamp end),
    failed_at = case when p_status = 'failed' then coalesce(r.failed_at, p_timestamp) else r.failed_at end,
    last_error_code = case when p_status = 'failed' then p_error_code else r.last_error_code end,
    last_error = case when p_status = 'failed' then p_error else r.last_error end,
    pricing = coalesce(p_pricing, r.pricing)
  where r.wa_message_id = p_wa_message_id;

  get diagnostics updated = row_count;
  return updated > 0;
end $$;

-- Claim a batch of queued recipients from running campaigns (worker use).
create or replace function public.claim_recipients(p_limit int)
returns setof public.campaign_recipients
language plpgsql security definer set search_path = public as $$
begin
  return query
  with picked as (
    select r.id from public.campaign_recipients r
    join public.campaigns c on c.id = r.campaign_id
    where r.status = 'queued' and r.next_attempt_at <= now() and c.status = 'running'
    order by r.next_attempt_at, r.id
    limit p_limit
    for update of r skip locked
  )
  update public.campaign_recipients r
     set status = 'sending', locked_at = now(), attempts = r.attempts + 1
    from picked where r.id = picked.id
  returning r.*;
end $$;

-- Return stale 'sending' rows (worker crashed mid-send) to the queue only if
-- no wa_message_id was recorded, so a message is never sent twice.
create or replace function public.release_stale_recipients(p_older_than interval default '10 minutes')
returns int language plpgsql security definer set search_path = public as $$
declare n int;
begin
  update public.campaign_recipients
     set status = 'queued', locked_at = null
   where status = 'sending' and wa_message_id is null and locked_at < now() - p_older_than;
  get diagnostics n = row_count;
  return n;
end $$;

-- ---------- Audit log ------------------------------------------------
create table public.audit_logs (
  id bigint generated always as identity primary key,
  actor_id uuid references public.profiles (id) on delete set null,
  action text not null,
  entity_type text not null,
  entity_id text,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index audit_logs_created_idx on public.audit_logs (created_at desc);

-- ---------- Dashboard metrics (single round trip) --------------------
create or replace function public.dashboard_metrics()
returns jsonb language sql stable security invoker set search_path = public as $$
  select jsonb_build_object(
    'total_leads', (select count(*) from leads where not is_archived),
    'archived_leads', (select count(*) from leads where is_archived),
    'opted_in', (select count(*) from leads where not is_archived and marketing_consent = 'opted_in'),
    'opted_out', (select count(*) from opt_outs),
    'imports', (select count(*) from imports),
    'campaigns', (select count(*) from campaigns),
    'segments', coalesce((
      select jsonb_agg(jsonb_build_object('id', s.id, 'name', s.name, 'color', s.color, 'count', s.cnt) order by s.sort_order)
      from (select sg.id, sg.name, sg.color, sg.sort_order,
                   (select count(*) from leads l where l.segment_id = sg.id and not l.is_archived) cnt
            from segments sg) s), '[]'::jsonb),
    'messages', (
      select jsonb_build_object(
        'sent', count(*) filter (where status in ('sent', 'delivered', 'read')),
        'delivered', count(*) filter (where status in ('delivered', 'read')),
        'read', count(*) filter (where status = 'read'),
        'failed', count(*) filter (where status = 'failed'),
        'pending', count(*) filter (where status in ('queued', 'sending')))
      from campaign_recipients),
    'est_cost', (select coalesce(sum(est_cost), 0) from campaigns where not is_dry_run
                 and status in ('queued', 'running', 'paused', 'completed', 'cancelled'))
  )
$$;
