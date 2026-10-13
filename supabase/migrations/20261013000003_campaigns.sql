-- =====================================================================
-- Campaign engine: audience selection, atomic launch, controls, stats,
-- crash-safe queue handling, Meta-reported cost reports.
-- =====================================================================

alter table public.campaign_recipients
  add column accepted_at timestamptz; -- Cloud API accepted the request (has wa_message_id)

alter table public.campaigns
  add column last_error text,
  add column template_snapshot jsonb; -- name/language/category/components frozen at launch

alter table public.webhook_events
  add column attempts int not null default 0;
create index webhook_events_pending_idx on public.webhook_events (received_at)
  where processed_at is null;

create index campaign_recipients_lead_idx on public.campaign_recipients (lead_id);

-- Codes that are safe to retry (from Meta's error-code reference) plus
-- transport failures. Shared by the worker (TS) and requeue below.
create or replace function public.retryable_error_codes()
returns text[] language sql immutable as $$
  select array['4', '80007', '130429', '131000', '131016', '131056', '131049', 'network', 'http_5xx']
$$;

-- ---------- Audience -------------------------------------------------
-- Filter: { segment_ids: uuid[], tag_ids: uuid[], tag_match: 'any'|'all' }
-- Empty segment_ids / tag_ids means "no restriction" on that dimension.
create or replace function public.audience_leads(p_filter jsonb)
returns table (lead_id uuid, phone_e164 text, marketing_consent public.consent_status, suppressed boolean)
language sql stable set search_path = public as $$
  with f as (
    select array(select jsonb_array_elements_text(coalesce(p_filter -> 'segment_ids', '[]'::jsonb)))::uuid[] as seg,
           array(select jsonb_array_elements_text(coalesce(p_filter -> 'tag_ids', '[]'::jsonb)))::uuid[] as tags,
           coalesce(p_filter ->> 'tag_match', 'any') as tm
  )
  select l.id, l.phone_e164, l.marketing_consent,
         (l.phone_e164 is not null and exists (select 1 from opt_outs o where o.phone_e164 = l.phone_e164))
  from leads l, f
  where not l.is_archived
    and (cardinality(f.seg) = 0 or l.segment_id = any (f.seg))
    and (
      cardinality(f.tags) = 0
      or (f.tm = 'all' and (select count(distinct lt.tag_id) from lead_tags lt
                            where lt.lead_id = l.id and lt.tag_id = any (f.tags)) = cardinality(f.tags))
      or (f.tm <> 'all' and exists (select 1 from lead_tags lt where lt.lead_id = l.id and lt.tag_id = any (f.tags)))
    )
$$;

-- Counts for the campaign builder preview (RLS applies: invoker).
create or replace function public.audience_counts(p_filter jsonb)
returns jsonb language sql stable set search_path = public as $$
  select jsonb_build_object(
    'matching', count(*),
    'eligible', count(*) filter (where phone_e164 is not null and marketing_consent = 'opted_in' and not suppressed),
    'no_phone', count(*) filter (where phone_e164 is null),
    'opted_out', count(*) filter (where phone_e164 is not null and (marketing_consent = 'opted_out' or suppressed)),
    'no_consent', count(*) filter (where phone_e164 is not null and marketing_consent = 'unknown' and not suppressed)
  )
  from public.audience_leads(p_filter)
$$;

-- ---------- Launch (atomic) ------------------------------------------
-- Materialises eligible recipients and starts the campaign. Fails (and
-- rolls back) if the eligible count differs from what the user confirmed.
create or replace function public.launch_campaign(
  p_campaign_id uuid,
  p_expected_count int,
  p_dry_run boolean,
  p_template_snapshot jsonb,
  p_est_rate numeric
) returns int language plpgsql security definer set search_path = public as $$
declare
  c public.campaigns%rowtype;
  n int;
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
  from public.audience_leads(c.audience_filter) a
  where a.phone_e164 is not null and a.marketing_consent = 'opted_in' and not a.suppressed
  on conflict (campaign_id, phone_e164) do nothing;
  get diagnostics n = row_count;

  if n = 0 then raise exception 'no eligible recipients'; end if;
  if n <> p_expected_count then
    raise exception 'audience changed: % eligible now, but % were confirmed. Review and confirm again.', n, p_expected_count;
  end if;

  update public.campaigns set
    status = 'running',
    is_dry_run = p_dry_run,
    template_snapshot = p_template_snapshot,
    total_recipients = n,
    est_rate = p_est_rate,
    est_cost = case when p_dry_run then 0 else round(n * p_est_rate, 2) end,
    confirmed_by = auth.uid(),
    confirmed_at = now(),
    started_at = now(),
    last_error = null
  where id = p_campaign_id;

  insert into public.audit_logs (actor_id, action, entity_type, entity_id, details)
  values (auth.uid(), case when p_dry_run then 'campaign.launch_dry_run' else 'campaign.launch' end, 'campaign',
          p_campaign_id::text, jsonb_build_object('recipients', n, 'est_rate', p_est_rate));
  return n;
end $$;

-- ---------- Controls -------------------------------------------------
create or replace function public.campaign_control(p_campaign_id uuid, p_action text)
returns public.campaign_status language plpgsql security definer set search_path = public as $$
declare
  c public.campaigns%rowtype;
  next_status public.campaign_status;
begin
  if not public.has_role(array['admin', 'manager']::public.app_role[]) then
    raise exception 'not authorized';
  end if;
  select * into c from public.campaigns where id = p_campaign_id for update;
  if not found then raise exception 'campaign not found'; end if;

  if p_action = 'pause' and c.status = 'running' then
    next_status := 'paused';
  elsif p_action = 'resume' and c.status = 'paused' then
    next_status := 'running';
  elsif p_action = 'cancel' and c.status in ('draft', 'queued', 'running', 'paused') then
    next_status := 'cancelled';
    update public.campaign_recipients set status = 'cancelled'
     where campaign_id = p_campaign_id and status = 'queued';
  elsif p_action = 'retry_failed' and c.status in ('running', 'paused', 'completed') then
    -- Only rows Meta never accepted (no wa_message_id) with retryable codes,
    -- so a message can never be sent twice.
    update public.campaign_recipients
       set status = 'queued', attempts = 0, next_attempt_at = now(), last_error = null, last_error_code = null
     where campaign_id = p_campaign_id and status = 'failed' and wa_message_id is null
       and coalesce(last_error_code, '') = any (public.retryable_error_codes());
    next_status := case when c.status = 'paused' then 'paused'::public.campaign_status else 'running'::public.campaign_status end;
  else
    raise exception 'cannot % a campaign that is %', p_action, c.status;
  end if;

  update public.campaigns set
    status = next_status,
    last_error = case when p_action in ('resume', 'retry_failed') then null else last_error end,
    completed_at = case when next_status = 'cancelled' then now() when next_status = 'running' then null else completed_at end
  where id = p_campaign_id;

  insert into public.audit_logs (actor_id, action, entity_type, entity_id, details)
  values (auth.uid(), 'campaign.' || p_action, 'campaign', p_campaign_id::text, '{}'::jsonb);
  return next_status;
end $$;

-- ---------- Worker helpers (service role only) ------------------------
-- Replace v1: a row stuck in 'sending' might have been accepted by Meta
-- before the worker died, so it is NOT re-queued (that could send twice).
-- It is marked failed/interrupted for a human to review.
create or replace function public.release_stale_recipients(p_older_than interval default '10 minutes')
returns int language plpgsql security definer set search_path = public as $$
declare n int;
begin
  update public.campaign_recipients
     set status = 'failed', failed_at = now(), last_error_code = 'interrupted',
         last_error = 'Worker stopped mid-send; delivery unknown. Not retried automatically to avoid duplicates.'
   where status = 'sending' and wa_message_id is null and locked_at < now() - p_older_than;
  get diagnostics n = row_count;
  return n;
end $$;

create or replace function public.complete_finished_campaigns()
returns int language plpgsql security definer set search_path = public as $$
declare n int;
begin
  update public.campaigns c set status = 'completed', completed_at = now()
   where c.status = 'running'
     and not exists (select 1 from public.campaign_recipients r
                     where r.campaign_id = c.id and r.status in ('queued', 'sending'));
  get diagnostics n = row_count;
  return n;
end $$;

-- ---------- Stats (evidence-based) -----------------------------------
-- submitted = Meta returned a message id; delivered/read = webhook timestamps.
create or replace function public.campaign_stats(p_campaign_ids uuid[] default null)
returns table (
  campaign_id uuid, total bigint, queued bigint, sending bigint, submitted bigint, sent_confirmed bigint,
  delivered bigint, read bigint, failed bigint, cancelled bigint, skipped bigint, dry_run bigint,
  paid bigint, free bigint
) language sql stable set search_path = public as $$
  select r.campaign_id,
    count(*),
    count(*) filter (where r.status = 'queued'),
    count(*) filter (where r.status = 'sending'),
    count(*) filter (where r.wa_message_id is not null),
    count(*) filter (where r.sent_at is not null),
    count(*) filter (where r.delivered_at is not null),
    count(*) filter (where r.read_at is not null),
    count(*) filter (where r.status = 'failed'),
    count(*) filter (where r.status = 'cancelled'),
    count(*) filter (where r.status = 'skipped'),
    count(*) filter (where r.status = 'dry_run'),
    count(*) filter (where r.pricing ->> 'type' = 'regular'),
    count(*) filter (where r.pricing ->> 'type' like 'free%')
  from public.campaign_recipients r
  where p_campaign_ids is null or r.campaign_id = any (p_campaign_ids)
  group by r.campaign_id
$$;

create or replace function public.campaign_failure_reasons(p_campaign_id uuid)
returns table (code text, reason text, n bigint)
language sql stable set search_path = public as $$
  select coalesce(last_error_code, '—'), coalesce(max(last_error), 'Unknown'), count(*)
  from public.campaign_recipients
  where campaign_id = p_campaign_id and status in ('failed', 'skipped')
  group by coalesce(last_error_code, '—')
  order by count(*) desc
$$;

-- Dashboard v2: message counts from evidence (ids / webhook timestamps).
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
        'sent', count(*) filter (where wa_message_id is not null),
        'delivered', count(*) filter (where delivered_at is not null),
        'read', count(*) filter (where read_at is not null),
        'failed', count(*) filter (where status = 'failed'),
        'pending', count(*) filter (where status in ('queued', 'sending')),
        'dry_run', count(*) filter (where status = 'dry_run'))
      from campaign_recipients),
    'est_cost', (select coalesce(sum(est_cost), 0) from campaigns where not is_dry_run
                 and status in ('running', 'paused', 'completed', 'cancelled'))
  )
