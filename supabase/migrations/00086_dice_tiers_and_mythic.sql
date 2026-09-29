-- Dice tiers, the Mythic rarity, risky upgrades and the Safety Pick.
--
-- Cards now upgrade to +10 instead of +3, and each band needs its own die:
--   +0 → +3  Power Dice 1 (rare)
--   +3 → +6  Power Dice 2 (legendary)
--   +6 → +10 Power Dice 3 (mythic — a new rarity ranked ABOVE legendary)
-- Upgrades from +6 on can fail. A failed roll destroys the card unless a
-- Safety Pick is spent with it, in which case the card keeps its level. The
-- die is spent either way; the pick is spent on every risky roll it joins,
-- success or not.
--
-- DEPLOY: safe to apply ahead of the web deploy. The live API route calls
-- apply_item_upgrade with three named args, and the two new ones default.
-- Older code also never rolls the new rows as drops: filterDroppablePool
-- skips ids its catalog doesn't know and rarities with no drop weight.
-- Power Dice 3 (the one mythic item) lives in 00087.

-- ---------------------------------------------------------------------------
-- Constraints. Both were declared inline (00001 / 00079), so their names are
-- Postgres-generated; look them up by column rather than trusting the name.
-- ---------------------------------------------------------------------------
do $$
declare
  c record;
begin
  for c in
    select con.conrelid::regclass as tbl, con.conname
      from pg_constraint con
      join pg_attribute att
        on att.attrelid = con.conrelid and att.attnum = any (con.conkey)
     where con.contype = 'c'
       and (
         (con.conrelid = 'public.items'::regclass and att.attname = 'rarity')
         or (con.conrelid = 'public.item_units'::regclass and att.attname = 'upgrade_level')
       )
  loop
    execute format('alter table %s drop constraint %I', c.tbl, c.conname);
  end loop;
end;
$$;

alter table public.items
  add constraint items_rarity_check
  check (rarity in ('common', 'uncommon', 'rare', 'legendary', 'mythic'));

-- 10 is MAX_ITEM_UPGRADE_LEVEL (packages/shared/src/items.ts), kept in sync by
-- hand like GROUND_DROP_CAP and BANK_SLOT_COUNT.
alter table public.item_units
  add constraint item_units_upgrade_level_check
  check (upgrade_level between 0 and 10);

-- ---------------------------------------------------------------------------
-- Catalog rows, so the new items can be sold, granted as event rewards and
-- enter the world-drop pool (which reads this table, not the TS catalog).
-- power-dice-3 is added in 00087.
-- ---------------------------------------------------------------------------
insert into public.items (id, name, description, rarity, sell_price, buy_price, stackable, equipable, equip_slot)
values
  ('power-dice-2', 'Power Dice 2',
   'Roll it onto a +3 card or better to bump every one of its stats by 1. Takes a card from +3 up to +6.',
   'legendary', 600, null, true, false, null),
  ('safety-pick', 'Safety Pick',
   'Hold it while you roll. If the upgrade fails, your card survives. The pick doesn''t.',
   'legendary', 400, null, true, false, null)
on conflict (id) do nothing;

update public.items
   set description = 'Roll it onto a statted card to bump every one of that card''s stats by 1. Takes a card from +0 up to +3.'
 where id = 'power-dice-1';

-- ---------------------------------------------------------------------------
-- apply_item_upgrade: tiered dice, the roll, and protection.
-- ---------------------------------------------------------------------------
drop function if exists public.apply_item_upgrade(uuid, text, uuid);

-- Check order matches applyItemUpgrade (packages/shared/src/items.ts):
-- dice-not-owned → target-not-owned → max-level → wrong-dice →
-- protection-not-owned. Nothing is consumed until every check has passed.
-- "Is this a dice / a statted card" still can't be checked here (the TS
-- catalog holds those), so the API route checks them before calling this.
--
-- p_roll exists only so integration tests can force an outcome. It is not a
-- hole: EXECUTE is revoked from anon and authenticated below, so only the
-- service role can call this at all, and the API route never passes it.
create or replace function public.apply_item_upgrade(
  p_user_id uuid,
  p_dice_item_id text,
  p_target_unit_id uuid,
  p_protection_item_id text default null,
  p_roll double precision default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_target  public.item_units;
  v_dice_id uuid;
  v_pick_id uuid;
  v_needed  text;
  v_chance  double precision;
  v_result  text;
  v_new     int;
begin
  perform 1 from public.herzies where user_id = p_user_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'not-found');
  end if;

  select id into v_dice_id
    from public.item_units
   where user_id = p_user_id and item_id = p_dice_item_id and equipped_slot is null
   order by acquired_at, id
   limit 1;
  if v_dice_id is null then
    return jsonb_build_object('ok', false, 'reason', 'dice-not-owned');
  end if;

  select * into v_target
    from public.item_units
   where id = p_target_unit_id and user_id = p_user_id;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'target-not-owned');
  end if;

  -- 10 is MAX_ITEM_UPGRADE_LEVEL.
  if v_target.upgrade_level >= 10 then
    return jsonb_build_object('ok', false, 'reason', 'max-level');
  end if;

  -- DICE_TIERS, by hand.
  v_needed := case
    when v_target.upgrade_level < 3 then 'power-dice-1'
    when v_target.upgrade_level < 6 then 'power-dice-2'
    else 'power-dice-3'
  end;
  if p_dice_item_id <> v_needed then
    return jsonb_build_object('ok', false, 'reason', 'wrong-dice', 'needed', v_needed);
  end if;

  -- UPGRADE_SUCCESS_CHANCE, by hand.
  v_chance := case v_target.upgrade_level
    when 6 then 0.7
    when 7 then 0.55
    when 8 then 0.4
    when 9 then 0.25
    else 1
  end;

  -- A pick only matters on a risky roll; on a safe one it's ignored, never
  -- spent.
  if v_chance < 1 and p_protection_item_id is not null then
    select id into v_pick_id
      from public.item_units
     where user_id = p_user_id and item_id = p_protection_item_id
       and item_id = 'safety-pick' and equipped_slot is null
     order by acquired_at, id
     limit 1;
    if v_pick_id is null then
      return jsonb_build_object('ok', false, 'reason', 'protection-not-owned');
    end if;
  end if;

  if coalesce(p_roll, random()) < v_chance then
    v_result := 'upgraded';
  elsif v_pick_id is not null then
    v_result := 'kept';
  else
    v_result := 'destroyed';
  end if;

  delete from public.item_units where id in (v_dice_id, v_pick_id);

  if v_result = 'upgraded' then
    update public.item_units
       set upgrade_level = upgrade_level + 1
     where id = p_target_unit_id
    returning upgrade_level into v_new;
  elsif v_result = 'kept' then
    v_new := v_target.upgrade_level;
  else
    -- Worn or not, the card is gone; the projection trigger clears its slot.
    delete from public.item_units where id = p_target_unit_id;
    v_new := v_target.upgrade_level;
  end if;

  return jsonb_build_object(
    'ok', true,
    'result', v_result,
    'newLevel', v_new,
    'chance', v_chance,
    'protected', v_pick_id is not null,
    'state', public.item_state(p_user_id));
end;
$$;

revoke execute on function public.apply_item_upgrade(uuid, text, uuid, text, double precision)
  from public, anon, authenticated;
