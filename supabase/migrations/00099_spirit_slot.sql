-- A Spirit slot, mirroring packages/shared/src/items.ts.
--
-- Pickup pets used to take an Accessory (ground_left/ground_right) box. They
-- now have a slot of their own, 'spirit', holding one at a time: the Greedy
-- Spirit and Herman (the ghost, formerly Boo-tleg), which now picks up drops
-- too. equip_unit needs no change — a slot other than 'ground' is used as-is,
-- and a single-value slot displaces its incumbent — and item_projection keys
-- `equipped` by whatever slot a unit is in.
--
-- Also: Herman is renamed, made legendary and taken out of the drop pool (it
-- is a limited-time premium item, sold as a Stripe product whose
-- metadata.item_id is 'ghost'); Hex Appeal becomes rare; Jack is removed.

alter table public.items drop constraint items_equip_slot_check;
alter table public.items add constraint items_equip_slot_check
  check (equip_slot is null or equip_slot in (
    'head', 'face', 'body', 'scenery', 'ground', 'spirit', 'color', 'modifier'
  ));

alter table public.item_units drop constraint item_units_equipped_slot_check;
alter table public.item_units add constraint item_units_equipped_slot_check
  check (equipped_slot is null or equipped_slot in (
    'head', 'face', 'body', 'scenery', 'ground_left', 'ground_right',
    'spirit', 'color', 'modifier'
  ));

update public.items set equip_slot = 'spirit' where id in ('spirit-orb', 'ghost');

update public.items
  set name = 'Herman',
      description = 'Swoops up items for you.',
      rarity = 'legendary',
      sell_price = 500,
      buy_price = null
  where id = 'ghost';

update public.items set rarity = 'rare', sell_price = 250 where id = 'witch-hat';

-- Worn spirits move off the ground into the new slot, which holds one. A
-- player wearing both the Greedy Spirit and the ghost (one on each side) would
-- collide on the single-slot index, so the ghost comes off first in that case.
-- Production has none worn (one unworn ghost exists), but a dev database might.
update public.item_units u
   set equipped_slot = null, equipped_at = null
 where u.item_id = 'ghost'
   and u.equipped_slot in ('ground_left', 'ground_right')
   and exists (select 1 from public.item_units o
                where o.user_id = u.user_id and o.item_id = 'spirit-orb'
                  and o.equipped_slot is not null);
update public.item_units
   set equipped_slot = 'spirit'
 where item_id in ('spirit-orb', 'ghost')
   and equipped_slot in ('ground_left', 'ground_right');

-- Jack is gone. Nobody owns one in production (it never dropped); on a dev
-- database its copies and ground drops go with it.
delete from public.pending_drops where item_id = 'jack-o-lantern';
delete from public.item_units where item_id = 'jack-o-lantern';
delete from public.items where id = 'jack-o-lantern';
