-- Spirit Orb: a legendary ground-slot pet, matching the new 'spirit-orb'
-- entry in packages/shared/src/items.ts. Equipping it auto-collects pending
-- world drops (see roll_pending_drop/collect_pending_drop below).
INSERT INTO public.items (id, name, description, rarity, sell_price, buy_price, stackable, equipable, equip_slot)
VALUES (
  'spirit-orb',
  'Spirit Orb',
  'A small round spirit that watches over your herzie. Automatically collects drops for you.',
  'legendary',
  500,
  50000,
  false,
  true,
  'ground'
)
ON CONFLICT (id) DO NOTHING;

-- World-drop state: at most one pending drop per herzie at a time, persisted
-- until collected. drop_rolls_done tracks how many 10-minute listening ticks
-- have already been rolled against, mirroring cds_granted's role for CDs.
ALTER TABLE public.herzies
  ADD COLUMN IF NOT EXISTS drop_rolls_done integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS pending_drop_item_id text,
  ADD COLUMN IF NOT EXISTS pending_drop_at timestamptz;

-- Sets the pending drop only if the slot is empty — never overwrites an
-- uncollected drop. No-op (silently) if one is already pending.
CREATE OR REPLACE FUNCTION public.roll_pending_drop(p_user_id uuid, p_item_id text)
RETURNS void AS $$
BEGIN
  UPDATE public.herzies
  SET pending_drop_item_id = p_item_id,
      pending_drop_at = now()
  WHERE user_id = p_user_id AND pending_drop_item_id IS NULL;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = '';

-- Atomically claims + grants + clears the pending drop in one transaction.
-- Returns the granted item id, or NULL if nothing was pending. The row lock
-- from SELECT ... FOR UPDATE means a concurrent caller (e.g. the Spirit Orb
-- auto-collect racing a manual /collect-drop call) blocks until this
-- transaction commits, then sees pending_drop_item_id already cleared and
-- returns NULL instead of double-granting.
CREATE OR REPLACE FUNCTION public.collect_pending_drop(p_user_id uuid)
RETURNS text AS $$
DECLARE
  v_item_id text;
BEGIN
  SELECT pending_drop_item_id INTO v_item_id
  FROM public.herzies
  WHERE user_id = p_user_id
  FOR UPDATE;

  IF v_item_id IS NULL THEN
    RETURN NULL;
  END IF;

  UPDATE public.herzies
  SET inventory_v2 = jsonb_set(
        inventory_v2,
        ARRAY[v_item_id],
        to_jsonb(COALESCE((inventory_v2->>v_item_id)::int, 0) + 1)
      ),
      pending_drop_item_id = NULL,
      pending_drop_at = NULL
  WHERE user_id = p_user_id;

  RETURN v_item_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = '';

-- CREATE OR REPLACE FUNCTION auto-grants EXECUTE to PUBLIC — revoke
-- explicitly for all three roles so these can't be called directly by
-- unauthenticated/authenticated clients, only by server code via the
-- service-role admin client (see 00052 for why relying on ordering alone
-- doesn't work).
REVOKE EXECUTE ON FUNCTION public.roll_pending_drop(uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.collect_pending_drop(uuid) FROM PUBLIC, anon, authenticated;
