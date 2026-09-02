-- Add the "Good Eye Sniper" ground item: a reward-only equipable that
-- displays a herzie's song-hunt win count on their profile. The count is
-- never persisted; it's derived live from event_claims via this RPC so it
-- can never drift from ground truth.

INSERT INTO public.items (id, name, description, rarity, sell_price, stackable, equipable, equip_slot)
VALUES (
  'good-eye-sniper',
  'Good Eye Sniper',
  'Proof your ears never miss. Tracks every song hunt you''ve won.',
  'rare',
  250,
  false,
  true,
  'ground'
)
ON CONFLICT (id) DO NOTHING;

CREATE OR REPLACE FUNCTION public.count_song_hunt_wins(p_user_id uuid)
RETURNS integer AS $$
  SELECT count(*)::int
  FROM public.event_claims ec
  JOIN public.events e ON e.id = ec.event_id
  WHERE ec.user_id = p_user_id AND e.type = 'song_hunt';
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '';
