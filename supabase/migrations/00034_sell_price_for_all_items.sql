-- Every item can now be sold back for currency, not just the CD. Backfill
-- sell_price for items that never had one, tiered by rarity (matches the
-- sellPrice values now set in packages/shared/src/items.ts).
UPDATE public.items
SET sell_price = CASE rarity
  WHEN 'common' THEN 10
  WHEN 'uncommon' THEN 100
  WHEN 'rare' THEN 250
  WHEN 'legendary' THEN 500
END
WHERE sell_price IS NULL;
