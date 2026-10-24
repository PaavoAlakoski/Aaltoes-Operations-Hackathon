-- Conflicts used errcode 40001 (serialization failure), which clients treat as
-- retryable: a refused second decision hung instead of failing. PostgREST maps
-- PT409 straight to HTTP 409 Conflict, which is what a stale decision is.
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
      raise exception 'This message is already linked to another order.' using errcode = 'PT409';
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
    -- Support inbox threads carry no order_id; only linked_order_ids link them.
    select 1 from records where collection = 'support_inbox_threads' and id = p_target_id
      and data->'linked_order_ids' ? p_order_id
  ) then
    v_type := 'support_inbox_threads';
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
    raise exception 'This proposal is already settled in the records.' using errcode = 'PT409';
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
      using errcode = 'PT409';
  end if;

  insert into decisions (order_id, target_type, target_id, action, note, decided_by, effects)
  values (p_order_id, v_type, p_target_id, p_action, nullif(btrim(p_note), ''), 'Shift operator', coalesce(p_effects, '[]'::jsonb))
  returning * into v_row;
  return v_row;
exception
  when unique_violation then
    raise exception 'Someone decided this a moment ago. Refresh to see it.' using errcode = 'PT409';
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
    raise exception 'That decision is already undone or does not exist.' using errcode = 'PT409';
  end if;
  return v_row;
end
$$;

