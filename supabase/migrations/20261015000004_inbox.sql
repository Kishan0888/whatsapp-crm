-- =====================================================================
-- WhatsApp inbox: conversations, messages, button-driven flows.
--
-- * One conversation per phone (E.164), linked to the existing lead with
--   the same phone.
-- * messages.wa_message_id is unique, so webhook retries and duplicate
--   deliveries never create duplicate rows.
-- * Automated replies get idempotency_key = 'auto:<inbound wamid>:<n>', so a
--   retried webhook can never send the same reply twice.
-- * Flow state is stored on the conversation (flow + flow_rev for
--   compare-and-set) and survives deploys and retries.
-- * Campaign sends stay in campaign_recipients; the inbox reads them by
--   phone at display time (no duplicated rows).
-- All writes go through the functions below (service role, or role-checked
-- security definer functions for signed-in users).
-- =====================================================================

alter table public.app_settings
  add column meeting_url text check (meeting_url is null or meeting_url ~ '^https://\S+$'),
  add column growth_report_template_id uuid references public.whatsapp_templates (id) on delete set null;

create table public.conversations (
  id uuid primary key default gen_random_uuid(),
  phone_e164 text not null unique,
  lead_id uuid references public.leads (id) on delete set null,
  contact_name text,               -- WhatsApp profile name
  last_message_at timestamptz,
  last_message_preview text,
  last_direction text check (last_direction in ('in', 'out')),
  last_inbound_at timestamptz,     -- customer service window = last_inbound_at + 24h
  unread_count int not null default 0,
  flow jsonb,                      -- active/last automation flow state
  flow_rev int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index conversations_last_message_idx on public.conversations (last_message_at desc nulls last);
create index conversations_lead_idx on public.conversations (lead_id);
create trigger conversations_updated_at before update on public.conversations
  for each row execute function public.set_updated_at();

create table public.messages (
  id bigint generated always as identity primary key,
  conversation_id uuid not null references public.conversations (id) on delete cascade,
  direction text not null check (direction in ('in', 'out')),
  wa_message_id text unique,
  idempotency_key text unique,
  -- text | button | interactive | image | video | document | audio | sticker | location | template | cta_url | note | ...
  type text not null,
  body text,
  payload jsonb not null default '{}'::jsonb,
  -- in: received | out: pending → sending → sent → delivered → read, or failed / mock / skipped
  status text not null check (status in ('received', 'pending', 'sending', 'sent', 'delivered', 'read', 'failed', 'mock', 'skipped')),
  source text not null check (source in ('inbound', 'inbox', 'automation')),
  context_wa_message_id text,      -- message being replied to (inbound button taps)
  trigger_wa_message_id text,      -- inbound message that caused an automated reply
  sent_by uuid references public.profiles (id) on delete set null,
  error_code text,
  error_message text,
  wa_timestamp timestamptz,
  sent_at timestamptz,
  delivered_at timestamptz,
  read_at timestamptz,
  failed_at timestamptz,
  created_at timestamptz not null default now()
);
create index messages_conversation_idx on public.messages (conversation_id, created_at);
create index messages_trigger_idx on public.messages (trigger_wa_message_id) where trigger_wa_message_id is not null;

-- Keep the conversation summary in sync with its messages.
create or replace function public.messages_touch_conversation()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.type = 'note' then
    return new;
  end if;
  update public.conversations c set
    last_message_at = greatest(coalesce(c.last_message_at, '-infinity'), coalesce(new.wa_timestamp, new.created_at)),
    last_message_preview = left(coalesce(new.body, '[' || new.type || ']'), 160),
    last_direction = new.direction,
    unread_count = c.unread_count + case when new.direction = 'in' then 1 else 0 end,
    last_inbound_at = case when new.direction = 'in'
                           then greatest(coalesce(c.last_inbound_at, '-infinity'), coalesce(new.wa_timestamp, new.created_at))
                           else c.last_inbound_at end
  where c.id = new.conversation_id;
  return new;
end $$;
create trigger messages_touch_conversation after insert on public.messages
  for each row execute function public.messages_touch_conversation();

-- Link conversations to leads whenever a lead gets (or changes) a phone.
create or replace function public.leads_link_conversations()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.phone_e164 is not null then
    update public.conversations set lead_id = new.id
     where phone_e164 = new.phone_e164 and lead_id is distinct from new.id;
  end if;
  return new;
end $$;
create trigger leads_link_conversations after insert or update of phone_e164 on public.leads
  for each row execute function public.leads_link_conversations();

-- ---------- Status webhooks: campaigns + inbox --------------------------
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
  updated_msgs int;
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

  update public.messages m set
    status = case
      when p_status = 'failed' and m.status in ('sending', 'sent', 'delivered') then 'failed'
      when p_status <> 'failed' and rank_new > (case m.status when 'sent' then 1 when 'delivered' then 2
                                                 when 'read' then 3 when 'sending' then 0 else 99 end)
        then p_status
      else m.status end,
    sent_at = coalesce(m.sent_at, case when p_status in ('sent', 'delivered', 'read') then p_timestamp end),
    delivered_at = coalesce(m.delivered_at, case when p_status in ('delivered', 'read') then p_timestamp end),
    read_at = coalesce(m.read_at, case when p_status = 'read' then p_timestamp end),
    failed_at = case when p_status = 'failed' then coalesce(m.failed_at, p_timestamp) else m.failed_at end,
    error_code = case when p_status = 'failed' then p_error_code else m.error_code end,
    error_message = case when p_status = 'failed' then p_error else m.error_message end
  where m.wa_message_id = p_wa_message_id and m.direction = 'out';
  get diagnostics updated_msgs = row_count;

  return updated + updated_msgs > 0;
end $$;

-- ---------- Inbound ----------------------------------------------------
-- Upsert the conversation, link the lead, insert the message once.
create or replace function public.inbox_record_inbound(
  p_phone text,
  p_wa_message_id text,
  p_type text,
  p_body text,
  p_payload jsonb,
  p_context_id text,
  p_wa_timestamp timestamptz,
  p_profile_name text
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  conv public.conversations%rowtype;
  v_lead uuid;
  v_msg bigint;
begin
  select id into v_lead from public.leads where phone_e164 = p_phone;

  insert into public.conversations (phone_e164, lead_id, contact_name)
  values (p_phone, v_lead, nullif(p_profile_name, ''))
  on conflict (phone_e164) do update set
    lead_id = coalesce(excluded.lead_id, public.conversations.lead_id),
    contact_name = coalesce(excluded.contact_name, public.conversations.contact_name);

  insert into public.messages (conversation_id, direction, wa_message_id, type, body, payload, status, source,
                               context_wa_message_id, wa_timestamp)
  select c.id, 'in', p_wa_message_id, p_type, left(p_body, 4096), coalesce(p_payload, '{}'::jsonb), 'received', 'inbound',
         p_context_id, p_wa_timestamp
  from public.conversations c where c.phone_e164 = p_phone
  on conflict (wa_message_id) do nothing
  returning id into v_msg;

  select * into conv from public.conversations where phone_e164 = p_phone;
  return jsonb_build_object(
    'conversation_id', conv.id,
    'lead_id', conv.lead_id,
    'message_id', v_msg,
    'inserted', v_msg is not null,
    'flow', conv.flow,
    'flow_rev', conv.flow_rev,
    'last_inbound_at', conv.last_inbound_at
  );
end $$;

-- ---------- Lead details from the "Send Details" flow ---------------------
-- Fills empty name/organization (never overwrites), always records the
-- submission in custom_fields and notes. Creates the lead if needed.
create or replace function public.inbox_save_details(
  p_phone text,
  p_representative text,
  p_hospital text,
  p_preferred_time text
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_lead uuid;
  v_created boolean := false;
  v_stamp text := to_char(now() at time zone 'Asia/Kolkata', 'YYYY-MM-DD HH24:MI') || ' IST';
  v_fields jsonb := jsonb_build_object(
    'WhatsApp: representative name', p_representative,
    'WhatsApp: hospital name', p_hospital,
    'WhatsApp: preferred meeting', p_preferred_time,
    'WhatsApp: details submitted', v_stamp);
  v_note text := format('[%s] WhatsApp details — representative: %s; hospital: %s; preferred meeting: %s',
                        v_stamp, p_representative, p_hospital, p_preferred_time);
begin
  select id into v_lead from public.leads where phone_e164 = p_phone for update;
  if v_lead is null then
    insert into public.leads (phone_e164, phone_raw, full_name, organization, source, status, custom_fields, notes)
    values (p_phone, p_phone, p_representative, p_hospital, 'whatsapp', 'interested', v_fields, v_note)
    on conflict (phone_e164) do nothing
    returning id into v_lead;
    v_created := v_lead is not null;
  end if;
  if not v_created then
    select id into v_lead from public.leads where phone_e164 = p_phone;
    update public.leads set
      full_name = coalesce(nullif(full_name, ''), p_representative),
      organization = coalesce(nullif(organization, ''), p_hospital),
      custom_fields = custom_fields || v_fields,
      notes = case when coalesce(notes, '') = '' then v_note else notes || E'\n' || v_note end,
      status = case when status in ('new', 'contacted') then 'interested'::public.lead_status else status end,
      is_archived = false
    where id = v_lead;
  end if;
  update public.conversations set lead_id = v_lead where phone_e164 = p_phone;
  insert into public.audit_logs (action, entity_type, entity_id, details)
  values ('whatsapp.details_submitted', 'lead', v_lead::text,
          jsonb_build_object('created', v_created, 'hospital', p_hospital, 'preferred_time', p_preferred_time));
  return jsonb_build_object('lead_id', v_lead, 'created', v_created);
end $$;

-- ---------- Automation: state change + queued replies, atomically -------
-- p_replies: [{ idempotency_key, type, body, payload, status?, error_message? }]
-- p_details: { representative, hospital, preferred_time } or null
create or replace function public.inbox_apply_flow(
  p_conversation_id uuid,
  p_set_flow boolean,
  p_expected_rev int,
  p_flow jsonb,
  p_trigger_wa_message_id text,
  p_replies jsonb,
  p_details jsonb
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  conv public.conversations%rowtype;
  r jsonb;
  v_lead jsonb;
begin
  select * into conv from public.conversations where id = p_conversation_id for update;
  if not found then raise exception 'conversation not found'; end if;
  if p_set_flow then
    if conv.flow_rev <> p_expected_rev then
      return jsonb_build_object('ok', false, 'reason', 'stale');
    end if;
    update public.conversations set flow = p_flow, flow_rev = flow_rev + 1 where id = conv.id;
  end if;

  if p_details is not null then
    v_lead := public.inbox_save_details(conv.phone_e164, p_details ->> 'representative', p_details ->> 'hospital',
                                         p_details ->> 'preferred_time');
  end if;

  for r in select * from jsonb_array_elements(coalesce(p_replies, '[]'::jsonb)) loop
    insert into public.messages (conversation_id, direction, idempotency_key, type, body, payload, status, source,
                                 trigger_wa_message_id, error_message)
    values (conv.id, 'out', r ->> 'idempotency_key', r ->> 'type', left(r ->> 'body', 4096),
            coalesce(r -> 'payload', '{}'::jsonb), coalesce(r ->> 'status', 'pending'), 'automation',
            p_trigger_wa_message_id, r ->> 'error_message')
    on conflict (idempotency_key) do nothing;
  end loop;

  return jsonb_build_object('ok', true, 'lead', v_lead);
end $$;

-- Pending automated replies for an inbound message (sent in order).
create or replace function public.inbox_pending_replies(p_trigger_wa_message_id text)
returns jsonb language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(id order by id), '[]'::jsonb) from public.messages
  where trigger_wa_message_id = p_trigger_wa_message_id and direction = 'out' and status = 'pending'
$$;

-- Staff reply (or any outbound) queued once per idempotency key.
create or replace function public.inbox_queue_outbound(
  p_conversation_id uuid,
  p_idempotency_key text,
  p_type text,
  p_body text,
  p_payload jsonb,
  p_source text,
  p_sent_by uuid
) returns jsonb language plpgsql security definer set search_path = public as $$
declare v_id bigint;
begin
  insert into public.messages (conversation_id, direction, idempotency_key, type, body, payload, status, source, sent_by)
  values (p_conversation_id, 'out', p_idempotency_key, p_type, left(p_body, 4096), coalesce(p_payload, '{}'::jsonb),
          'pending', p_source, p_sent_by)
  on conflict (idempotency_key) do nothing
  returning id into v_id;
  if v_id is null then
    select id into v_id from public.messages where idempotency_key = p_idempotency_key;
    return jsonb_build_object('id', v_id, 'duplicate', true);
  end if;
  return jsonb_build_object('id', v_id, 'duplicate', false);
end $$;

-- Claim a pending outbound message for sending (pending → sending, once).
create or replace function public.inbox_claim_outbound(p_message_id bigint)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  m public.messages%rowtype;
  c public.conversations%rowtype;
begin
  update public.messages set status = 'sending' where id = p_message_id and status = 'pending' returning * into m;
  if not found then return jsonb_build_object('claimed', false); end if;
  select * into c from public.conversations where id = m.conversation_id;
  return jsonb_build_object(
    'claimed', true, 'id', m.id, 'type', m.type, 'body', m.body, 'payload', m.payload,
    'phone', c.phone_e164, 'last_inbound_at', c.last_inbound_at);
end $$;

create or replace function public.inbox_finish_outbound(
  p_message_id bigint, p_status text, p_wa_message_id text, p_error_code text, p_error text
) returns void language plpgsql security definer set search_path = public as $$
begin
  update public.messages set
    status = p_status,
    wa_message_id = coalesce(p_wa_message_id, wa_message_id),
    error_code = p_error_code,
    error_message = p_error,
    sent_at = case when p_status = 'sent' then now() else sent_at end,
    failed_at = case when p_status = 'failed' then now() else failed_at end
  where id = p_message_id and status = 'sending';
end $$;

-- ---------- Staff actions (signed-in users, role-checked) ---------------
create or replace function public.inbox_mark_read(p_conversation_id uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  if public.current_app_role() is null then raise exception 'not authorized'; end if;
  update public.conversations set unread_count = 0 where id = p_conversation_id and unread_count <> 0;
end $$;

create or replace function public.inbox_cancel_flow(p_conversation_id uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.has_role(array['admin', 'manager', 'agent']::public.app_role[]) then
    raise exception 'not authorized';
  end if;
  update public.conversations
     set flow = case when flow is null then null
                     else flow || jsonb_build_object('step', 'cancelled', 'updated_at', now()) end,
         flow_rev = flow_rev + 1
   where id = p_conversation_id and flow is not null and flow ->> 'step' not in ('done', 'cancelled');
  insert into public.audit_logs (actor_id, action, entity_type, entity_id, details)
  values (auth.uid(), 'inbox.cancel_flow', 'conversation', p_conversation_id::text, '{}'::jsonb);
end $$;

-- ---------- RLS ---------------------------------------------------------
alter table public.conversations enable row level security;
alter table public.messages enable row level security;
create policy conversations_select on public.conversations for select to authenticated
  using (public.current_app_role() is not null);
create policy messages_select on public.messages for select to authenticated
  using (public.current_app_role() is not null);
-- No insert/update/delete policies: writes only via the functions above.

revoke execute on function public.inbox_record_inbound(text, text, text, text, jsonb, text, timestamptz, text) from public, anon, authenticated;
revoke execute on function public.inbox_save_details(text, text, text, text) from public, anon, authenticated;
revoke execute on function public.inbox_apply_flow(uuid, boolean, int, jsonb, text, jsonb, jsonb) from public, anon, authenticated;
revoke execute on function public.inbox_pending_replies(text) from public, anon, authenticated;
revoke execute on function public.inbox_queue_outbound(uuid, text, text, text, jsonb, text, uuid) from public, anon, authenticated;
revoke execute on function public.inbox_claim_outbound(bigint) from public, anon, authenticated;
revoke execute on function public.inbox_finish_outbound(bigint, text, text, text, text) from public, anon, authenticated;
grant execute on function public.inbox_record_inbound(text, text, text, text, jsonb, text, timestamptz, text) to service_role;
grant execute on function public.inbox_save_details(text, text, text, text) to service_role;
grant execute on function public.inbox_apply_flow(uuid, boolean, int, jsonb, text, jsonb, jsonb) to service_role;
grant execute on function public.inbox_pending_replies(text) to service_role;
grant execute on function public.inbox_queue_outbound(uuid, text, text, text, jsonb, text, uuid) to service_role;
grant execute on function public.inbox_claim_outbound(bigint) to service_role;
grant execute on function public.inbox_finish_outbound(bigint, text, text, text, text) to service_role;
grant execute on function public.inbox_mark_read(uuid) to authenticated;
grant execute on function public.inbox_cancel_flow(uuid) to authenticated;
