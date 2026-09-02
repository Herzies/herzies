-- Renames + description tweaks to match packages/shared/src/items.ts.
UPDATE public.items SET name = 'Box of Boom' WHERE id = 'boombox';
UPDATE public.items SET name = 'Overcast' WHERE id = 'clouds';
UPDATE public.items SET name = 'Starfield' WHERE id = 'stars';
UPDATE public.items SET name = 'Prismatic Surrenderer' WHERE id = 'prism';
UPDATE public.items
SET name = 'Nostalgic Token',
    description = 'An image of a CD on a dull card. Weird. Probably not worth much.'
WHERE id = 'cd';
UPDATE public.items
SET name = 'Intimite Music Device',
    description = 'Summons a pair of headphones on your herzie''s head.'
WHERE id = 'headphones';
