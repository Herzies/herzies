-- Description tweak to match packages/shared/src/items.ts, now that
-- Good Eye Sniper also grants an XP bonus while equipped.
UPDATE public.items
SET description = '... and good ears! Displays your song hunt wins and boosts XP the more you rack up.'
WHERE id = 'good-eye-sniper';
