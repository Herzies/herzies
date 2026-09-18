-- Two uncommon colour skins, matching the new 'purple-dane' and
-- 'thanks-for-all-the-fish' entries in packages/shared/src/items.ts. Both
-- paint a herzie a colour it could already hatch with: their ramps are built
-- around CREATURE_PALETTE's "soft violet" (#C3A6FF) and "teal" (#4ECDC4).
--
-- Priced like 'prism', the other uncommon colour skin: sell_price 100 and no
-- buy_price, so they are earned from the world-drop pool rather than bought.
-- Being uncommon and absent from NON_DROPPABLE_ITEM_IDS is all it takes to
-- enter that pool (see pickWeightedDrop).
INSERT INTO public.items (id, name, description, rarity, sell_price, buy_price, stackable, equipable, equip_slot)
VALUES
  (
    'purple-dane',
    'Purple Dane',
    'Denne her gør dig lilla.',
    'uncommon',
    100,
    NULL,
    false,
    true,
    'color'
  ),
  (
    'thanks-for-all-the-fish',
    'Thanks for all the fish!',
    'Get ready to leave planet earth in style.',
    'uncommon',
    100,
    NULL,
    false,
    true,
    'color'
  )
ON CONFLICT (id) DO NOTHING;
