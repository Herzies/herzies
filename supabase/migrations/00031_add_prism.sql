-- Prism: the first equipable colour scheme (rainbow gradient).
-- Apply only once packages/shared/src/items.ts ships a matching 'prism' entry —
-- a catalog row the client cannot resolve renders as a blank/undefined item.

INSERT INTO public.items (id, name, description, rarity, sell_price, stackable, equipable, equip_slot)
VALUES (
  'prism',
  'Prism',
  'A rainbow gradient colour scheme for your herzie.',
  'uncommon',
  null,
  false,
  true,
  'color'
)
ON CONFLICT (id) DO NOTHING;
