-- The Wilds: a free-for-all PvP island reached by sky ship. While a "wilds"
-- event is on, the one ship, Blåmann, shuttles between the Sky Dock on the
-- home island and the one on the Wilds; when none is on it's laid up at
-- home, and anyone left on the Wilds is sent back to Town (it has no other
-- way off).
--
-- Nothing is kept or paid here: the ship's timetable is a pure function of
-- the event's window and its one tunable (config.departEverySec, see
-- wildsConfig in packages/shared/src/wilds.ts), so the event row is all the
-- clients need. Every field is optional — a missing or odd value falls back
-- to the default — so event_config_complete's `ELSE true` already holds and
-- a wilds occurrence goes live as soon as it's materialized.
--
-- Only the series type needs allowing: `events.type` is unconstrained.

ALTER TABLE public.event_series DROP CONSTRAINT IF EXISTS event_series_type_check;
ALTER TABLE public.event_series
  ADD CONSTRAINT event_series_type_check
  CHECK (type IN ('song_hunt', 'boss_fight', 'merchant', 'tower', 'wilds'));
