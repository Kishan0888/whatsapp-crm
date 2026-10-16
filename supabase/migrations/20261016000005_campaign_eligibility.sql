-- =====================================================================
-- Campaign eligibility: one classifier shared by the builder's count,
-- the review screen and launch_campaign, so the displayed number and the
-- recipients actually enqueued can never disagree.
--
-- Consent: recorded opt-in is required for every business-initiated
-- template (Marketing and Utility), per WhatsApp's Business Messaging
-- Policy. Imported leads are never assumed to have consented.
-- =====================================================================

-- Every lead matching the filter, with exactly one reason:
--   invalid_phone   no phone, or not a valid E.164 number
--   opted_out       on the permanent suppression list or consent = opted_out
--   no_consent      no recorded WhatsApp opt-in
--   duplicate_phone another matching lead has the same phone (kept once)
--   eligible        will be enqueued
create or replace function public.audience_classify(p_filter jsonb)
returns table (lead_id uuid, phone_e164 text, reason text)
language sql stable set search_path = public as $$
  with a as (
    select * from public.audience_leads(p_filter)
  ), ranked as (
    select a.*,
           row_number() over (partition by a.phone_e164
                              order by (a.marketing_consent = 'opted_in' and not a.suppressed) desc, a.lead_id) as rn
    from a
  )
  select r.lead_id, r.phone_e164,
         case
           when r.phone_e164 is null or r.phone_e164 !~ '^\+[1-9][0-9]{6,14}$' then 'invalid_phone'
           when r.suppressed or r.marketing_consent = 'opted_out' then 'opted_out'
           when r.marketing_consent <> 'opted_in' then 'no_consent'
           when r.rn > 1 then 'duplicate_phone'
           else 'eligible'
         end
  from ranked r
$$;

-- Breakdown for the builder/review screens (RLS applies: invoker).
-- p_home_prefix: calling-code prefix of the country the configured rates
-- apply to (e.g. '+91'); eligible_home counts recipients that can be priced.
create or replace function public.campaign_audience_summary(p_filter jsonb, p_home_prefix text default null)
returns jsonb language sql stable set search_path = public as $$
  select jsonb_build_object(
    'matching', count(*),
    'invalid_phone', count(*) filter (where reason = 'invalid_phone'),
    'no_consent', count(*) filter (where reason = 'no_consent'),
    'opted_out', count(*) filter (where reason = 'opted_out'),
    'duplicate_phone', count(*) filter (where reason = 'duplicate_phone'),
    'eligible', count(*) filter (where reason = 'eligible'),
    'eligible_home', count(*) filter (where reason = 'eligible' and p_home_prefix is not null
                                      and phone_e164 like p_home_prefix || '%'),
    'computed_at', now()
  )
  from public.audience_classify(p_filter)
$$;

-- Back-compat wrapper (same keys as before), now on the shared classifier.
create or replace function public.audience_counts(p_filter jsonb)
returns jsonb language sql stable set search_path = public as $$
  select jsonb_build_object(
    'matching', s -> 'matching', 'eligible', s -> 'eligible', 'no_phone', s -> 'invalid_phone',
    'opted_out', s -> 'opted_out', 'no_consent', s -> 'no_consent')
  from (select public.campaign_audience_summary(p_filter) s) x
$$;

alter table public.campaigns
  add column est_unpriced int not null default 0,   -- recipients with no configured rate (other country / rate unset)
  add column est_country text;                      -- country the estimate's rate applies to

-- ---------- Launch v2 (atomic, idempotent) ----------------------------
drop function if exists public.launch_campaign(uuid, int, boolean, jsonb, numeric);
create or replace function public.launch_campaign(
  p_campaign_id uuid,
  p_expected_count int,
  p_dry_run boolean,
  p_template_snapshot jsonb,
  p_est_rate numeric,
  p_home_prefix text default null,
  p_est_country text default null
) returns int language plpgsql security definer set search_path = public as $$
declare
  c public.campaigns%rowtype;
  n int;
  n_home int;
begin
  if not public.has_role(array['admin', 'manager']::public.app_role[]) then
    raise exception 'not authorized';
  end if;
  select * into c from public.campaigns where id = p_campaign_id for update;
  if not found then raise exception 'campaign not found'; end if;
  if c.status <> 'draft' then raise exception 'campaign has already been launched (status: %)', c.status; end if;
  if c.template_id is null then raise exception 'campaign has no template'; end if;

  insert into public.campaign_recipients (campaign_id, lead_id, phone_e164)
  select p_campaign_id, a.lead_id, a.phone_e164
  from public.audience_classify(c.audience_filter) a
  where a.reason = 'eligible'
  on conflict (campaign_id, phone_e164) do nothing;
  get diagnostics n = row_count;

  if n = 0 then raise exception 'no eligible recipients'; end if;
  if n <> p_expected_count then
    raise exception 'audience changed: % eligible now, but % were confirmed. Review and confirm again.', n, p_expected_count;
  end if;

  -- Recipients the rate applies to (all of them when no country prefix is given).
  select count(*) into n_home from public.campaign_recipients
   where campaign_id = p_campaign_id and (p_home_prefix is null or phone_e164 like p_home_prefix || '%');
  if coalesce(p_est_rate, 0) <= 0 then n_home := 0; end if;

  update public.campaigns set
    status = 'running',
    is_dry_run = p_dry_run,
    template_snapshot = p_template_snapshot,
    total_recipients = n,
    est_rate = coalesce(p_est_rate, 0),
    est_cost = case when p_dry_run then 0 else round(n_home * coalesce(p_est_rate, 0), 2) end,
    est_unpriced = case when p_dry_run then 0 else n - n_home end,
    est_country = p_est_country,
    confirmed_by = auth.uid(),
    confirmed_at = now(),
    started_at = now(),
    last_error = null
  where id = p_campaign_id;

  insert into public.audit_logs (actor_id, action, entity_type, entity_id, details)
  values (auth.uid(), case when p_dry_run then 'campaign.launch_dry_run' else 'campaign.launch' end, 'campaign',
          p_campaign_id::text, jsonb_build_object('recipients', n, 'est_rate', p_est_rate, 'priced', n_home));
  return n;
end $$;

-- ---------- Test sends --------------------------------------------------
alter table public.messages drop constraint messages_source_check;
alter table public.messages add constraint messages_source_check
  check (source in ('inbound', 'inbox', 'automation', 'campaign_test'));

-- Conversation for an arbitrary phone (used to record test sends in the inbox).
create or replace function public.inbox_ensure_conversation(p_phone text)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  insert into public.conversations (phone_e164, lead_id)
  values (p_phone, (select id from public.leads where phone_e164 = p_phone))
  on conflict (phone_e164) do nothing;
  select id into v_id from public.conversations where phone_e164 = p_phone;
  return v_id;
end $$;

grant execute on function public.audience_classify(jsonb) to authenticated;
grant execute on function public.campaign_audience_summary(jsonb, text) to authenticated;
grant execute on function public.launch_campaign(uuid, int, boolean, jsonb, numeric, text, text) to authenticated;
revoke execute on function public.inbox_ensure_conversation(text) from public, anon, authenticated;
grant execute on function public.inbox_ensure_conversation(text) to service_role;
