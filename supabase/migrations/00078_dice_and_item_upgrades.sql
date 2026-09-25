-- "Dice" item type: an item that modifies another item rather than being
-- worn. Power Dice 1 is the first — applying it to a statted card bumps
-- every stat that card's catalog entry defines by 1, up to 3 times per
-- card, consuming one die per use.
--
-- item_upgrades is the DB-state half (itemId -> level 0-3); the TS catalog
-- (packages/shared/src/items.ts) holds the other half — which items are
-- dice, which are statted, what "stats" values exist — the same split
-- inventory_v2/equipped already have with the catalog.

ALTER TABLE public.herzies
  ADD COLUMN IF NOT EXISTS item_upgrades jsonb NOT NULL DEFAULT '{}';

-- Catalog row so power-dice-1 can actually be sold and can enter the
-- world-drop pool (filterDroppablePool/collect-drop both source from this
-- table, not the TS catalog). Not equipable — dice open the upgrade-target
-- picker on click instead (see InventoryView.handleGridClick).
INSERT INTO public.items (id, name, description, rarity, sell_price, buy_price, stackable, equipable, equip_slot)
VALUES (
  'power-dice-1',
  'Power Dice 1',
  'Roll it onto a statted card to bump every one of that card''s stats by 1. Up to 3 rolls per card.',
  'rare',
  200,
  NULL,
  true,
  false,
  NULL
)
ON CONFLICT (id) DO NOTHING;

-- Atomically consumes one dice from inventory_v2 and bumps
-- item_upgrades[target] by one level, all-or-nothing. Ownership/quantity/
-- level-cap are the only things checked here — "is p_target_item_id a
-- statted card" can't be checked in SQL (stats live only in the TS
-- catalog), so packages/web/src/app/api/inventory/upgrade/route.ts checks
-- that before calling this.
CREATE OR REPLACE FUNCTION public.apply_item_upgrade(
  p_user_id uuid,
  p_dice_item_id text,
  p_target_item_id text
)
RETURNS TABLE(ok boolean, reason text, new_level int) AS $$
DECLARE
  v_inv      jsonb;
  v_upgrades jsonb;
  v_dice_qty int;
  v_targ_qty int;
  v_level    int;
BEGIN
  SELECT inventory_v2, item_upgrades INTO v_inv, v_upgrades
    FROM public.herzies
   WHERE user_id = p_user_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RETURN QUERY SELECT false, 'not-found'::text, NULL::int;
    RETURN;
  END IF;

  v_dice_qty := COALESCE((v_inv->>p_dice_item_id)::int, 0);
  IF v_dice_qty < 1 THEN
    RETURN QUERY SELECT false, 'dice-not-owned'::text, NULL::int;
    RETURN;
  END IF;

  v_targ_qty := COALESCE((v_inv->>p_target_item_id)::int, 0);
  IF v_targ_qty < 1 THEN
    RETURN QUERY SELECT false, 'target-not-owned'::text, NULL::int;
    RETURN;
  END IF;

  v_level := COALESCE((v_upgrades->>p_target_item_id)::int, 0);
  -- 3 is MAX_ITEM_UPGRADE_LEVEL (packages/shared/src/items.ts) — this SQL
  -- function can't import that constant, so the two must stay in sync by
  -- hand (same arrangement as GROUND_DROP_CAP/BANK_SLOT_COUNT).
  IF v_level >= 3 THEN
    RETURN QUERY SELECT false, 'max-level'::text, NULL::int;
    RETURN;
  END IF;

  IF v_dice_qty - 1 > 0 THEN
    v_inv := jsonb_set(v_inv, ARRAY[p_dice_item_id], to_jsonb(v_dice_qty - 1));
  ELSE
    v_inv := v_inv - p_dice_item_id;
  END IF;
  v_level := v_level + 1;
  v_upgrades := jsonb_set(v_upgrades, ARRAY[p_target_item_id], to_jsonb(v_level));

  UPDATE public.herzies
     SET inventory_v2 = v_inv, item_upgrades = v_upgrades
   WHERE user_id = p_user_id;

  RETURN QUERY SELECT true, NULL::text, v_level;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = '';

REVOKE EXECUTE ON FUNCTION public.apply_item_upgrade(uuid, text, text) FROM PUBLIC, anon, authenticated;

-- Prune item_upgrades on execute_trade: without this, upgrading a card then
-- trading away every copy leaves the seller's level entry in place (a free
-- re-upgrade on reacquiring the id later) while the buyer's incoming copy
-- arrives at level 0.
--
-- WHY THIS IS A DO BLOCK AND NOT A CREATE OR REPLACE:
--
-- Same reasoning as 00059_execute_trade_expiry_guard.sql: the function body
-- is ~70 lines of inventory/currency arithmetic, and hand-retyping it once
-- already silently dropped a step and corrupted inventories. This reads the
-- live definition out of pg_proc and appends two statements right after the
-- fixed anchor (the final pair of inventory/currency UPDATEs), which cannot
-- drift from whatever 00008/00059/etc. actually installed. Idempotent, and
-- fails loudly rather than silently if the anchor is ever edited away.
do $$
declare
  src    text;
  anchor text := '  UPDATE public.herzies SET inventory_v2 = targ_inv, currency = targ_currency WHERE user_id = t.target_id;';
  guard  text :=
    '  UPDATE public.herzies SET item_upgrades = (SELECT COALESCE(jsonb_object_agg(k, v), ''{}''::jsonb) FROM jsonb_each((SELECT item_upgrades FROM public.herzies WHERE user_id = t.initiator_id)) AS x(k, v) WHERE init_inv ? k) WHERE user_id = t.initiator_id;' || E'\n' ||
    '  UPDATE public.herzies SET item_upgrades = (SELECT COALESCE(jsonb_object_agg(k, v), ''{}''::jsonb) FROM jsonb_each((SELECT item_upgrades FROM public.herzies WHERE user_id = t.target_id)) AS x(k, v) WHERE targ_inv ? k) WHERE user_id = t.target_id;';
begin
  select p.prosrc into src
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'execute_trade';

  if src is null then
    raise exception 'execute_trade() not found — expected 00008 to have created it';
  end if;

  if position('item_upgrades = (SELECT COALESCE' in src) > 0 then
    raise notice 'execute_trade() already prunes item_upgrades; nothing to do';
    return;
  end if;

  if position(anchor in src) = 0 then
    raise exception 'anchor line not found in execute_trade(); refusing to guess where the guard belongs — likely drifted from what this migration expects, patch by hand instead';
  end if;

  src := replace(src, anchor, anchor || E'\n' || guard);

  execute format(
    'CREATE OR REPLACE FUNCTION public.execute_trade(trade_id uuid) '
    'RETURNS boolean AS %L LANGUAGE plpgsql SECURITY DEFINER SET search_path = %L',
    src, ''
  );
end;
$$;

-- CREATE OR REPLACE re-grants EXECUTE to anon/authenticated, so re-apply the
-- 00052 lockdown, same as 00059 does after its own splice.
REVOKE EXECUTE ON FUNCTION public.execute_trade(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.execute_trade(uuid) TO authenticated;
