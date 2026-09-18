-- Put the two uncommon colour skins in the store at 10,000 coins.
--
-- Both halves are required. The desktop store lists from the bundled catalog
-- (BUYABLE_ITEMS in StoreView filters ITEMS on buyPrice != null), but
-- /api/inventory/buy charges the items row's buy_price and refuses outright
-- when it is null — so a catalog-only change would show both cards in the
-- store and fail every purchase.
UPDATE public.items
SET buy_price = 10000
WHERE id IN ('purple-dane', 'thanks-for-all-the-fish');
