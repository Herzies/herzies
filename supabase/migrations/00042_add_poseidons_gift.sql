-- Poseidon's Gift: a legendary equipable colour scheme (deep ocean blue),
-- matching the new 'poseidons-gift' entry in packages/shared/src/items.ts.
INSERT INTO public.items (id, name, description, rarity, sell_price, buy_price, stackable, equipable, equip_slot)
VALUES (
  'poseidons-gift',
  'Poseidon''s Gift',
  'A gift from the sea god himself. Turns your herzie blue.',
  'legendary',
  500,
  100000,
  false,
  true,
  'color'
)
ON CONFLICT (id) DO NOTHING;