$$;

-- ---------- Meta-reported costs (pricing_analytics) -------------------
-- "Approximate charges" as reported by Meta for the WABA. Kept separate
-- from the CRM's own estimates.
create table public.meta_cost_reports (
  id bigint generated always as identity primary key,
  period_start timestamptz not null,
  period_end timestamptz not null,
  country text,
  pricing_category text,
  pricing_type text,
  volume bigint not null default 0,
  cost numeric(14, 4),
  fetched_at timestamptz not null default now(),
  fetched_by uuid references public.profiles (id) on delete set null
);
create index meta_cost_reports_period_idx on public.meta_cost_reports (period_start);
alter table public.meta_cost_reports enable row level security;
create policy meta_cost_select on public.meta_cost_reports for select to authenticated
  using (public.current_app_role() is not null);
create policy meta_cost_write on public.meta_cost_reports for all to authenticated
  using (public.has_role(array['admin', 'manager']::public.app_role[]))
  with check (public.has_role(array['admin', 'manager']::public.app_role[]));

-- ---------- Grants ---------------------------------------------------
grant execute on function public.audience_counts(jsonb) to authenticated;
grant execute on function public.audience_leads(jsonb) to authenticated;
grant execute on function public.launch_campaign(uuid, int, boolean, jsonb, numeric) to authenticated;
grant execute on function public.campaign_control(uuid, text) to authenticated;
grant execute on function public.campaign_stats(uuid[]) to authenticated;
grant execute on function public.campaign_failure_reasons(uuid) to authenticated;
revoke execute on function public.release_stale_recipients(interval) from public, anon, authenticated;
revoke execute on function public.complete_finished_campaigns() from public, anon, authenticated;
grant execute on function public.claim_recipients(int) to service_role;
grant execute on function public.release_stale_recipients(interval) to service_role;
grant execute on function public.complete_finished_campaigns() to service_role;
grant execute on function public.apply_message_status(text, text, timestamptz, text, text, jsonb) to service_role;
