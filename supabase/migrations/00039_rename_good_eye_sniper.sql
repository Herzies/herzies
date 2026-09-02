-- Rename + description tweak to match packages/shared/src/items.ts.
UPDATE public.items
SET name = 'Good Eye, Sniper',
    description = 'Good eye... and good ears! Let everyone know just how good they are.'
WHERE id = 'good-eye-sniper';
