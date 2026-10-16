-- Classes, mirroring packages/shared/src/classes.ts and skills.ts.
--
-- A herzie picks one class, once, on reaching stage 2: Bard (support),
-- Record Slinger (DPS) or Percussionist (tank). The choice is permanent.
-- Picking it hands over the class's equipment, already worn, and its first
-- skill at level 1.
--
-- Class equipment is held: two new slots, 'main_hand' and 'off_hand'.
-- equip_unit needs only the class check (a slot other than 'ground' is used
-- as-is, as with 'spirit' in 00099). Class items are soulbound: no sell
-- price, and trade_offer_unit_ids refuses them, so a permanent class can
-- never end up without its gear.

alter table public.herzies
  add column if not exists class text
  check (class is null or class in ('bard', 'record_slinger', 'percussionist'));

alter table public.items
  add column if not exists required_class text
  check (required_class is null or required_class in ('bard', 'record_slinger', 'percussionist'));

alter table public.items drop constraint items_equip_slot_check;
alter table public.items add constraint items_equip_slot_check
  check (equip_slot is null or equip_slot in (
    'head', 'face', 'body', 'scenery', 'ground', 'spirit', 'color', 'modifier',
    'main_hand', 'off_hand'
  ));

alter table public.item_units drop constraint item_units_equipped_slot_check;
alter table public.item_units add constraint item_units_equipped_slot_check
  check (equipped_slot is null or equipped_slot in (
    'head', 'face', 'body', 'scenery', 'ground_left', 'ground_right',
    'spirit', 'color', 'modifier', 'main_hand', 'off_hand'
  ));

INSERT INTO public.items (id, name, description, rarity, sell_price, buy_price, stackable, equipable, equip_slot, min_stage, required_class)
VALUES
  ('lute', 'Lute', 'Every Bard''s first love. Slightly out of tune.',
   'common', NULL, NULL, false, true, 'main_hand', 2, 'bard'),
  ('compact-discs', 'Compact Discs', 'One for each hand. Scratched, but they fly true.',
   'common', NULL, NULL, false, true, 'main_hand', 2, 'record_slinger'),
  ('worn-stick', 'Worn Stick', 'Chipped from a thousand rimshots.',
   'common', NULL, NULL, false, true, 'main_hand', 2, 'percussionist'),
  ('old-cymbal', 'Old Cymbal', 'Dented, green at the edges, still rings.',
   'common', NULL, NULL, false, true, 'off_hand', 2, 'percussionist')
ON CONFLICT (id) DO NOTHING;

-- One row per skill a herzie knows. Written only by security-definer
-- functions (choose_class, apply_skill_xp_batch); read through the service
-- role. RLS on with no policies, like item_units.
create table if not exists public.herzie_skills (
  user_id  uuid not null references public.herzies(user_id) on delete cascade,
  skill_id text not null,
  -- 10 is SKILL_MAX_LEVEL (packages/shared/src/skills.ts).
  level    int not null default 1 check (level between 1 and 10),
  xp       bigint not null default 0 check (xp >= 0),
  primary key (user_id, skill_id)
);
alter table public.herzie_skills enable row level security;
revoke all on public.herzie_skills from anon, authenticated;

-- Same as 00095's equip_unit, plus the class check.
create or replace function public.equip_unit(
  p_user_id uuid,
  p_unit_id uuid,
  p_action text,
  p_side text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_unit public.item_units;
  v_equipable boolean;
  v_equip_slot text;
  v_min_stage int;
  v_required_class text;
  v_stage int;
  v_class text;
  v_slot text;
  v_others int;
begin
  select stage, class into v_stage, v_class
    from public.herzies where user_id = p_user_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'not-found');
  end if;

  select * into v_unit
    from public.item_units
   where id = p_unit_id and user_id = p_user_id;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'not-owned');
  end if;

  if p_action = 'unequip' then
    if v_unit.equipped_slot is null then
      return jsonb_build_object('ok', false, 'reason', 'not-equipped');
    end if;
    update public.item_units
       set equipped_slot = null, equipped_at = null
     where id = p_unit_id;
    return jsonb_build_object('ok', true, 'state', public.item_state(p_user_id));
  end if;

  if p_action <> 'equip' then
    return jsonb_build_object('ok', false, 'reason', 'bad-action');
  end if;

  select equipable, equip_slot, min_stage, required_class
    into v_equipable, v_equip_slot, v_min_stage, v_required_class
    from public.items where id = v_unit.item_id;
  if not coalesce(v_equipable, false) or v_equip_slot is null then
    return jsonb_build_object('ok', false, 'reason', 'no-slot');
  end if;

  if v_stage < coalesce(v_min_stage, 1) then
    return jsonb_build_object('ok', false, 'reason', 'stage-too-low');
  end if;

  if v_required_class is not null and v_class is distinct from v_required_class then
    return jsonb_build_object('ok', false, 'reason', 'class-required');
  end if;

  if v_equip_slot = 'ground' then
    if p_side is null or p_side not in ('left', 'right') then
      return jsonb_build_object('ok', false, 'reason', 'missing-side');
    end if;
    v_slot := 'ground_' || p_side;
  else
    v_slot := v_equip_slot;
  end if;

  if v_unit.equipped_slot is not distinct from v_slot then
    return jsonb_build_object('ok', false, 'reason', 'already-equipped');
  end if;

  -- Checked before anything is changed: this function returns normally on a
  -- rejection, so a partial change would be committed, not rolled back.
  if v_slot = 'modifier' then
    select count(*) into v_others
      from public.item_units
     where user_id = p_user_id
       and equipped_slot = 'modifier'
       and item_id <> v_unit.item_id;
    -- 6 is MAX_MODIFIERS (packages/shared/src/items.ts).
    if v_others >= 6 then
      return jsonb_build_object('ok', false, 'reason', 'max-modifiers');
    end if;
  end if;

  -- Free whichever copy of this item is currently worn (which may be this one,
  -- being moved between ground sides).
  update public.item_units
     set equipped_slot = null, equipped_at = null
   where user_id = p_user_id
     and item_id = v_unit.item_id
     and equipped_slot is not null;

  -- Displace the incumbent of a single-value slot.
  if v_slot <> 'modifier' then
    update public.item_units
       set equipped_slot = null, equipped_at = null
     where user_id = p_user_id and equipped_slot = v_slot;
  end if;

  update public.item_units
     set equipped_slot = v_slot, equipped_at = now()
   where id = p_unit_id;

  return jsonb_build_object('ok', true, 'state', public.item_state(p_user_id));
