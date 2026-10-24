-- Bahn control room: a read-only snapshot, the decisions people make on it,
-- and how much each kind of agent action may do without asking.

-- The snapshot. Every JSONL row, unchanged, keyed by its file and id.
create table public.records (
  collection text not null,
  id text not null,
  order_id text null,
  data jsonb not null,
  primary key (collection, id)
);
create index records_order_id_idx on public.records (order_id);

-- What people decided. A decision is never edited; undo marks it undone.
create table public.decisions (
  id uuid primary key default gen_random_uuid(),
  order_id text not null,
  target_type text not null,
  target_id text not null,
  action text not null,
  note text null,
  decided_by text not null,
  decided_at timestamptz not null default now(),
  effects jsonb not null default '[]'::jsonb,
  undone_at timestamptz null
);
-- At most one live decision per item: the database itself refuses a second.
create unique index decisions_one_live_per_target
  on public.decisions (target_id) where undone_at is null;
create index decisions_order_id_idx on public.decisions (order_id);

-- How far each kind of agent action may go on its own.
create table public.autonomy (
  action_kind text primary key,
  level text not null check (level in ('ask_first', 'act_then_tell', 'on_its_own')),
  locked boolean not null default false,
  updated_at timestamptz not null default now()
);

insert into public.autonomy (action_kind, level, locked) values
  ('read_and_ask', 'on_its_own', true),       -- read records, ask drivers and sites
  ('customer_message', 'ask_first', true),    -- drafted only; a person sends it
  ('book_travel', 'ask_first', false),
  ('change_date', 'ask_first', false),
  ('approve_cost', 'ask_first', false),
  ('change_assignment', 'ask_first', false),
  ('resolve_alert', 'ask_first', false);

alter table public.records enable row level security;
alter table public.decisions enable row level security;
alter table public.autonomy enable row level security;

create policy "anyone may read the snapshot" on public.records for select to anon, authenticated using (true);
create policy "anyone may read decisions" on public.decisions for select to anon, authenticated using (true);
create policy "anyone may read autonomy" on public.autonomy for select to anon, authenticated using (true);

-- No insert, update or delete policy exists, and the grants are removed too:
-- the only way to write is through the functions below.
revoke insert, update, delete, truncate on public.records, public.decisions, public.autonomy from anon, authenticated;
grant select on public.records, public.decisions, public.autonomy to anon, authenticated;

-- Which actions fit which kind of item.
create or replace function public._allowed_actions(p_target_type text, p_status text)
returns text[] language sql immutable as $$
  select case
    when p_target_type = 'proposal' and p_status = 'PENDING_REVIEW' then array['approve', 'change', 'reject']
    when p_target_type = 'proposal' and p_status = 'FAILED' then array['retry', 'take', 'already_sorted']
    when p_target_type = 'proposal' and p_status = 'APPROVED_AWAITING_EXECUTION' then array['take', 'done']
    when p_target_type = 'proposal' then array[]::text[]  -- executed or rejected: settled
    when p_target_type = 'inbox_candidate' then array['link', 'not_this']
    else array['take', 'done']
  end
$$;

create or replace function public.decide(
  p_order_id text,
  p_target_id text,
  p_action text,
  p_note text default null,
  p_effects jsonb default '[]'::jsonb
) returns public.decisions
language plpgsql security definer set search_path = public as $$
declare
  v_type text;
  v_status text;
  v_thread text;
  v_existing public.decisions;
  v_row public.decisions;
