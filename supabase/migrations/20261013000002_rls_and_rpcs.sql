-- =====================================================================
-- Row Level Security, import RPC, audit helper, seed segments
-- Roles: admin (everything), manager (leads/templates/campaigns),
--        agent (leads), viewer (read-only).
-- Server-only tables (webhook_events) have RLS on with no policies, so only
-- the service role can touch them.
-- =====================================================================

alter table public.profiles enable row level security;
alter table public.segments enable row level security;
alter table public.tags enable row level security;
alter table public.imports enable row level security;
alter table public.import_errors enable row level security;
alter table public.leads enable row level security;
alter table public.lead_tags enable row level security;
alter table public.opt_outs enable row level security;
alter table public.consent_events enable row level security;
alter table public.app_settings enable row level security;
alter table public.whatsapp_templates enable row level security;
alter table public.campaigns enable row level security;
alter table public.campaign_recipients enable row level security;
alter table public.webhook_events enable row level security;
alter table public.audit_logs enable row level security;

-- Profiles: everyone signed in sees the team; only admins change roles.
create policy profiles_select on public.profiles for select to authenticated
  using (public.current_app_role() is not null or id = auth.uid());
create policy profiles_admin_update on public.profiles for update to authenticated
  using (public.has_role(array['admin']::public.app_role[]))
  with check (public.has_role(array['admin']::public.app_role[]));

-- Read access for all active roles.
create policy segments_select on public.segments for select to authenticated using (public.current_app_role() is not null);
create policy tags_select on public.tags for select to authenticated using (public.current_app_role() is not null);
create policy imports_select on public.imports for select to authenticated using (public.current_app_role() is not null);
create policy import_errors_select on public.import_errors for select to authenticated using (public.current_app_role() is not null);
create policy leads_select on public.leads for select to authenticated using (public.current_app_role() is not null);
create policy lead_tags_select on public.lead_tags for select to authenticated using (public.current_app_role() is not null);
create policy opt_outs_select on public.opt_outs for select to authenticated using (public.current_app_role() is not null);
create policy consent_events_select on public.consent_events for select to authenticated using (public.current_app_role() is not null);
create policy settings_select on public.app_settings for select to authenticated using (public.current_app_role() is not null);
create policy templates_select on public.whatsapp_templates for select to authenticated using (public.current_app_role() is not null);
create policy campaigns_select on public.campaigns for select to authenticated using (public.current_app_role() is not null);
create policy recipients_select on public.campaign_recipients for select to authenticated using (public.current_app_role() is not null);
create policy audit_select on public.audit_logs for select to authenticated
  using (public.has_role(array['admin', 'manager']::public.app_role[]));

-- Writes: segments & settings → admin
create policy segments_write on public.segments for all to authenticated
  using (public.has_role(array['admin']::public.app_role[]))
  with check (public.has_role(array['admin']::public.app_role[]));
create policy settings_update on public.app_settings for update to authenticated
  using (public.has_role(array['admin']::public.app_role[]))
  with check (public.has_role(array['admin']::public.app_role[]));

-- Leads, tags, lead_tags, consent, opt-outs, imports → admin/manager/agent
create policy tags_write on public.tags for all to authenticated
  using (public.has_role(array['admin', 'manager', 'agent']::public.app_role[]))
  with check (public.has_role(array['admin', 'manager', 'agent']::public.app_role[]));
create policy leads_insert on public.leads for insert to authenticated
  with check (public.has_role(array['admin', 'manager', 'agent']::public.app_role[]));
create policy leads_update on public.leads for update to authenticated
  using (public.has_role(array['admin', 'manager', 'agent']::public.app_role[]))
  with check (public.has_role(array['admin', 'manager', 'agent']::public.app_role[]));
create policy leads_delete on public.leads for delete to authenticated
  using (public.has_role(array['admin']::public.app_role[]));
create policy lead_tags_write on public.lead_tags for all to authenticated
  using (public.has_role(array['admin', 'manager', 'agent']::public.app_role[]))
  with check (public.has_role(array['admin', 'manager', 'agent']::public.app_role[]));
create policy consent_events_insert on public.consent_events for insert to authenticated
  with check (public.has_role(array['admin', 'manager', 'agent']::public.app_role[]));
