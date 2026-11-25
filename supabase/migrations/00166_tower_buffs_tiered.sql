-- Tower buffs come often at first, then less often (TOWER_BOON_TIERS in
-- shared tower.ts): a pick on each of the first 5 floors of a climb, every
-- 2nd floor to 15, every 3rd to 30, every 5th after; it was every 3rd.
-- tower_boon_picks mirrors towerBoonPicks, and tower_grant's cap on the
-- picks a climb has spent (00163) uses it. Climbs under way keep what they
-- hold; one past floor 67 already holding more than the new count earns
-- no more until it would have (tower_grant leaves its boons be).

create or replace function public.tower_boon_picks(p_cleared integer)
returns integer
language sql
immutable
set search_path = ''
as $$
  select case
    when c <= 5 then c
    when c <= 15 then 5 + (c - 5) / 2
    when c <= 30 then 10 + (c - 15) / 3
    else 15 + (c - 30) / 5
  end
  from (select greatest(coalesce(p_cleared, 0), 0) as c) x;
$$;
revoke execute on function public.tower_boon_picks(integer) from public, anon, authenticated;

create or replace function public.tower_grant(
  p_user     uuid,
  p_event    uuid,
  p_batch    text,
  p_xp       integer,
  p_cleared  integer,
  p_item_ids text[],
  p_xp_cap   integer,
  p_drop_cap integer,
  p_climb    integer default null,
  p_boons    text[]  default null,
  p_skips    integer default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_rows  int;
  v_today date := (now() at time zone 'utc')::date;
  v_daily public.tower_daily%rowtype;
  v_xp    int;
  v_room  int;
  v_drops jsonb := '[]'::jsonb;
  v_item  text;
  v_id    uuid;
  v_lands timestamptz := now() + interval '90 seconds';
  v_best  int;
  v_prog  public.tower_progress%rowtype;
  v_floor int;
  v_boons text[];
  v_skips int;
begin
  if p_batch is null or length(p_batch) = 0 or length(p_batch) > 200 then
    raise exception 'bad batch id';
  end if;
  if coalesce(array_length(p_item_ids, 1), 0) > 50 then
    raise exception 'too many drops';
  end if;

  insert into public.tower_batches (batch) values (p_batch)
  on conflict (batch) do nothing;
  get diagnostics v_rows = row_count;
  if v_rows = 0 then
    return jsonb_build_object('drops', '[]'::jsonb);
  end if;

  if not exists (select 1 from public.herzies where user_id = p_user) then
    return jsonb_build_object('drops', '[]'::jsonb);
  end if;

  if coalesce(p_cleared, 0) > 0 then
    -- The best floor over every Tower so far, before this one moves.
    select coalesce(max(best_floor), 0) into v_best
      from public.tower_progress where user_id = p_user;

    insert into public.tower_progress (user_id, event_id, best_floor)
    values (p_user, p_event, p_cleared)
    on conflict (user_id, event_id) do update
      set best_floor = greatest(public.tower_progress.best_floor, excluded.best_floor),
          -- Only a new best moves the time: it breaks ties (the earlier
          -- one wins), so playing on without climbing mustn't cost you.
          updated_at = case
            when excluded.best_floor > public.tower_progress.best_floor
              then now()
            else public.tower_progress.updated_at
          end;

    if exists (
      select 1 from public.titles t
       where t.metric = 'towerFloor' and not t.retired
         and t.goal > v_best and t.goal <= p_cleared
    ) then
      perform public.refresh_titles(p_user);
    end if;
  end if;

  -- The climb: only the one running (or, with no climb said, its floor).
  select * into v_prog from public.tower_progress
   where user_id = p_user and event_id = p_event
   for update;
  if found and (p_climb is null or p_climb = v_prog.climb) then
    v_floor := greatest(v_prog.climb_floor, coalesce(p_cleared, 0));
    v_boons := v_prog.boons;
    v_skips := v_prog.boon_skips;
    if p_climb is not null
       and (p_boons is not null or p_skips is not null)
       and array_position(p_boons, null) is null
       and coalesce(p_boons, '{}'::text[]) <@ public.tower_boon_keys()
       and coalesce(p_skips, v_prog.boon_skips) >= v_prog.boon_skips
       and cardinality(coalesce(p_boons, v_prog.boons))
           + coalesce(p_skips, v_prog.boon_skips) <= public.tower_boon_picks(v_floor)
    then
      v_boons := coalesce(p_boons, v_prog.boons);
      v_skips := coalesce(p_skips, v_prog.boon_skips);
    end if;
    update public.tower_progress
       set climb_floor = v_floor,
           boons = v_boons,
           boon_skips = v_skips
     where user_id = p_user and event_id = p_event;
  end if;

  insert into public.tower_daily (user_id, day) values (p_user, v_today)
  on conflict (user_id, day) do nothing;
  select * into v_daily from public.tower_daily
   where user_id = p_user and day = v_today
   for update;

  v_xp := greatest(0, least(coalesce(p_xp, 0), p_xp_cap - v_daily.xp));
  v_room := greatest(0, p_drop_cap - v_daily.drops);

  if v_xp > 0 then
    update public.herzies set pending_xp = pending_xp + v_xp
     where user_id = p_user;
  end if;

  foreach v_item in array coalesce(p_item_ids, '{}'::text[]) loop
    exit when v_room <= 0;
    continue when not exists (select 1 from public.items where id = v_item);
    insert into public.pending_drops (user_id, item_id, dropped_at, source_event)
    values (p_user, v_item, v_lands, p_event)
    returning id into v_id;
    v_drops := v_drops || jsonb_build_object('id', v_id, 'item', v_item);
    v_room := v_room - 1;
  end loop;

  update public.tower_daily
     set xp = xp + v_xp,
         drops = drops + jsonb_array_length(v_drops)
   where user_id = p_user and day = v_today;

  return jsonb_build_object('drops', v_drops);
end;
$$;

revoke execute on function public.tower_grant(uuid, uuid, text, integer, integer, text[], integer, integer, integer, text[], integer)
  from public, anon, authenticated;
