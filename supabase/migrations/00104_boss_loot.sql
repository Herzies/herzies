-- What each herzie got for a boss, so the cave can drop it at their feet.
--
-- The Town server settles a boss the moment it falls (town-vitals calls
-- settle_boss_fight on the report that killed it, rather than waiting up to a
-- minute for the cron, which stays as the backstop). The rewards are already
-- in everyone's bank by then; this only says what they were, for the drop
-- the cave shows. It mirrors settle_boss_fight's rule (00073): the base item
-- for everyone who dealt damage, and the rarer one on top for the top dealers.
--
-- Returns {"<uid>": ["<item id>", ...]} for the herzies that were paid, or
-- {} while the boss isn't settled.
CREATE OR REPLACE FUNCTION public.boss_rewards_json(p_event uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  WITH ev AS (
    SELECT e.config ->> 'rewardItemId'                    AS base_item,
           e.config ->> 'topRewardItemId'                 AS top_item,
           COALESCE((e.config ->> 'topCount')::int, 3)    AS top_count
      FROM public.events e
      JOIN public.boss_state bs ON bs.event_id = e.id
     WHERE e.id = p_event
       AND e.type = 'boss_fight'
       AND bs.settled
  ),
  ranked AS (
    SELECT bd.user_id,
           row_number() OVER (ORDER BY bd.damage DESC, bd.user_id) AS rnk
      FROM public.boss_damage bd
     WHERE bd.event_id = p_event
       AND bd.damage > 0
  )
  SELECT COALESCE(jsonb_object_agg(r.user_id::text, items.list), '{}'::jsonb)
    FROM ranked r
    JOIN public.event_claims c
      ON c.event_id = p_event AND c.user_id = r.user_id
   CROSS JOIN ev
   CROSS JOIN LATERAL (
     SELECT to_jsonb(array_remove(ARRAY[
       ev.base_item,
       CASE WHEN r.rnk <= ev.top_count THEN ev.top_item END
     ], NULL)) AS list
   ) items
   WHERE jsonb_array_length(items.list) > 0;
$$;

REVOKE EXECUTE ON FUNCTION public.boss_rewards_json(uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.boss_rewards_json(uuid) TO service_role;
