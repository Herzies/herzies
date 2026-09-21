-- Let processSync see the live boss, so listening can damage it.
--
-- Adds one key, `active_boss`, to sync_context. Everything else below is
-- 00060's body verbatim — it was diffed against the definition actually live
-- in production before this was written, because the local and remote
-- migration histories have diverged and replacing a function that runs on
-- every sync from every client is not the place to silently drop a hotfix.
--
-- Same boundary as 00060: this is read-only, and the damage decision stays in
-- TypeScript. The row lock that makes shared HP safe lives in
-- deal_boss_damage (00073), not here — this only tells the caller whether it
-- is worth calling that at all.
--
-- `active_boss` excludes killed and escaped bosses rather than leaving that to
-- deal_boss_damage. That function would refuse the hit anyway, but settle
-- takes up to a minute to flip events.active, and every sync in that window
-- would otherwise pay a round trip to be told no.
--
-- Depends on 00073 (boss_state). A LANGUAGE sql function is validated at
-- creation, so this fails loudly rather than half-applying if run first.
--
-- Rollout order is safe in either direction for the edge function: an old
-- deployment ignores the extra key, and a new one reading an old
-- sync_context sees no boss and deals no damage.

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
$$;

-- CREATE OR REPLACE keeps existing grants, but restate the revoke so this file
-- is correct on its own, same as 00060.
REVOKE EXECUTE ON FUNCTION public.sync_context(uuid) FROM PUBLIC, anon, authenticated;
