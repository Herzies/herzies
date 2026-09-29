-- Power Dice 3, the first mythic item. Code without the mythic rarity
-- never rolls it as a drop: filterDroppablePool skips rarities that have no
-- entry in RARITY_DROP_WEIGHTS (and ids its catalog doesn't know).
insert into public.items (id, name, description, rarity, sell_price, buy_price, stackable, equipable, equip_slot)
values (
  'power-dice-3',
  'Power Dice 3',
  'Takes a card from +6 up to +10, one stat point at a time. Every roll can fail — and a failed roll breaks the card.',
  'mythic',
  1500,
  null,
  true,
  false,
  null
)
on conflict (id) do nothing;
