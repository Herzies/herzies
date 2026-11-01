-- Quests: small tasks handed out by Town NPCs (packages/shared/src/quests.ts
-- holds the definitions). Each giver offers one a day (UTC); you accept it
-- from them, it completes on its own as you listen, and you turn it in to
-- them for the reward.
--
-- - artist_key: the one artist normalizer for "have you heard them before",
--   the same as leadArtist in game-server.ts (lowercase, no "(…)" / "[…]" /
--   " - suffix", first credited artist). Indexed on listen_log so the
--   history check stays an index lookup. Left executable by everyone: it's
--   pure, and clients insert into listen_log, which evaluates it.
-- - user_quests: one row per (user, giver, day). An active quest from an
--   earlier day has expired; a complete one stays claimable until turned in.
-- - quest_accept / quest_note_artist / quest_claim / quests_json: service
--   role only, like every other write path since 00097.

-- ---------------------------------------------------------------------------
-- artist_key
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.artist_key(p_artist text)
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = ''
AS $$
  SELECT btrim(
    regexp_replace(
      btrim(
        regexp_replace(
          regexp_replace(
            regexp_replace(lower(coalesce(p_artist, '')), '\s*\([^)]*\)\s*', '', 'g'),
            '\s*\[[^]]*\]\s*', '', 'g'),
          '\s+-\s+.*$', '')
      ),
      '\s*(&|,|\mfeat\.|\mft\.|\mfeaturing\M|\mwith\M).*$', '')
  );
$$;

CREATE INDEX IF NOT EXISTS idx_listen_log_artist_key
  ON public.listen_log (user_id, public.artist_key(artist_name));

-- ---------------------------------------------------------------------------
-- user_quests
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.user_quests (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  giver        text NOT NULL,
  quest_id     text NOT NULL,
  title        text NOT NULL,
  kind         text NOT NULL,
  day          date NOT NULL,
  progress     integer NOT NULL DEFAULT 0,
  target       integer NOT NULL CHECK (target > 0),
  status       text NOT NULL DEFAULT 'active'
               CHECK (status IN ('active', 'complete', 'claimed')),
  accepted_at  timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  claimed_at   timestamptz,
  UNIQUE (user_id, giver, day)
);

CREATE INDEX IF NOT EXISTS idx_user_quests_user_status
  ON public.user_quests (user_id, status);

ALTER TABLE public.user_quests ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.user_quests FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------------
-- quest_accept — take today's quest from a giver. One per giver per day, and
-- not while a finished one from them waits to be turned in.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.quest_accept(
  p_user   uuid,
  p_giver  text,
  p_quest  text,
  p_title  text,
  p_kind   text,
  p_target integer
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

  INSERT INTO public.user_quests (user_id, giver, quest_id, title, kind, day, target)
  VALUES (p_user, p_giver, p_quest, p_title, p_kind, v_today, greatest(1, p_target))
  ON CONFLICT (user_id, giver, day) DO NOTHING
  RETURNING id INTO v_id;

  IF v_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'already-taken');
  END IF;
  RETURN jsonb_build_object('ok', true, 'id', v_id);
END;
$$;

-- ---------------------------------------------------------------------------
-- quest_note_artist — a new track started (sync, Spotify cron). Call it
-- BEFORE that track goes into listen_log. Moves today's active new_artist
-- quests along if the artist has no earlier row in your history. Null when
-- nothing moved (the common case: no such quest).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.quest_note_artist(p_user uuid, p_artist text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_today date := (now() AT TIME ZONE 'utc')::date;
  v_key   text;
  v_q     public.user_quests%ROWTYPE;
  v_done  jsonb := '[]'::jsonb;
  v_moved boolean := false;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.user_quests
     WHERE user_id = p_user AND kind = 'new_artist'
       AND status = 'active' AND day = v_today
  ) THEN
    RETURN NULL;
  END IF;

  v_key := public.artist_key(p_artist);
  IF v_key = '' THEN
    RETURN NULL;
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.listen_log
     WHERE user_id = p_user AND public.artist_key(artist_name) = v_key
  ) THEN
    RETURN NULL;
  END IF;

  FOR v_q IN
    UPDATE public.user_quests
       SET progress = least(progress + 1, target),
           status = CASE WHEN progress + 1 >= target THEN 'complete' ELSE status END,
           completed_at = CASE WHEN progress + 1 >= target THEN now() ELSE completed_at END
     WHERE user_id = p_user AND kind = 'new_artist'
       AND status = 'active' AND day = v_today
    RETURNING *
  LOOP
    v_moved := true;
    IF v_q.status = 'complete' THEN
      v_done := v_done || jsonb_build_object(
        'id', v_q.id, 'giver', v_q.giver, 'title', v_q.title);
    END IF;
  END LOOP;

  IF NOT v_moved THEN
    RETURN NULL;
  END IF;
  RETURN jsonb_build_object('completed', v_done);
END;
$$;

-- ---------------------------------------------------------------------------
-- quest_claim — turn a finished quest in. XP goes through pending_xp (sync
-- writes xp whole from what it read, 00115); coins straight onto currency
-- (sync never writes it).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.quest_claim(
  p_user  uuid,
  p_id    uuid,
  p_xp    integer,
  p_coins integer
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_q        public.user_quests%ROWTYPE;
  v_currency integer;
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

  RETURN jsonb_build_object('ok', true, 'newCurrency', v_currency);
END;
$$;

-- ---------------------------------------------------------------------------
-- quests_json — what the Quests window and the givers show: today's rows,
-- and finished ones from any day still waiting to be turned in. An active
-- quest from an earlier day has expired and isn't shown.
-- ---------------------------------------------------------------------------
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
           'kind', q.kind,
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

REVOKE EXECUTE ON FUNCTION public.quest_accept(uuid, text, text, text, text, integer)
  FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.quest_note_artist(uuid, text)
  FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.quest_claim(uuid, uuid, integer, integer)
  FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.quests_json(uuid)
  FROM PUBLIC, anon, authenticated;
