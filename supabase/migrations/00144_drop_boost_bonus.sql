-- Retire the BOOST XP bonus (00091). Nothing ever set herzies.boost_until,
-- so it never paid out; the code no longer knows about it.

delete from public.xp_bonuses where id = 'boost';

alter table public.xp_bonuses drop constraint if exists xp_bonuses_id_check;
alter table public.xp_bonuses
  add constraint xp_bonuses_id_check check (id in ('streak', 'good_eye_sniper'));

alter table public.herzies drop column if exists boost_until;
