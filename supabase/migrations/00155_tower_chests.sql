-- The Tower's chests: every 10th floor (the Warden's), cleared, leaves a
-- chest in the hall that opens as the herzie walks up to it (the Town
-- server judges that; TOWER_CHEST in packages/shared/src/tower.ts). Its
-- items are rolled by town-vitals like a kill's drop, leaning rarer
-- (towerLootLean), and land here once per floor per herzie per Tower event.
--
-- Unlike a kill's drop they're outside the day's drop cap (tower_daily):
-- a chest is a milestone, at most one per ten floors climbed, and a herzie
-- comes back to a Tower one floor past their best, so none is opened twice.
-- tower_chests is what makes sure of that, whatever the room sends.

create table if not exists public.tower_chests (
  user_id   uuid not null references auth.users(id) on delete cascade,
  event_id  uuid not null references public.events(id) on delete cascade,
  floor     integer not null check (floor > 0 and floor % 10 = 0),
  opened_at timestamptz not null default now(),
  primary key (user_id, event_id, floor)
);
alter table public.tower_chests enable row level security;
revoke all on public.tower_chests from anon, authenticated;

-- ---------------------------------------------------------------------------
-- tower_chest_grant — opens `p_user`'s chest on `p_floor` of Tower
-- `p_event` (town-vitals, after tower_grant has recorded the batch's
-- clears): `p_item_ids` land as pending drops, dated 90 seconds ahead as
-- tower_grant's are (so a worn spirit doesn't fetch them from home before
-- the herzie sees them tossed out of the chest). Nothing for a floor that
-- isn't a 10th, one the herzie hasn't cleared in this Tower, or a chest
-- already opened (a replay).
--
-- Returns [{ id, item }]: what landed, for the Tower to toss out.
-- ---------------------------------------------------------------------------
create or replace function public.tower_chest_grant(
  p_user     uuid,
  p_event    uuid,
  p_floor    integer,
  p_item_ids text[]
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_drops jsonb;
begin
  if coalesce(array_length(p_item_ids, 1), 0) > 10 then
    raise exception 'too many chest items';
  end if;
  if p_floor is null or p_floor <= 0 or p_floor % 10 <> 0 then
    return '[]'::jsonb;
  end if;
  if not exists (select 1 from public.herzies where user_id = p_user)
     or not exists (
       select 1 from public.tower_progress
        where user_id = p_user and event_id = p_event
          and best_floor >= p_floor
     ) then
    return '[]'::jsonb;
  end if;

  insert into public.tower_chests (user_id, event_id, floor)
  values (p_user, p_event, p_floor)
  on conflict do nothing;
  if not found then
    return '[]'::jsonb;
  end if;

  with ins as (
    insert into public.pending_drops (user_id, item_id, dropped_at, source_event)
    select p_user, x, now() + interval '90 seconds', p_event
      from unnest(coalesce(p_item_ids, '{}')) x
     where exists (select 1 from public.items i where i.id = x)
    returning id, item_id
  )
  select coalesce(jsonb_agg(jsonb_build_object('id', id, 'item', item_id)),
                  '[]'::jsonb)
    into v_drops
    from ins;

  return v_drops;
end;
$$;

revoke execute on function public.tower_chest_grant(uuid, uuid, integer, text[])
  from public, anon, authenticated;
