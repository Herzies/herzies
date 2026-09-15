-- One round trip for everything processSync reads before it starts thinking.
--
-- processSync (supabase/functions/_shared/game-server.ts) opened with 7-9
-- sequential reads on every call: the herzie row, active multipliers, pending
-- drops, active song hunts, a pending trade request, that trade initiator's
-- name, pending friend requests, and the other parties' names. The sync daemon
-- calls it every 5s per visible client and every 60s per hidden one — about
-- 14.4k calls/day from ~26 users, which made it roughly 70% of all PostgREST
-- traffic against this database.
--
-- SCOPE — deliberately narrow. This function contains NO game logic. It is
-- purely the read half: the same rows the TypeScript was already fetching,
-- gathered in one query. XP, levelling, cravings, drop rolls, event matching
-- and reward grants all stay in TypeScript exactly as they were.
--
-- That boundary is the whole point. The game rules already exist twice
-- (packages/web/src/lib/game-server.ts and the vendored copy under
-- supabase/functions/_shared/) and have already drifted. Porting ~450 lines of
-- economy logic into PL/pgSQL to save round trips would make a third
-- implementation of the rules that mint items and currency, which is a far
-- worse trade than the round trips are worth.
--
-- Two joins are folded in because they were strictly N+1s, not logic:
--   * pending_trade joins the initiator's herzie (was a second query)
--   * friend_requests joins the other party's herzie (was a second query)
-- Both use INNER joins, matching the old code's behaviour of skipping a row
-- whose counterpart herzie is missing.
--
-- pending_drops is a snapshot from before the drop roll that may happen later
-- in the sync. The caller re-reads it only when a roll actually fired (once per
-- 10 listened minutes), so the common path stays at one round trip.
--
-- Multiplier schedules are NOT evaluated here. isScheduleActive() uses the
-- runtime's local day/hour, so the raw `schedule` jsonb is returned and the
-- filtering stays in TypeScript, unchanged.

create or replace function public.sync_context(p_user_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'herzie', (
      select to_jsonb(h) from public.herzies h where h.user_id = p_user_id
    ),
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
$$;

-- Returns another user's herzie fields (trade initiator / friend-request
-- counterparty names) and is SECURITY DEFINER, so service-role only.
REVOKE EXECUTE ON FUNCTION public.sync_context(uuid) FROM PUBLIC, anon, authenticated;
