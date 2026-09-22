-- First Edition Card becomes equipable, in the same "modifier" slot as
-- Good Eye Sniper, so its +10 luck stat flows through the normal
-- equipped-items-contribute-stats mechanism (getHerzieStats) — while
-- staying stackable. This is the first item to be both: see the
-- bankSlotsUsed / ownedBankUnits fixes shipped in the same change for the
-- fallout of a stackable item now being partially equipped.
--
-- items_equip_slot_check (00046_add_modifier_slot.sql) already permits
-- 'modifier', so no constraint change is needed here.
update public.items
set equipable = true,
    equip_slot = 'modifier'
where id = 'first-edition';
