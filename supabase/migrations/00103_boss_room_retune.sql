-- Retune boss health for fighting it live.
--
-- APPLY AT CUTOVER, not before: together with the `sync` redeploy that stops
-- listening from damaging a boss, and the desktop build that has the cave.
-- Until then (older desktops, passive damage) the old scale is the right one.
-- 00101 and 00102 are additive and safe to apply early; this is not.
--
-- A boss used to be worn down by listening minutes (hundreds to tens of
-- thousands of HP in total). A sonic wave deals ~100, and the cave is fought
-- by a community at a few casts a second each: about 250,000 takes a group of
-- five attentive herzies a few minutes, and a lone one over ten (see the
-- simulation in packages/town-server/test/boss-sim.test.ts, which pins these
-- numbers to the real cast pace). Only bosses that haven't started yet, and
-- the template future ones are built from, so a boss already underway
-- finishes on the scale it started on.

UPDATE public.event_series
   SET config_template = config_template || '{"maxHp": 250000}'::jsonb
 WHERE type = 'boss_fight';

UPDATE public.boss_state bs
   SET hp = 250000, max_hp = 250000
  FROM public.events e
 WHERE e.id = bs.event_id
   AND e.type = 'boss_fight'
   AND e.starts_at > now()
   AND NOT bs.killed;

UPDATE public.events e
   SET config = e.config || '{"maxHp": 250000}'::jsonb
 WHERE e.type = 'boss_fight' AND e.starts_at > now();
