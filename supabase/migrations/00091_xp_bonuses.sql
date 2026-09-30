-- The built-in XP bonuses, made tunable from the dev admin instead of
-- hard-coded in processSync. Each row is one bonus's formula:
--   boost            flat `amount` while a herzie's boost_until is ahead
--   streak           `amount` per streak day, up to `cap` (null = no cap)
--   good_eye_sniper  `amount` per song hunt won while wearing the card,
--                    up to `cap`
-- Seeded with the values the code used, so applying this changes nothing
-- until an admin edits a row. The timed, global multipliers stay in
-- public.multipliers.
create table if not exists public.xp_bonuses (
  id text primary key check (id in ('boost', 'streak', 'good_eye_sniper')),
  enabled boolean not null default true,
  amount real not null check (amount > 0),
  cap real check (cap is null or cap > 0),
  updated_at timestamptz not null default now()
);

-- Read only through sync_context (security definer) and the admin API
-- (service role), so no policies.
alter table public.xp_bonuses enable row level security;

insert into public.xp_bonuses (id, enabled, amount, cap) values
  ('boost', true, 10.0, null),
  ('streak', true, 0.01, null),
  ('good_eye_sniper', true, 0.02, 0.3)
on conflict (id) do nothing;

-- sync_context as live (00079), plus 'xp_bonuses'. processSync falls back to
-- the seeded values when the key is missing, so the edge function and this
-- migration can ship in either order.
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
