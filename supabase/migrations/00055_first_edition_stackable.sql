-- For now, artefacts (items with no equip_slot/equipable — see
-- packages/shared/src/items.ts's getItemType) are the only stackable item
-- type. first-edition was the one artefact left non-stackable — every other
-- item in the catalog already matched this rule. Data-only fix, applied
-- directly via execute_sql before this migration file was written; included
-- here so the change is tracked alongside the rest of the schema history.
UPDATE public.items SET stackable = true WHERE id = 'first-edition';
