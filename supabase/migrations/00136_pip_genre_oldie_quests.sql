-- Pip's genre and oldie quests (packages/shared/src/quests.ts). Each copy of
-- a quest can be about something of its own — a genre Pip hasn't found, a
-- year the song has to be older than — picked when it's offered:
--
-- - user_quests.params: what this copy is about ({genre} / {before}).
-- - user_quests.description: its text as offered (null: the definition's).
-- - quest_accept: takes both. Replaced rather than overloaded, so there's
--   one function to grant; the new arguments default, so a caller that
--   doesn't send them still works.
-- - quest_advance: one step on one active quest of today. Whether the track
--   counts (its tags, its release year) is decided in sync, which looks it
--   up (noteQuestTrack in game-server.ts); this only moves the row.
-- - quest_claim: pays items too (Pip: 10 Star Candy with the coins), in
--   the same transaction, and answers with the item state when it did.
--   Replaced the same way; p_items defaults to none.
-- - quests_json: hands params and description back.

ALTER TABLE public.user_quests
  ADD COLUMN IF NOT EXISTS params jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS description text;

DROP FUNCTION IF EXISTS public.quest_accept(uuid, text, text, text, text, integer);

CREATE OR REPLACE FUNCTION public.quest_accept(
  p_user        uuid,
  p_giver       text,
  p_quest       text,
  p_title       text,
  p_kind        text,
  p_target      integer,
  p_params      jsonb DEFAULT '{}'::jsonb,
  p_description text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_today date := (now() AT TIME ZONE 'utc')::date;
  v_id    uuid;
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.user_quests
     WHERE user_id = p_user AND giver = p_giver AND status = 'complete'
  ) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'turn-in-first');
  END IF;

  INSERT INTO public.user_quests
    (user_id, giver, quest_id, title, kind, day, target, params, description)
  VALUES
    (p_user, p_giver, p_quest, p_title, p_kind, v_today, greatest(1, p_target),
     coalesce(p_params, '{}'::jsonb), p_description)
  ON CONFLICT (user_id, giver, day) DO NOTHING
  RETURNING id INTO v_id;

  IF v_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'already-taken');
  END IF;
  RETURN jsonb_build_object('ok', true, 'id', v_id);
END;
$$;

-- ---------------------------------------------------------------------------
-- quest_advance — a track counted for one of today's active genre / oldie
-- quests. Null when there's no such quest (finished, expired, not yours).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.quest_advance(p_user uuid, p_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_q public.user_quests%ROWTYPE;
BEGIN
  UPDATE public.user_quests
     SET progress = least(progress + 1, target),
         status = CASE WHEN progress + 1 >= target THEN 'complete' ELSE status END,
         completed_at = CASE WHEN progress + 1 >= target THEN now() ELSE completed_at END
   WHERE id = p_id AND user_id = p_user
     AND kind IN ('genre', 'oldie')
     AND status = 'active'
     AND day = (now() AT TIME ZONE 'utc')::date
  RETURNING * INTO v_q;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  RETURN jsonb_build_object(
    'id', v_q.id, 'giver', v_q.giver, 'title', v_q.title,
    'completed', v_q.status = 'complete');
END;
$$;

-- ---------------------------------------------------------------------------
-- quest_claim — turn a finished quest in. XP goes through pending_xp (sync
-- writes xp whole from what it read, 00115); coins straight onto currency
-- (sync never writes it); items as new copies. p_items:
-- [{"itemId": text, "quantity": int}], from the quest's definition (the
-- route), never the client. Unknown item ids are skipped.
-- ---------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.quest_claim(uuid, uuid, integer, integer);

CREATE OR REPLACE FUNCTION public.quest_claim(
  p_user  uuid,
  p_id    uuid,
  p_xp    integer,
  p_coins integer,
  p_items jsonb DEFAULT '[]'::jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_q        public.user_quests%ROWTYPE;
  v_currency integer;
  v_given    integer := 0;
BEGIN
  SELECT * INTO v_q FROM public.user_quests
   WHERE id = p_id AND user_id = p_user
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not-found');
  END IF;
  IF v_q.status = 'claimed' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'already-claimed');
  END IF;
  IF v_q.status <> 'complete' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not-complete');
  END IF;

  UPDATE public.user_quests
     SET status = 'claimed', claimed_at = now()
   WHERE id = p_id;

  UPDATE public.herzies
     SET pending_xp = pending_xp + greatest(0, least(coalesce(p_xp, 0), 100000)),
         currency = currency + greatest(0, least(coalesce(p_coins, 0), 100000))
   WHERE user_id = p_user
  RETURNING currency INTO v_currency;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'herzie not found';
  END IF;

  IF jsonb_typeof(p_items) = 'array' THEN
    INSERT INTO public.item_units (user_id, item_id)
    SELECT p_user, i.id
      FROM jsonb_array_elements(p_items) AS e
      JOIN public.items i ON i.id = e->>'itemId'
     CROSS JOIN LATERAL generate_series(
       1, greatest(0, least(coalesce((e->>'quantity')::int, 0), 100)))
    ;
    GET DIAGNOSTICS v_given = ROW_COUNT;
  END IF;

  IF v_given > 0 THEN
    RETURN jsonb_build_object('ok', true, 'newCurrency', v_currency,
      'state', public.item_state(p_user));
  END IF;
  RETURN jsonb_build_object('ok', true, 'newCurrency', v_currency);
END;
$$;

CREATE OR REPLACE FUNCTION public.quests_json(p_user uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT coalesce(jsonb_agg(jsonb_build_object(
           'id', q.id,
           'questId', q.quest_id,
           'giver', q.giver,
           'title', q.title,
           'description', q.description,
           'kind', q.kind,
           'params', q.params,
           'day', q.day,
           'progress', q.progress,
           'target', q.target,
           'status', q.status,
           'acceptedAt', q.accepted_at,
           'completedAt', q.completed_at
         ) ORDER BY q.accepted_at), '[]'::jsonb)
    FROM public.user_quests q
   WHERE q.user_id = p_user
     AND (q.day = (now() AT TIME ZONE 'utc')::date OR q.status = 'complete');
$$;

REVOKE EXECUTE ON FUNCTION public.quest_accept(uuid, text, text, text, text, integer, jsonb, text)
  FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.quest_claim(uuid, uuid, integer, integer, jsonb)
  FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.quest_advance(uuid, uuid)
  FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.quests_json(uuid)
  FROM PUBLIC, anon, authenticated;
