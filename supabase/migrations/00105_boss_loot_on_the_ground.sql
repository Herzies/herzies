-- Boss rewards are picked up, not handed over.
--
-- Until now settle_boss_fight credited rewards straight to the bank, and the
-- cave's loot drop (00104) was only a show: the item was already yours before
-- it hit the floor. Now a reward is a ground drop, a pending_drops row like
-- any listening drop, and picking it up in the cave (walking into it, or the
-- spirit fetching it) collects it through collect-drop, as on Home:
--
--  * nothing is lost: whatever isn't picked up in the cave waits on the
--    player's Home ground (pending drops never expire), for them or their
--    spirit;
--  * nothing is paid twice: collect_pending_drop's DELETE ... RETURNING is the
--    claim, and event_claims still keeps a second settle from dropping more;
--  * a full bank refuses the pickup, as it does on Home, instead of pushing
--    the bank over capacity.
--
-- The cave gets first go: a boss drop lands with `dropped_at` 90 seconds in
-- the future (the room stays open 45 after the kill), and the sync's spirit
-- auto-collect leaves alone anything that hasn't "landed" yet, so a spirit
-- can't sweep the loot up server-side before it has even appeared in the
-- cave. After that it's an ordinary drop.

ALTER TABLE public.pending_drops
  ADD COLUMN IF NOT EXISTS source_event uuid
    REFERENCES public.events(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS pending_drops_source_event_idx
  ON public.pending_drops (source_event)
  WHERE source_event IS NOT NULL;

-- Same as 00073 but for where a reward goes: on the ground, held for the cave.
CREATE OR REPLACE FUNCTION public.settle_boss_fight(p_event_id uuid DEFAULT NULL)
RETURNS int AS $$
DECLARE
  v_event       record;
  v_participant record;
  v_config      jsonb;
  v_base_item   text;
  v_top_item    text;
  v_top_count   int;
  v_paid        int := 0;
  v_lands       timestamptz := now() + interval '90 seconds';
BEGIN
  FOR v_event IN
    SELECT e.id, e.config
      FROM public.events e
      JOIN public.boss_state bs ON bs.event_id = e.id
     WHERE e.type = 'boss_fight'
       AND bs.killed
       AND NOT bs.settled
       AND (p_event_id IS NULL OR e.id = p_event_id)
  LOOP
    v_config    := v_event.config;
    v_base_item := v_config ->> 'rewardItemId';
    v_top_item  := v_config ->> 'topRewardItemId';
    v_top_count := COALESCE((v_config ->> 'topCount')::int, 3);

    FOR v_participant IN
      SELECT bd.user_id,
             row_number() OVER (ORDER BY bd.damage DESC, bd.user_id) AS rnk
        FROM public.boss_damage bd
       WHERE bd.event_id = v_event.id
         AND bd.damage > 0
    LOOP
      INSERT INTO public.event_claims (event_id, user_id)
      VALUES (v_event.id, v_participant.user_id)
      ON CONFLICT (event_id, user_id) DO NOTHING;

      -- Conflict means this player was already paid on an earlier run.
      IF NOT FOUND THEN
        CONTINUE;
      END IF;

      -- Top dealers get the base item AND the rarer one. The herzie check
      -- keeps grant_inventory_item's old "no herzie, no-op" behaviour.
      INSERT INTO public.pending_drops (user_id, item_id, dropped_at, source_event)
      SELECT v_participant.user_id, i.item_id, v_lands, v_event.id
        FROM (VALUES
                (1, v_base_item),
                (2, CASE WHEN v_participant.rnk <= v_top_count
                         THEN v_top_item END)
             ) AS i(n, item_id)
       WHERE i.item_id IS NOT NULL
         AND EXISTS (
           SELECT 1 FROM public.herzies h
            WHERE h.user_id = v_participant.user_id
         )
       ORDER BY i.n;

      v_paid := v_paid + 1;
    END LOOP;

    UPDATE public.boss_state SET settled = true WHERE event_id = v_event.id;
    UPDATE public.events SET active = false WHERE id = v_event.id;
  END LOOP;

  RETURN v_paid;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = '';

REVOKE EXECUTE ON FUNCTION public.settle_boss_fight(uuid)
  FROM PUBLIC, anon, authenticated;

-- A boss's loot still on the ground, for the cave to drop:
-- {"<uid>": [{"id": "<drop id>", "item": "<item id>"}, ...]}.
-- Replaces 00104's boss_rewards_json, which said what was paid but not which
-- drop to collect.
CREATE OR REPLACE FUNCTION public.boss_loot_json(p_event uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT COALESCE(jsonb_object_agg(per.user_id::text, per.drops), '{}'::jsonb)
    FROM (
      SELECT d.user_id,
             jsonb_agg(
               jsonb_build_object('id', d.id, 'item', d.item_id)
               ORDER BY d.item_id = (
                 SELECT e.config ->> 'rewardItemId'
                   FROM public.events e WHERE e.id = p_event
               ) DESC, d.id
             ) AS drops
        FROM public.pending_drops d
       WHERE d.source_event = p_event
       GROUP BY d.user_id
    ) per;
$$;

REVOKE EXECUTE ON FUNCTION public.boss_loot_json(uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.boss_loot_json(uuid) TO service_role;

DROP FUNCTION IF EXISTS public.boss_rewards_json(uuid);
