-- The first body-slot items: Certified Drip (gold chain), Clam's Finest
-- (pearl necklace) and Black Tie Optional (bowtie). Mirrors the new entries in
-- packages/shared/src/items.ts; the spheres are built in creature-renderer.ts.
--
-- They're also the first stage-gated items. items.min_stage is the stage a
-- herzie must have reached to wear an item (ItemDef.minStage); body items are
-- 3, since neckwear sits where the head meets the body and a herzie only
-- grows a body at stage 3. equip_unit refuses an equip below it. Already-worn
-- items are never taken off: stages only go up.
--
-- No buy_price: like the head cosmetics they are earned, not bought, so they
-- join the drop pool at their rarity's weight and stay out of the shop.
ALTER TABLE public.items
  ADD COLUMN IF NOT EXISTS min_stage integer
  CHECK (min_stage IS NULL OR (min_stage >= 1 AND min_stage <= 3));

INSERT INTO public.items (id, name, description, rarity, sell_price, buy_price, stackable, equipable, equip_slot, min_stage)
VALUES
  (
    'gold-chain',
    'Certified Drip',
    'Heavy gold around the neck. Your herzie has gone platinum.',
    'rare',
    250,
    NULL,
    false,
    true,
    'body',
    3
  ),
  (
    'pearl-necklace',
    'Clam''s Finest',
    'A string of pearls, for the herzie with refined taste.',
    'uncommon',
    100,
    NULL,
    false,
    true,
    'body',
    3
  ),
  (
    'bowtie',
    'Black Tie Optional',
    'Ignored the dress code anyway. Red bowtie, front and centre.',
    'uncommon',
    100,
    NULL,
    false,
    true,
    'body',
    3
  )
ON CONFLICT (id) DO NOTHING;

-- Same as 00079's equip_unit, plus the min_stage check. The herzie row it
-- already locks is where the stage comes from.
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
  v_stage int;
  v_slot text;
  v_others int;
begin
  select stage into v_stage
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

  select equipable, equip_slot, min_stage
    into v_equipable, v_equip_slot, v_min_stage
    from public.items where id = v_unit.item_id;
  if not coalesce(v_equipable, false) or v_equip_slot is null then
    return jsonb_build_object('ok', false, 'reason', 'no-slot');
  end if;

  if v_stage < coalesce(v_min_stage, 1) then
    return jsonb_build_object('ok', false, 'reason', 'stage-too-low');
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
