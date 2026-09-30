-- Shorter Power Dice descriptions: just the upgrade range each tier covers.
update public.items set description = 'Upgrade cards +1 to +3.'  where id = 'power-dice-1';
update public.items set description = 'Upgrade cards +4 to +6.'  where id = 'power-dice-2';
update public.items set description = 'Upgrade cards +7 to +10.' where id = 'power-dice-3';