-- Opt-outs are permanent: insert allowed, no update/delete policy.
create policy opt_outs_insert on public.opt_outs for insert to authenticated
  with check (public.has_role(array['admin', 'manager', 'agent']::public.app_role[]));
create policy imports_insert on public.imports for insert to authenticated
  with check (public.has_role(array['admin', 'manager', 'agent']::public.app_role[]));
create policy imports_update on public.imports for update to authenticated
  using (public.has_role(array['admin', 'manager', 'agent']::public.app_role[]));
create policy import_errors_insert on public.import_errors for insert to authenticated
  with check (public.has_role(array['admin', 'manager', 'agent']::public.app_role[]));

-- Templates & campaigns → admin/manager. Recipients are written server-side.
create policy templates_write on public.whatsapp_templates for all to authenticated
  using (public.has_role(array['admin', 'manager']::public.app_role[]))
  with check (public.has_role(array['admin', 'manager']::public.app_role[]));
create policy campaigns_write on public.campaigns for all to authenticated
  using (public.has_role(array['admin', 'manager']::public.app_role[]))
  with check (public.has_role(array['admin', 'manager']::public.app_role[]));

-- Audit log: append-only through log_audit().
create or replace function public.log_audit(
  p_action text, p_entity_type text, p_entity_id text default null, p_details jsonb default '{}'::jsonb
) returns void language plpgsql security definer set search_path = public as $$
begin
  if public.current_app_role() is null then
    raise exception 'not authorized';
  end if;
  insert into public.audit_logs (actor_id, action, entity_type, entity_id, details)
  values (auth.uid(), p_action, p_entity_type, p_entity_id, coalesce(p_details, '{}'::jsonb));
end $$;

-- ---------------------------------------------------------------------
-- import_leads_batch: insert/update one batch of pre-validated rows.
-- Rows are normalised in the app (phone → E.164). Each element:
-- { row_number, full_name, organization, phone_raw, phone_e164, email, city,
--   state, country, source, notes, custom_fields, consent }
-- consent ∈ 'opted_in' | 'opted_out' | null.
-- Returns { inserted, updated, duplicates }.
-- ---------------------------------------------------------------------
create or replace function public.import_leads_batch(p_import_id uuid, p_rows jsonb)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  imp public.imports%rowtype;
  v_inserted int := 0;
  v_updated int := 0;
  v_dupes int := 0;
