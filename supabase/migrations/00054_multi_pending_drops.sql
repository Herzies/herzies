-- Multiple simultaneous ground drops: the old single-slot pending_drop_*
-- columns on herzies could only ever hold one uncollected drop at a time
-- (roll_pending_drop no-op'd while one was pending). Replace with a
-- pending_drops table so drops keep accumulating on the ground instead of
-- blocking on pickup.

CREATE TABLE public.pending_drops (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.herzies(user_id) ON DELETE CASCADE,
  item_id text NOT NULL,
  dropped_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX pending_drops_user_id_idx ON public.pending_drops (user_id);

-- Carry over any drop that's currently sitting uncollected before the old
-- columns are dropped.
INSERT INTO public.pending_drops (user_id, item_id, dropped_at)
SELECT user_id, pending_drop_item_id, COALESCE(pending_drop_at, now())
FROM public.herzies
WHERE pending_drop_item_id IS NOT NULL;

ALTER TABLE public.herzies
  DROP COLUMN pending_drop_item_id,
  DROP COLUMN pending_drop_at;

-- Now inserts a new row every roll instead of filling a single slot — any
-- number of drops can be pending at once.
CREATE OR REPLACE FUNCTION public.roll_pending_drop(p_user_id uuid, p_item_id text)
RETURNS void AS $$
BEGIN
  INSERT INTO public.pending_drops (user_id, item_id)
  VALUES (p_user_id, p_item_id);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = '';

-- Arity changed (uuid -> uuid, uuid), so the old single-arg version has to be
-- dropped explicitly — CREATE OR REPLACE would just leave it callable
-- alongside the new one.
DROP FUNCTION IF EXISTS public.collect_pending_drop(uuid);

-- Atomically claims + grants + removes one specific pending drop by id.
-- Returns the granted item id, or NULL if that drop no longer exists (already
-- collected, e.g. by a racing Spirit Orb auto-collect or a duplicate click).
CREATE OR REPLACE FUNCTION public.collect_pending_drop(p_user_id uuid, p_drop_id uuid)
RETURNS text AS $$
DECLARE
  v_item_id text;
BEGIN
  DELETE FROM public.pending_drops
  WHERE id = p_drop_id AND user_id = p_user_id
  RETURNING item_id INTO v_item_id;

  IF v_item_id IS NULL THEN
    RETURN NULL;
  END IF;

  UPDATE public.herzies
  SET inventory_v2 = jsonb_set(
        inventory_v2,
        ARRAY[v_item_id],
        to_jsonb(COALESCE((inventory_v2->>v_item_id)::int, 0) + 1)
      )
  WHERE user_id = p_user_id;

  RETURN v_item_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = '';

-- CREATE OR REPLACE re-grants EXECUTE to PUBLIC — revoke explicitly for all
-- three roles, same as 00053 (see 00052 for why relying on ordering alone
-- doesn't work).
REVOKE EXECUTE ON FUNCTION public.roll_pending_drop(uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.collect_pending_drop(uuid, uuid) FROM PUBLIC, anon, authenticated;

-- pending_drops itself is only ever touched via the SECURITY DEFINER
-- functions above (service-role admin client calls those; nothing queries
-- the table directly from client code) — lock it down the same way the rest
-- of the schema is, matching herzies' own RLS posture.
ALTER TABLE public.pending_drops ENABLE ROW LEVEL SECURITY;
