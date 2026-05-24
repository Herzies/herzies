INSERT INTO public.items (id, name, description, rarity, sell_price, stackable, equipable)
VALUES (
  'rainbow-headband',
  'Rainbow Headband',
  'A colourful headband for your herzie.',
  'uncommon',
  null,
  false,
  true
)
ON CONFLICT (id) DO NOTHING;
