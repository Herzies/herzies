-- Rename the Spirit Orb to Greedy Spirit. The id stays 'spirit-orb' — it is
-- referenced by inventories, equipped slots and the auto-collect logic.
UPDATE public.items
SET
  name = 'Greedy Spirit',
  description = 'Tired of picking up items? This little guy can help.'
WHERE id = 'spirit-orb';