begin
  if not public.has_role(array['admin', 'manager', 'agent']::public.app_role[]) then
    raise exception 'not authorized';
  end if;

  select * into imp from public.imports where id = p_import_id for update;
  if not found then raise exception 'import % not found', p_import_id; end if;
  if imp.status <> 'processing' then raise exception 'import % is not processing', p_import_id; end if;

  drop table if exists pg_temp._rows;
  create temp table _rows on commit drop as
  select r.*, (l.id is not null) as exists_already, l.id as existing_id
  from jsonb_to_recordset(p_rows) as r(
    row_number int, full_name text, organization text, phone_raw text, phone_e164 text,
    email text, city text, state text, country text, source text, notes text,
    custom_fields jsonb, consent text)
  left join public.leads l on l.phone_e164 = r.phone_e164;

  -- Permanent suppression for rows explicitly marked as opted out.
  insert into public.opt_outs (phone_e164, reason, source, created_by)
  select phone_e164, 'Marked opted-out in import ' || imp.file_name, 'import', auth.uid()
  from _rows where consent = 'opted_out' and phone_e164 is not null
  on conflict (phone_e164) do nothing;

  -- Duplicates (skip strategy) are recorded in the row report.
  if imp.duplicate_strategy = 'skip' then
    insert into public.import_errors (import_id, row_number, error, raw)
    select p_import_id, row_number, 'Duplicate phone ' || phone_e164 || ' already exists — skipped',
           jsonb_build_object('phone', phone_raw, 'name', full_name)
    from _rows where exists_already;
    select count(*) into v_dupes from _rows where exists_already;
  else
    with upd as (
      update public.leads l set
        full_name = coalesce(r.full_name, l.full_name),
        organization = coalesce(r.organization, l.organization),
        email = coalesce(r.email, l.email),
        city = coalesce(r.city, l.city),
        state = coalesce(r.state, l.state),
        country = coalesce(r.country, l.country),
        source = coalesce(r.source, l.source),
        notes = coalesce(r.notes, l.notes),
        segment_id = coalesce(imp.segment_id, l.segment_id),
        custom_fields = l.custom_fields || coalesce(r.custom_fields, '{}'::jsonb),
        marketing_consent = case when r.consent = 'opted_in' and l.marketing_consent = 'unknown'
                                 then 'opted_in'::public.consent_status else l.marketing_consent end,
        consent_source = case when r.consent = 'opted_in' and l.marketing_consent = 'unknown'
                              then 'import:' || imp.file_name else l.consent_source end,
        consent_at = case when r.consent = 'opted_in' and l.marketing_consent = 'unknown'
                          then now() else l.consent_at end,
        is_archived = false
      from _rows r where r.existing_id = l.id
      returning l.id
    ) select count(*) into v_updated from upd;
    select count(*) into v_dupes from _rows where exists_already;
  end if;

  with ins as (
    insert into public.leads (full_name, organization, phone_raw, phone_e164, email, city, state,
                              country, source, notes, custom_fields, segment_id, import_id,
                              created_by, marketing_consent, consent_source, consent_at)
    select full_name, organization, phone_raw, phone_e164, email, city, state, country,
           coalesce(source, 'import'), notes, coalesce(custom_fields, '{}'::jsonb), imp.segment_id,
           p_import_id, auth.uid(),
           case when consent = 'opted_in' then 'opted_in'::public.consent_status
                when consent = 'opted_out' then 'opted_out'::public.consent_status
                else 'unknown'::public.consent_status end,
           case when consent in ('opted_in', 'opted_out') then 'import:' || imp.file_name end,
           case when consent in ('opted_in', 'opted_out') then now() end
    from _rows where not exists_already
    on conflict (phone_e164) do nothing
    returning id, phone_e164
  )
  select count(*) into v_inserted from ins;

  -- Tags for every touched lead (new + updated).
  if array_length(imp.tag_ids, 1) > 0 then
    insert into public.lead_tags (lead_id, tag_id)
    select l.id, t.tag_id
    from public.leads l
    join _rows r on r.phone_e164 = l.phone_e164
    cross join unnest(imp.tag_ids) as t(tag_id)
    where (not r.exists_already) or imp.duplicate_strategy = 'update'
    on conflict do nothing;
  end if;

  -- Consent history.
  insert into public.consent_events (lead_id, phone_e164, status, source, evidence, created_by)
  select l.id, l.phone_e164, r.consent::public.consent_status, 'import', imp.consent_basis, auth.uid()
  from _rows r join public.leads l on l.phone_e164 = r.phone_e164
  where r.consent in ('opted_in', 'opted_out')
    and ((not r.exists_already) or imp.duplicate_strategy = 'update');

  update public.imports set
    inserted_count = inserted_count + v_inserted,
    updated_count = updated_count + v_updated,
    duplicate_count = duplicate_count + v_dupes
  where id = p_import_id;

  return jsonb_build_object('inserted', v_inserted, 'updated', v_updated, 'duplicates', v_dupes);
end $$;

grant execute on function public.import_leads_batch(uuid, jsonb) to authenticated;
grant execute on function public.log_audit(text, text, text, jsonb) to authenticated;
grant execute on function public.dashboard_metrics() to authenticated;
-- Queue/status functions are for the service role only.
revoke execute on function public.claim_recipients(int) from public, anon, authenticated;
revoke execute on function public.release_stale_recipients(interval) from public, anon, authenticated;
revoke execute on function public.apply_message_status(text, text, timestamptz, text, text, jsonb) from public, anon, authenticated;

-- ---------- Seed: the six business segments --------------------------
insert into public.segments (slug, name, description, color, sort_order) values
  ('hospital-marketing', 'Hospital Marketing', 'Hospital marketing leads', '#2563eb', 1),
  ('website-development', 'General Website Development', 'General website development leads', '#7c3aed', 2),
  ('ayushman', 'Ayushman', 'Ayushman leads', '#059669', 3),
  ('gic', 'GIC', 'GIC leads', '#d97706', 4),
  ('ayushman-empanelled', 'Already Ayushman Empanelled', 'Hospitals already empanelled under Ayushman', '#0891b2', 5),
  ('ayurvedic-brand', 'Ayurvedic Brand', 'Ayurvedic brand leads', '#65a30d', 6)
on conflict (slug) do nothing;
