-- Risky upgrades get harder: +6→+7 70%→60%, +7→+8 55%→45%, +8→+9 40%→30%,
-- +9→+10 25%→20%. A clean run from +6 to +10 goes from ~3.8% to ~1.6%.
--
-- Same function as 00086 with only the odds changed; same signature, so
-- CREATE OR REPLACE keeps it in place. The revoke is re-applied anyway, same
-- as every other redefinition of a locked-down RPC.
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

  -- UPGRADE_SUCCESS_CHANCE (packages/shared/src/items.ts), by hand.
  v_chance := case v_target.upgrade_level
    when 6 then 0.6
    when 7 then 0.45
    when 8 then 0.3
    when 9 then 0.2
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