begin
  if not exists (select 1 from records where collection = 'orders' and id = p_order_id) then
    raise exception 'There is no order %.', p_order_id using errcode = 'P0002';
  end if;

  -- Work out what the item is from the snapshot itself, not from the caller.
  if p_target_id like 'inbox-%#%' then
    v_type := 'inbox_candidate';
    v_thread := split_part(p_target_id, '#', 1);
    if not exists (
      select 1 from records
      where collection = 'support_inbox_threads' and id = v_thread
        and data->'candidate_order_ids' ? split_part(p_target_id, '#', 2)
        and split_part(p_target_id, '#', 2) = p_order_id
    ) then
      raise exception 'That order is not a candidate for this message.' using errcode = 'P0002';
    end if;
    -- Linking one candidate rules out the others.
    if exists (
      select 1 from decisions
      where undone_at is null and target_type = 'inbox_candidate'
        and split_part(target_id, '#', 1) = v_thread and action = 'link'
    ) then
      raise exception 'This message is already linked to another order.' using errcode = '40001';
    end if;
  elsif exists (select 1 from records where collection = 'agent_proposals' and id = p_target_id and order_id = p_order_id) then
    v_type := 'proposal';
    select data->>'status' into v_status from records where collection = 'agent_proposals' and id = p_target_id;
  elsif p_target_id like 'derived:%' then
    v_type := 'derived';
    if split_part(p_target_id, ':', 3) <> p_order_id then
      raise exception 'That check belongs to another order.' using errcode = 'P0002';
    end if;
  elsif exists (select 1 from records where id = p_target_id and order_id = p_order_id) then
    select collection into v_type from records where id = p_target_id and order_id = p_order_id limit 1;
  elsif exists (
    -- A conversation filed on one order can be related to another.
    select 1 from records where collection = 'conversations' and id = p_target_id
      and data->'related_order_ids' ? p_order_id
  ) then
    v_type := 'conversations';
  else
    raise exception 'Nothing with id % is open on this order.', p_target_id using errcode = 'P0002';
  end if;

  if v_type = 'proposal' and v_status not in ('PENDING_REVIEW', 'FAILED', 'APPROVED_AWAITING_EXECUTION') then
    raise exception 'This proposal is already settled in the records.' using errcode = '40001';
  end if;

  if not (p_action = any (public._allowed_actions(v_type, v_status))) then
    raise exception 'You cannot % this item.', replace(p_action, '_', ' ') using errcode = '22023';
  end if;

  if p_action in ('change', 'reject', 'done', 'already_sorted') and coalesce(btrim(p_note), '') = '' then
    raise exception 'Add a short note to say why.' using errcode = '22023';
  end if;

  -- Stale-state protection: re-read the current decision before writing.
  select * into v_existing from decisions where target_id = p_target_id and undone_at is null;
  if found then
    raise exception 'Already decided by % at %. Refresh to see it.',
      v_existing.decided_by, to_char(v_existing.decided_at at time zone 'UTC', 'HH24:MI "UTC"')
      using errcode = '40001';
  end if;

  insert into decisions (order_id, target_type, target_id, action, note, decided_by, effects)
  values (p_order_id, v_type, p_target_id, p_action, nullif(btrim(p_note), ''), 'Shift operator', coalesce(p_effects, '[]'::jsonb))
  returning * into v_row;
  return v_row;
exception
  when unique_violation then
    raise exception 'Someone decided this a moment ago. Refresh to see it.' using errcode = '40001';
end
$$;

create or replace function public.undo_decision(p_id uuid)
returns public.decisions
language plpgsql security definer set search_path = public as $$
declare
  v_row public.decisions;
begin
  update decisions set undone_at = now()
  where id = p_id and undone_at is null
  returning * into v_row;
  if not found then
    raise exception 'That decision is already undone or does not exist.' using errcode = '40001';
  end if;
  return v_row;
end
$$;

create or replace function public.set_autonomy(p_kind text, p_level text)
returns public.autonomy
language plpgsql security definer set search_path = public as $$
declare
  v_row public.autonomy;
begin
  select * into v_row from autonomy where action_kind = p_kind;
  if not found then
    raise exception 'Unknown kind of action: %.', p_kind using errcode = 'P0002';
  end if;
  if v_row.locked then
    raise exception 'This rule is fixed and cannot be changed here.' using errcode = '42501';
  end if;
  update autonomy set level = p_level, updated_at = now()
  where action_kind = p_kind
  returning * into v_row;
  return v_row;
end
$$;

revoke all on function public.decide(text, text, text, text, jsonb) from public;
revoke all on function public.undo_decision(uuid) from public;
revoke all on function public.set_autonomy(text, text) from public;
revoke all on function public._allowed_actions(text, text) from public;
grant execute on function public.decide(text, text, text, text, jsonb) to anon, authenticated;
grant execute on function public.undo_decision(uuid) to anon, authenticated;
grant execute on function public.set_autonomy(text, text) to anon, authenticated;

-- Attachments: a public bucket the seed fills after checking each file's hash.
insert into storage.buckets (id, name, public)
values ('packet', 'packet', true)
on conflict (id) do nothing;
