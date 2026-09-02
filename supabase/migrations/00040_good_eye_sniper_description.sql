-- Description tweak to match packages/shared/src/items.ts.
UPDATE public.items
SET description = '... and good ears! Let everyone know just how good they are.'
WHERE id = 'good-eye-sniper';