end;
$$;

-- Pick a class. Once only, from stage 2. The equipment arrives worn, so a
-- full bag can't get in the way, and the class's first skill starts at
-- level 1. Calling it again with the class already chosen returns ok with
-- `already` set and changes nothing, so a retried request is harmless.
--
-- The starter skill per class mirrors CLASS_DEFS (packages/shared/src/classes.ts).
create or replace function public.choose_class(p_user_id uuid, p_class text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_stage int;
  v_class text;
  v_skill text;
begin
  select stage, class into v_stage, v_class
    from public.herzies where user_id = p_user_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'not-found');
  end if;

  if p_class is null or p_class not in ('bard', 'record_slinger', 'percussionist') then
    return jsonb_build_object('ok', false, 'reason', 'bad-class');
  end if;

  if v_class is not null then
    if v_class = p_class then
      return jsonb_build_object('ok', true, 'already', true, 'class', v_class,
        'state', public.item_state(p_user_id));
    end if;
    return jsonb_build_object('ok', false, 'reason', 'already-chosen');
  end if;

  if v_stage < 2 then
    return jsonb_build_object('ok', false, 'reason', 'stage-too-low');
  end if;

  v_skill := case p_class
    when 'bard' then 'soothing-drones'
    when 'record_slinger' then 'backspin'
    when 'percussionist' then 'cymbrella'
  end;

  update public.herzies set class = p_class where user_id = p_user_id;

  insert into public.herzie_skills (user_id, skill_id)
  values (p_user_id, v_skill)
  on conflict do nothing;

  -- Whatever sits in the hand slots now comes off (nothing can yet: these
  -- items are the only ones that fit, and they need a class).
  update public.item_units
     set equipped_slot = null, equipped_at = null
   where user_id = p_user_id and equipped_slot in ('main_hand', 'off_hand');

  insert into public.item_units (user_id, item_id, equipped_slot, equipped_at)
  select p_user_id, i.id, i.equip_slot, now()
    from public.items i
   where i.required_class = p_class;

  return jsonb_build_object('ok', true, 'already', false, 'class', p_class,
    'state', public.item_state(p_user_id));
end;
$$;

-- Same as 00079's, except class items can't be offered: they're bound to the
-- herzie that chose the class.
create or replace function public.trade_offer_unit_ids(p_offer jsonb, p_user_id uuid)
returns uuid[]
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ids uuid[];
  v_key text;
  v_qty int;
  v_picked uuid[];
begin
  if jsonb_typeof(p_offer -> 'units') = 'array' then
    select coalesce(array_agg(x.uid), '{}'::uuid[]) into v_ids
      from (select distinct (e ->> 'unitId')::uuid as uid
              from jsonb_array_elements(p_offer -> 'units') e) x;

    -- Every offered copy must still be theirs, not worn and not bound to a
    -- class.
    if (select count(*) from public.item_units u
         where u.id = any(v_ids) and u.user_id = p_user_id
           and u.equipped_slot is null
           and not exists (select 1 from public.items i
                            where i.id = u.item_id and i.required_class is not null))
       <> cardinality(v_ids) then
      return null;
    end if;
    return v_ids;
  end if;

  v_ids := '{}'::uuid[];
  for v_key, v_qty in
    select s.k, s.q
      from (select x.k,
                   case when x.v ~ '^[0-9]+$' then x.v::int else 0 end as q
              from jsonb_each_text(
                     coalesce(p_offer -> 'items', '{}'::jsonb)) as x(k, v)) s
     where s.q > 0
  loop
    if exists (select 1 from public.items
                where id = v_key and required_class is not null) then
      return null;
    end if;
    select coalesce(array_agg(id), '{}'::uuid[]) into v_picked
      from (select id from public.item_units
             where user_id = p_user_id and item_id = v_key and equipped_slot is null
             order by upgrade_level, acquired_at, id
             limit v_qty) s;
    if cardinality(v_picked) < v_qty then
      return null;
    end if;
    v_ids := v_ids || v_picked;
  end loop;
  return v_ids;
end;
$$;

revoke execute on function public.equip_unit(uuid, uuid, text, text) from public, anon, authenticated;
revoke execute on function public.choose_class(uuid, text) from public, anon, authenticated;
revoke execute on function public.trade_offer_unit_ids(jsonb, uuid) from public, anon, authenticated;
