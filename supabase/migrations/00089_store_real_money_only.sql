-- The Store stops selling cards for coins. Anything bought with coins is now
-- bought from Good ol' George during a merchant visit, whose prices live in
-- each stock line (events.config.stock[].price), not here — so buy_price has
-- no reader left but the old /inventory/buy route, which refuses on null and
-- tells older desktop builds to go find George.
--
-- Former coin items (all 3000): prism, poseidons-gift, purple-dane,
-- thanks-for-all-the-fish. Add them to George's series stock pool instead.
update public.items
   set buy_price = null
 where buy_price is not null;
