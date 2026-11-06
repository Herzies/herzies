-- ===========================================================================
-- 00142 — Holding the boss with a Taunt counts toward contribution
--
-- A Percussionist's job is to hold the boss, and none of that counted:
-- only damage, healing and what a dome blocked did. The Town server now
-- pays each second held with a Taunt (tauntPointsPerSecond in
-- packages/shared/src/combat.ts) and reports it as `taunt`, already in
-- points. boss_damage keeps it, and it counts as it is in the score
-- everywhere the score ranks: the end screen, the leaderboard, the statue.
--
-- The functions below are as on prod before this (00111, 00114, 00122),
-- with the taunt added.
-- ===========================================================================

alter table public.boss_damage
  add column if not exists taunt real not null default 0;

-- The score with the taunt's points. The three-argument one stays for
-- whatever still calls it (settle_boss_fight's pre-roster path).
create or replace function public.boss_contribution(
  p_damage  real,
  p_healing real,
  p_blocked real,
  p_taunt   real
)
returns real
language sql
immutable
set search_path = ''
as $$
  select (coalesce(p_damage, 0)
          + 10 * (coalesce(p_healing, 0) + coalesce(p_blocked, 0))
          + coalesce(p_taunt, 0))::real;
$$;

revoke execute on function public.boss_contribution(real, real, real, real)
  from public, anon, authenticated;

-- p_damage rows may carry `taunt` too.
create or replace function public.apply_boss_damage_batch(p_batch text, p_event uuid, p_damage jsonb)
 returns jsonb
 language plpgsql
 security definer
 set search_path to ''
as $function$
declare
  v_rows    integer;
  v_item    jsonb;
  v_hp      real;
  v_kill    boolean;
  v_res     record;
  v_damage  real;
  v_healing real;
  v_blocked real;
  v_adds    real;
  v_taunt   real;
begin
  if p_batch is null or length(p_batch) = 0 or length(p_batch) > 200 then
    raise exception 'bad batch id';
  end if;
  if jsonb_typeof(p_damage) is distinct from 'array'
     or jsonb_array_length(p_damage) > 200 then
    raise exception 'bad damage list';
  end if;

  insert into public.boss_damage_batches (batch, event_id)
  values (p_batch, p_event)
  on conflict (batch) do nothing;
  get diagnostics v_rows = row_count;

  if v_rows = 0 then
    select bs.hp, bs.killed into v_hp, v_kill
      from public.boss_state bs where bs.event_id = p_event;
    return jsonb_build_object(
      'applied', false, 'hp', v_hp, 'killed', coalesce(v_kill, false));
  end if;

  for v_item in select * from jsonb_array_elements(p_damage) loop
    begin
      v_damage  := least(greatest(coalesce((v_item ->> 'damage')::real, 0), 0), 1000000);
      v_healing := least(greatest(coalesce((v_item ->> 'healing')::real, 0), 0), 1000000);
      v_blocked := least(greatest(coalesce((v_item ->> 'blocked')::real, 0), 0), 1000000);
      v_adds    := least(greatest(coalesce((v_item ->> 'adds')::real, 0), 0), 1000000);
      v_taunt   := least(greatest(coalesce((v_item ->> 'taunt')::real, 0), 0), 1000000);
      if v_damage > 0 then
        select * into v_res from public.deal_boss_damage(
          p_event, (v_item ->> 'uid')::uuid, v_damage);
      end if;
      if v_healing > 0 or v_blocked > 0 or v_adds > 0 or v_taunt > 0 then
        insert into public.boss_damage (event_id, user_id, healing, blocked, adds, taunt)
        select p_event, (v_item ->> 'uid')::uuid, v_healing, v_blocked, v_adds, v_taunt
         where exists (select 1 from public.events e
                        where e.id = p_event and e.type = 'boss_fight')
        on conflict (event_id, user_id) do update
          set healing = public.boss_damage.healing + excluded.healing,
              blocked = public.boss_damage.blocked + excluded.blocked,
              adds    = public.boss_damage.adds + excluded.adds,
              taunt   = public.boss_damage.taunt + excluded.taunt;
      end if;
    exception when others then
      continue;
    end;
  end loop;

  select bs.hp, bs.killed into v_hp, v_kill
    from public.boss_state bs where bs.event_id = p_event;
  return jsonb_build_object(
    'applied', true, 'hp', v_hp, 'killed', coalesce(v_kill, false));
end;
$function$;

-- The statue, ranked with the taunt.
create or replace function public.boss_champion_json(p_skip uuid[] default '{}'::uuid[])
 returns jsonb
 language sql
 stable security definer
 set search_path to ''
as $function$
  with fallen as (
    select e.id, bs.killed_at as over_at,
           exists (select 1 from public.boss_participants bp
                    where bp.event_id = e.id) as rostered
      from public.events e
      join public.boss_state bs on bs.event_id = e.id
     where e.type = 'boss_fight'
       and bs.killed
  ), top as (
    select d.user_id, d.event_id, d.damage + d.adds as damage,
           public.boss_contribution(d.damage + d.adds, d.healing, d.blocked, d.taunt) as score
      from fallen f
      join public.boss_damage d on d.event_id = f.id
      join public.herzies hz on hz.user_id = d.user_id
     where public.boss_contribution(d.damage + d.adds, d.healing, d.blocked, d.taunt) > 0
       and not (d.user_id = any (coalesce(p_skip, '{}')))
       and (not f.rostered or exists (
             select 1 from public.boss_participants bp
              where bp.event_id = f.id and bp.user_id = d.user_id
                and bp.status = 'in'))
     order by f.over_at desc nulls last, score desc, d.user_id
     limit 1
  )
  select jsonb_build_object(
    'event', t.event_id,
    'damage', t.damage,
    'contribution', t.score,
    'name', h.name,
    'seed', h.friend_code,
    'stage', h.stage,
    'equipped', h.equipped
  )
    from top t
    join public.herzies h on h.user_id = t.user_id;
$function$;

-- The leaderboard, ranked with the taunt.
create or replace function public.boss_leaderboard(p_event_id uuid, p_limit integer default 5)
 returns table(user_id uuid, name text, damage real, heal real, contribution real, rank bigint)
 language sql
 stable security definer
 set search_path to ''
as $function$
  select bd.user_id,
         h.name,
         (bd.damage + bd.adds)::real,
         (bd.healing + bd.blocked)::real,
         public.boss_contribution(bd.damage + bd.adds, bd.healing, bd.blocked, bd.taunt),
         row_number() over (
           order by public.boss_contribution(bd.damage + bd.adds, bd.healing, bd.blocked, bd.taunt) desc,
                    bd.user_id)
    from public.boss_damage bd
    join public.herzies h on h.user_id = bd.user_id
   where bd.event_id = p_event_id
     and public.boss_contribution(bd.damage + bd.adds, bd.healing, bd.blocked, bd.taunt) > 0
   order by 5 desc, bd.user_id
   limit p_limit;
$function$;

-- The end screen, ranked with the taunt.
create or replace function public.boss_results_json(p_event uuid, p_uids uuid[])
 returns jsonb
 language sql
 stable security definer
 set search_path to ''
as $function$
  with ranked as (
    select bd.user_id,
           h.name,
           h.friend_code,
           h.stage,
           h.equipped,
           bd.damage + bd.adds as damage,
           bd.healing + bd.blocked as heal,
           row_number() over (
             order by public.boss_contribution(bd.damage + bd.adds, bd.healing, bd.blocked, bd.taunt) desc,
                      bd.user_id) as rank
      from public.boss_damage bd
      join public.herzies h on h.user_id = bd.user_id
     where bd.event_id = p_event
       and public.boss_contribution(bd.damage + bd.adds, bd.healing, bd.blocked, bd.taunt) > 0
       and not exists (select 1 from public.boss_participants bp
                        where bp.event_id = p_event and bp.user_id = bd.user_id
                          and bp.status = 'out')
  )
  select jsonb_build_object(
    'top', coalesce((
      select jsonb_agg(jsonb_build_object(
               'rank', r.rank, 'name', r.name,
               'damage', round(r.damage::numeric), 'heal', round(r.heal::numeric),
               'seed', r.friend_code, 'stage', r.stage, 'equipped', r.equipped)
             order by r.rank)
        from ranked r
       where r.rank <= 3
    ), '[]'::jsonb),
    'you', coalesce((
      select jsonb_object_agg(r.user_id::text, jsonb_build_object(
               'rank', r.rank, 'name', r.name,
               'damage', round(r.damage::numeric), 'heal', round(r.heal::numeric)))
        from ranked r
       where r.user_id = any (coalesce(p_uids, '{}'))
    ), '{}'::jsonb)
  );
$function$;
