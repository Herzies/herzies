-- ===========================================================================
-- 00140 — The Crystal
--
-- Listening XP and listening drops build up in a Crystal in Town; the player
-- cashes them in by attuning to it. Past its capacity (3h, +1h per tier, up
-- to 8h) it keeps charging at 25%. Rules mirror packages/shared/src/crystal.ts.
--
-- Concurrency: sync writes the herzies row whole from what it read, so the
-- crystal_* columns are NEVER written by sync's update. They only change
-- through the row-locked functions below, so a sync racing an attune can't
-- put back XP that was just paid out. Attune hands XP over through
-- pending_xp (00115), the same handoff the Tower and quests use.
--
-- Behind game_flags.crystal (off on deploy): off = listening pays out
-- directly as before. Flip it once the desktop release with the Crystal is out.
-- ===========================================================================

ALTER TABLE public.herzies
  ADD COLUMN IF NOT EXISTS crystal_fill         numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS crystal_xp           numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS crystal_drop_minutes numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS crystal_tier         integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS crystal_attunes      integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS crystal_shards       integer NOT NULL DEFAULT 0;

-- ---------------------------------------------------------------------------
-- game_flags — server-side feature switches, read through sync_context.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.game_flags (
  id         text PRIMARY KEY,
  enabled    boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.game_flags ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.game_flags FROM anon, authenticated;
INSERT INTO public.game_flags (id, enabled) VALUES ('crystal', false)
  ON CONFLICT (id) DO NOTHING;

-- sync_context as 00091, plus 'flags'.
create or replace function public.sync_context(p_user_id uuid)
returns jsonb
language sql
stable
security definer
set search_path to ''
as $function$
  select jsonb_build_object(
    'herzie', (
      select to_jsonb(h) from public.herzies h where h.user_id = p_user_id
    ),
    'item_units', public.item_units_json(p_user_id),
    'multipliers', (
      select coalesce(
        jsonb_agg(jsonb_build_object(
          'name', m.name, 'bonus', m.bonus, 'schedule', m.schedule
        )), '[]'::jsonb)
      from public.multipliers m
      where m.active = true
        and m.starts_at <= now()
        and m.ends_at >= now()
    ),
    'xp_bonuses', (
      select coalesce(
        jsonb_agg(jsonb_build_object(
          'id', b.id, 'enabled', b.enabled, 'amount', b.amount, 'cap', b.cap
        )), '[]'::jsonb)
      from public.xp_bonuses b
    ),
    'flags', (
      select coalesce(jsonb_object_agg(g.id, g.enabled), '{}'::jsonb)
      from public.game_flags g
    ),
    'pending_drops', (
      select coalesce(
        jsonb_agg(jsonb_build_object(
          'id', d.id, 'item_id', d.item_id, 'dropped_at', d.dropped_at
        ) order by d.dropped_at), '[]'::jsonb)
      from public.pending_drops d
      where d.user_id = p_user_id
    ),
    'active_hunts', (
      select coalesce(
        jsonb_agg(jsonb_build_object('id', e.id, 'title', e.title)), '[]'::jsonb)
      from public.events e
      where e.type = 'song_hunt'
        and e.active = true
        and e.starts_at <= now()
        and e.ends_at >= now()
    ),
    'active_boss', (
      select jsonb_build_object(
        'id', e.id,
        'title', e.title,
        'hatedGenres', coalesce(e.config -> 'hatedGenres', '[]'::jsonb)
      )
      from public.events e
      join public.boss_state bs on bs.event_id = e.id
      where e.type = 'boss_fight'
        and e.active = true
        and e.starts_at <= now()
        and e.ends_at > now()
        and not bs.killed
        and not bs.escaped
      -- spawn_boss_fight guarantees at most one; the order is only there so
      -- that guarantee failing would still pick deterministically.
      order by e.starts_at desc
      limit 1
    ),
    'pending_trade', (
      select jsonb_build_object(
        'tradeId', t.id,
        'fromName', ih.name,
        'fromFriendCode', ih.friend_code
      )
      from public.trades t
      join public.herzies ih on ih.user_id = t.initiator_id
      where t.target_id = p_user_id
        and t.state = 'pending'
        and t.expires_at > now()
      order by t.created_at desc
      limit 1
    ),
    'friend_requests', (
      select coalesce(
        jsonb_agg(jsonb_build_object(
          'requestId', fr.id,
          'incoming', fr.to_user_id = p_user_id,
          'name', oh.name,
          'friendCode', oh.friend_code,
          'createdAt', fr.created_at
        ) order by fr.created_at desc), '[]'::jsonb)
      from public.friend_requests fr
      join public.herzies oh
        on oh.user_id = case
             when fr.to_user_id = p_user_id then fr.from_user_id
             else fr.to_user_id
           end
      where (fr.from_user_id = p_user_id or fr.to_user_id = p_user_id)
        and fr.status = 'pending'
    )
  );
$function$;

-- ---------------------------------------------------------------------------
-- crystal_capacity — minutes held before overcharging (crystalCapacity).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.crystal_capacity(p_tier integer)
RETURNS numeric
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
  SELECT (180 + least(5, greatest(0, coalesce(p_tier, 0))) * 60)::numeric;
$$;

-- ---------------------------------------------------------------------------
-- charge_crystal — sync's half. Adds p_minutes of listening worth p_xp
-- (multipliers already applied) to the Crystal, splitting what overflows
-- capacity at 25% (chargeCrystal). p_backlog_drop_minutes carries rolls the
-- old per-sync drop path still owed at cutover, at full value.
-- Returns the Crystal's state plus fill before/after for the notices.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.charge_crystal(
  p_user                 uuid,
  p_minutes              numeric,
  p_xp                   numeric,
  p_backlog_drop_minutes numeric DEFAULT 0
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_h      public.herzies%ROWTYPE;
  v_m      numeric := greatest(0, least(coalesce(p_minutes, 0), 1440));
  v_xp     numeric := greatest(0, least(coalesce(p_xp, 0), 10000000));
  v_back   numeric := greatest(0, least(coalesce(p_backlog_drop_minutes, 0), 100000));
  v_under  numeric;
  v_eff    numeric;
  v_ratio  numeric;
BEGIN
  SELECT * INTO v_h FROM public.herzies WHERE user_id = p_user FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'herzie not found';
  END IF;

  v_under := least(v_m, greatest(0, public.crystal_capacity(v_h.crystal_tier) - greatest(0, v_h.crystal_fill)));
  v_eff   := v_under + (v_m - v_under) * 0.25;
  v_ratio := CASE WHEN v_m > 0 THEN v_eff / v_m ELSE 0 END;

  UPDATE public.herzies
     SET crystal_fill         = greatest(0, crystal_fill) + v_m,
         crystal_xp           = crystal_xp + v_xp * v_ratio,
         crystal_drop_minutes = crystal_drop_minutes + v_eff + v_back
   WHERE user_id = p_user
  RETURNING * INTO v_h;

  RETURN jsonb_build_object(
    'fillBefore', v_h.crystal_fill - v_m,
    'effectiveMinutes', v_eff,
    'herzie', to_jsonb(v_h)
  );
END;
$$;

-- ---------------------------------------------------------------------------
-- crystal_attune — pay the Crystal out, in one transaction.
--
-- The caller (attune-crystal edge function) rolls the items first; this puts
-- them on the ground (pending_drops), where they come out of black holes
-- round the player like listening drops always did, to be picked up (the
-- pickup checks the bag). Landed 45 s on, as listening drops are (00125), so
-- a worn spirit's server-side sweep doesn't take them before they're seen.
-- p_expected_attunes is the crystal_attunes the client saw: a
-- retry or a double press arrives stale and pays nothing. XP goes to
-- pending_xp (whole part; the fraction stays in the Crystal), so the level-up
-- maths happens in TS exactly as for the Tower, and if anything after this
-- fails the XP is still safe for the next sync.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.crystal_attune(
  p_user              uuid,
  p_expected_attunes  integer,
  p_rolls             integer,
  p_items             jsonb DEFAULT '[]'::jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_h      public.herzies%ROWTYPE;
  v_xp     integer;
  v_rolls  integer;
  v_given  integer := 0;
BEGIN
  SELECT * INTO v_h FROM public.herzies WHERE user_id = p_user FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'herzie not found';
  END IF;
  IF v_h.crystal_attunes IS DISTINCT FROM p_expected_attunes THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'stale',
      'herzie', to_jsonb(v_h));
  END IF;

  v_xp    := greatest(0, floor(v_h.crystal_xp))::integer;
  v_rolls := greatest(0, least(coalesce(p_rolls, 0),
               floor(v_h.crystal_drop_minutes / 10)::integer, 60));

  IF v_rolls > 0 AND jsonb_typeof(p_items) = 'array' THEN
    INSERT INTO public.pending_drops (user_id, item_id, dropped_at)
    SELECT p_user, i.id, now() + interval '45 seconds'
      FROM (SELECT e AS item_id
              FROM jsonb_array_elements_text(p_items) WITH ORDINALITY AS t(e, n)
             WHERE n <= v_rolls * 3) AS x
      JOIN public.items i ON i.id = x.item_id;
    GET DIAGNOSTICS v_given = ROW_COUNT;
  END IF;

  UPDATE public.herzies
     SET pending_xp           = pending_xp + v_xp,
         crystal_xp           = greatest(0, crystal_xp - v_xp),
         crystal_drop_minutes = greatest(0, crystal_drop_minutes - v_rolls * 10),
         crystal_fill         = 0,
         crystal_attunes      = crystal_attunes + 1
   WHERE user_id = p_user
  RETURNING * INTO v_h;

  RETURN jsonb_build_object(
    'ok', true,
    'xp', v_xp,
    'rolls', v_rolls,
    'given', v_given,
    'herzie', to_jsonb(v_h),
    'pendingDrops', (
      SELECT coalesce(jsonb_agg(jsonb_build_object(
               'id', d.id, 'itemId', d.item_id, 'droppedAt', d.dropped_at
             ) ORDER BY d.dropped_at), '[]'::jsonb)
        FROM public.pending_drops d
       WHERE d.user_id = p_user
    )
  );
END;
$$;

-- ---------------------------------------------------------------------------
-- upgrade_crystal — spend shards to grow the Crystal one tier.
-- Costs mirror crystalUpgradeCost: 3, 5, 8, 12, 20.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.upgrade_crystal(p_user uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_h     public.herzies%ROWTYPE;
  v_cost  integer;
BEGIN
  SELECT * INTO v_h FROM public.herzies WHERE user_id = p_user FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'herzie not found';
  END IF;
  IF v_h.crystal_tier >= 5 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'max-tier', 'herzie', to_jsonb(v_h));
  END IF;
  v_cost := (ARRAY[3, 5, 8, 12, 20])[greatest(0, v_h.crystal_tier) + 1];
  IF v_h.crystal_shards < v_cost THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not-enough-shards', 'herzie', to_jsonb(v_h));
  END IF;

  UPDATE public.herzies
     SET crystal_shards = crystal_shards - v_cost,
         crystal_tier   = greatest(0, crystal_tier) + 1
   WHERE user_id = p_user
  RETURNING * INTO v_h;

  RETURN jsonb_build_object('ok', true, 'cost', v_cost, 'herzie', to_jsonb(v_h));
END;
$$;

-- ---------------------------------------------------------------------------
-- quest_claim as 00136, plus p_shards (Crystal Shards). The default keeps
-- the current route's calls working while it ships.
-- ---------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.quest_claim(uuid, uuid, integer, integer, jsonb);

CREATE OR REPLACE FUNCTION public.quest_claim(
  p_user  uuid,
  p_id    uuid,
  p_xp    integer,
  p_coins integer,
  p_items jsonb DEFAULT '[]'::jsonb,
  p_shards integer DEFAULT 0
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
         currency = currency + greatest(0, least(coalesce(p_coins, 0), 100000)),
         crystal_shards = crystal_shards + greatest(0, least(coalesce(p_shards, 0), 1000))
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

REVOKE EXECUTE ON FUNCTION public.crystal_capacity(integer)
  FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.charge_crystal(uuid, numeric, numeric, numeric)
  FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.crystal_attune(uuid, integer, integer, jsonb)
  FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.upgrade_crystal(uuid)
  FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.quest_claim(uuid, uuid, integer, integer, jsonb, integer)
  FROM PUBLIC, anon, authenticated;
