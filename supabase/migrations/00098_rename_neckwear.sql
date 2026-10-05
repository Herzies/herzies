-- New names and descriptions for the three neckwear items, matching
-- packages/shared/src/items.ts.
update public.items
  set name = 'Ludvig''s Lariat',
      description = 'He''s been dreaming of this gold ornament since he first entered the world of Herzies.'
  where id = 'gold-chain';
update public.items
  set name = 'Hardened Tears of Joy',
      description = 'Aphrodite''s most commercially successful product yet.'
  where id = 'pearl-necklace';
update public.items
  set name = 'ur mom''s favourite',
      description = 'Good compensation for bad cooking and nonexistent social skills.'
  where id = 'bowtie';
