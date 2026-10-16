-- Boss loot: on top of the event's own rewards (rewardItemId for everyone
-- who helped, topRewardItemId for the top three), each gets
-- BOSS_BONUS_DROPS (10) random items, drawn like a listening drop but
-- leaning a little better (BOSS_LOOT_RARITY_BOOST): 12 things for the top
-- three, 11 for everyone else. All land on the ground in the cave, like the
-- rewards (00105).
--
-- The weights are duplicated from bossLootWeights() in
-- packages/shared/src/items.ts (items.test.ts checks they agree).

-- One weighted random pick: each candidate races an exponential clock at
-- its weight, and the first in wins (so the odds are weight / total).
CREATE OR REPLACE FUNCTION public.boss_loot_roll()
RETURNS text
LANGUAGE sql
VOLATILE
SET search_path = ''
AS $$
  SELECT p.item_id
    FROM (VALUES
      ('cd', 4000),
      ('power-dice-1', 50),
      ('power-dice-2', 16),
      ('power-dice-3', 6),
      ('safety-pick', 16),
      ('headphones', 225),
      ('rainbow-headband', 225),
      ('gold-chain', 50),
      ('pearl-necklace', 225),
      ('bowtie', 225),
      ('boombox', 50),
      ('good-eye-sniper', 50),
      ('clouds', 50),
      ('stars', 50),
      ('prism', 225),
      ('poseidons-gift', 225),
      ('purple-dane', 225),
      ('thanks-for-all-the-fish', 225)
    ) AS p(item_id, weight)
   ORDER BY -ln(1 - random()) / p.weight
   LIMIT 1;
$$;

-- As in 00111, plus the random loot.
create or replace function public.settle_boss_fight(p_event_id uuid default null)
returns int as $$
declare
  v_event       record;
  v_participant record;
  v_config      jsonb;
  v_base_item   text;
  v_top_item    text;
  v_top_count   int;
  v_paid        int := 0;
  v_lands       timestamptz := now() + interval '90 seconds';
begin
  for v_event in
    select e.id, e.config
      from public.events e
      join public.boss_state bs on bs.event_id = e.id
     where e.type = 'boss_fight'
       and bs.killed
       and not bs.settled
       and (p_event_id is null or e.id = p_event_id)
  loop
    v_config    := v_event.config;
    v_base_item := v_config ->> 'rewardItemId';
    v_top_item  := v_config ->> 'topRewardItemId';
    v_top_count := coalesce((v_config ->> 'topCount')::int, 3);

    for v_participant in
      select bd.user_id,
             row_number() over (
               order by public.boss_contribution(bd.damage, bd.healing, bd.blocked) desc,
                        bd.user_id) as rnk
        from public.boss_damage bd
       where bd.event_id = v_event.id
         and public.boss_contribution(bd.damage, bd.healing, bd.blocked) > 0
    loop
      insert into public.event_claims (event_id, user_id)
      values (v_event.id, v_participant.user_id)
      on conflict (event_id, user_id) do nothing;

      -- Conflict means this player was already paid on an earlier run.
      if not found then
        continue;
      end if;

      if not exists (
        select 1 from public.herzies h where h.user_id = v_participant.user_id
      ) then
        continue;
      end if;

      -- The event's rewards first, then the random loot.
      insert into public.pending_drops (user_id, item_id, dropped_at, source_event)
      select v_participant.user_id, i.item_id, v_lands, v_event.id
        from (values
                (1, v_base_item),
                (2, case when v_participant.rnk <= v_top_count
                         then v_top_item end)
             ) as i(n, item_id)
       where i.item_id is not null
       order by i.n;

      insert into public.pending_drops (user_id, item_id, dropped_at, source_event)
      select v_participant.user_id, public.boss_loot_roll(), v_lands, v_event.id
        from generate_series(1, 10);

      v_paid := v_paid + 1;
    end loop;

    update public.boss_state set settled = true where event_id = v_event.id;
    update public.events set active = false where id = v_event.id;
  end loop;

  return v_paid;
end;
$$ language plpgsql security definer set search_path = '';

revoke execute on function public.boss_loot_roll() from public, anon, authenticated;
revoke execute on function public.settle_boss_fight(uuid) from public, anon, authenticated;
