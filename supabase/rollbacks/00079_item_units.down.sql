-- ROLLBACK for 00079_item_units.sql (not a migration: apply by hand, only if 00079 must be undone).
--
-- Puts the database back on the count-based model. The legacy columns
-- (inventory_v2, item_upgrades, equipped) are kept exactly current by 00079's
-- projection trigger, so they hold the right counts, worn items and levels the
-- moment this runs; what is lost is only WHICH copy carries a level (per-copy
-- identity), which the old model can't store. Function bodies below are the
-- exact pre-00079 definitions (pg_get_functiondef of the 00078 schema).
--
-- Also redeploy the previous web build and edge functions: the new routes and
-- desktop builds call RPCs this removes.

begin;

-- 1. Stop deriving the legacy columns and allow direct writes to them again.
drop trigger if exists herzies_guard_item_projection on public.herzies;
drop trigger if exists item_units_refresh_ins on public.item_units;
drop trigger if exists item_units_refresh_del on public.item_units;
drop trigger if exists item_units_refresh_upd on public.item_units;
drop function if exists public.herzies_guard_item_projection();
drop function if exists public.item_units_refresh_trg();

-- 2. Restore the count-based functions.
drop function if exists public.apply_item_upgrade(uuid, text, uuid);
CREATE OR REPLACE FUNCTION public.apply_item_upgrade(p_user_id uuid, p_dice_item_id text, p_target_item_id text)
 RETURNS TABLE(ok boolean, reason text, new_level integer)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_inv      jsonb;
  v_upgrades jsonb;
  v_dice_qty int;
  v_targ_qty int;
  v_level    int;
BEGIN
  SELECT inventory_v2, item_upgrades INTO v_inv, v_upgrades
    FROM public.herzies
   WHERE user_id = p_user_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RETURN QUERY SELECT false, 'not-found'::text, NULL::int;
    RETURN;
  END IF;

  v_dice_qty := COALESCE((v_inv->>p_dice_item_id)::int, 0);
  IF v_dice_qty < 1 THEN
    RETURN QUERY SELECT false, 'dice-not-owned'::text, NULL::int;
    RETURN;
  END IF;

  v_targ_qty := COALESCE((v_inv->>p_target_item_id)::int, 0);
  IF v_targ_qty < 1 THEN
    RETURN QUERY SELECT false, 'target-not-owned'::text, NULL::int;
    RETURN;
  END IF;

  v_level := COALESCE((v_upgrades->>p_target_item_id)::int, 0);
  -- 3 is MAX_ITEM_UPGRADE_LEVEL (packages/shared/src/items.ts) — this SQL
  -- function can't import that constant, so the two must stay in sync by
  -- hand (same arrangement as GROUND_DROP_CAP/BANK_SLOT_COUNT).
  IF v_level >= 3 THEN
    RETURN QUERY SELECT false, 'max-level'::text, NULL::int;
    RETURN;
  END IF;

  IF v_dice_qty - 1 > 0 THEN
    v_inv := jsonb_set(v_inv, ARRAY[p_dice_item_id], to_jsonb(v_dice_qty - 1));
  ELSE
    v_inv := v_inv - p_dice_item_id;
  END IF;
  v_level := v_level + 1;
  v_upgrades := jsonb_set(v_upgrades, ARRAY[p_target_item_id], to_jsonb(v_level));

  UPDATE public.herzies
     SET inventory_v2 = v_inv, item_upgrades = v_upgrades
   WHERE user_id = p_user_id;

  RETURN QUERY SELECT true, NULL::text, v_level;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.grant_inventory_item(p_user_id uuid, p_item_id text, p_quantity integer DEFAULT 1)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
BEGIN
  UPDATE public.herzies
  SET inventory_v2 = jsonb_set(
        inventory_v2,
        ARRAY[p_item_id],
        to_jsonb(COALESCE((inventory_v2->>p_item_id)::int, 0) + p_quantity)
      )
  WHERE user_id = p_user_id;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.collect_pending_drop(p_user_id uuid, p_drop_id uuid)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_item_id text;
BEGIN
  DELETE FROM public.pending_drops
  WHERE id = p_drop_id AND user_id = p_user_id
  RETURNING item_id INTO v_item_id;

  IF v_item_id IS NULL THEN
    RETURN NULL;
  END IF;

  UPDATE public.herzies
  SET inventory_v2 = jsonb_set(
        inventory_v2,
        ARRAY[v_item_id],
        to_jsonb(COALESCE((inventory_v2->>v_item_id)::int, 0) + 1)
      )
  WHERE user_id = p_user_id;

  RETURN v_item_id;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.fulfill_store_order(p_session_id text, p_event_id text, p_to_ground boolean)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  o public.store_orders;
BEGIN
  SELECT * INTO o FROM public.store_orders
    WHERE stripe_checkout_session_id = p_session_id FOR UPDATE;

  IF NOT FOUND THEN RETURN false; END IF;
  -- Idempotency, covering both branches below: Stripe retries webhooks, and
  -- the test-mode checkout path calls this directly. The row lock above plus
  -- this check is what stops a retry paying out twice.
  IF o.status = 'completed' THEN RETURN true; END IF;

  IF o.grant_item_id IS NOT NULL THEN
    IF p_to_ground THEN
      -- Deliberately a direct INSERT and NOT roll_pending_drops: that function
      -- enforces GROUND_DROP_CAP and returns 0 when the ground is full, which
      -- for a paid item would silently destroy the purchase. A bought item is
      -- never subject to the drop cap. Do not "consolidate" these two.
      INSERT INTO public.pending_drops (user_id, item_id)
      VALUES (o.user_id, o.grant_item_id);
    ELSE
      UPDATE public.herzies
        SET inventory_v2 = jsonb_set(
              inventory_v2,
              ARRAY[o.grant_item_id],
              to_jsonb(COALESCE((inventory_v2->>o.grant_item_id)::int, 0) + 1)
            )
        WHERE user_id = o.user_id;
    END IF;
  ELSE
    UPDATE public.herzies
      SET currency = currency + o.currency_amount
      WHERE user_id = o.user_id;
  END IF;

  UPDATE public.store_orders
    SET status = 'completed', stripe_event_id = p_event_id, completed_at = now()
    WHERE id = o.id;

  RETURN true;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.execute_trade(trade_id uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  t public.trades;
  init_inv jsonb;
  targ_inv jsonb;
  init_currency integer;
  targ_currency integer;
  item_key text;
  item_qty integer;
  init_offer_items jsonb;
  targ_offer_items jsonb;
  init_offer_currency integer;
  targ_offer_currency integer;
BEGIN
  SELECT * INTO t FROM public.trades WHERE id = trade_id FOR UPDATE;
  IF NOT FOUND OR t.state != 'both_locked' THEN RETURN false; END IF;
  IF NOT t.initiator_accepted OR NOT t.target_accepted THEN RETURN false; END IF;
  IF t.expires_at IS NOT NULL AND t.expires_at < now() THEN RETURN false; END IF;

  init_offer_items := COALESCE(t.initiator_offer->'items', '{}');
  targ_offer_items := COALESCE(t.target_offer->'items', '{}');
  init_offer_currency := COALESCE((t.initiator_offer->>'currency')::int, 0);
  targ_offer_currency := COALESCE((t.target_offer->>'currency')::int, 0);

  IF t.initiator_id < t.target_id THEN
    SELECT inventory_v2, currency INTO init_inv, init_currency
      FROM public.herzies WHERE user_id = t.initiator_id FOR UPDATE;
    SELECT inventory_v2, currency INTO targ_inv, targ_currency
      FROM public.herzies WHERE user_id = t.target_id FOR UPDATE;
  ELSE
    SELECT inventory_v2, currency INTO targ_inv, targ_currency
      FROM public.herzies WHERE user_id = t.target_id FOR UPDATE;
    SELECT inventory_v2, currency INTO init_inv, init_currency
      FROM public.herzies WHERE user_id = t.initiator_id FOR UPDATE;
  END IF;

  IF init_currency < init_offer_currency THEN RETURN false; END IF;
  IF targ_currency < targ_offer_currency THEN RETURN false; END IF;

  FOR item_key, item_qty IN SELECT * FROM jsonb_each_text(init_offer_items)
  LOOP
    IF COALESCE((init_inv->>item_key)::int, 0) < item_qty::int THEN RETURN false; END IF;
  END LOOP;

  FOR item_key, item_qty IN SELECT * FROM jsonb_each_text(targ_offer_items)
  LOOP
    IF COALESCE((targ_inv->>item_key)::int, 0) < item_qty::int THEN RETURN false; END IF;
  END LOOP;

  FOR item_key, item_qty IN SELECT * FROM jsonb_each_text(init_offer_items)
  LOOP
    init_inv := jsonb_set(init_inv, ARRAY[item_key], to_jsonb(COALESCE((init_inv->>item_key)::int, 0) - item_qty::int));
    targ_inv := jsonb_set(targ_inv, ARRAY[item_key], to_jsonb(COALESCE((targ_inv->>item_key)::int, 0) + item_qty::int));
  END LOOP;

  FOR item_key, item_qty IN SELECT * FROM jsonb_each_text(targ_offer_items)
  LOOP
    targ_inv := jsonb_set(targ_inv, ARRAY[item_key], to_jsonb(COALESCE((targ_inv->>item_key)::int, 0) - item_qty::int));
    init_inv := jsonb_set(init_inv, ARRAY[item_key], to_jsonb(COALESCE((init_inv->>item_key)::int, 0) + item_qty::int));
  END LOOP;

  init_inv := (SELECT COALESCE(jsonb_object_agg(k, v), '{}') FROM jsonb_each(init_inv) AS x(k, v) WHERE (v::text)::int > 0);
  targ_inv := (SELECT COALESCE(jsonb_object_agg(k, v), '{}') FROM jsonb_each(targ_inv) AS x(k, v) WHERE (v::text)::int > 0);

  init_currency := init_currency - init_offer_currency + targ_offer_currency;
  targ_currency := targ_currency - targ_offer_currency + init_offer_currency;

  UPDATE public.herzies SET inventory_v2 = init_inv, currency = init_currency WHERE user_id = t.initiator_id;
  UPDATE public.herzies SET inventory_v2 = targ_inv, currency = targ_currency WHERE user_id = t.target_id;
  UPDATE public.herzies SET item_upgrades = (SELECT COALESCE(jsonb_object_agg(k, v), '{}'::jsonb) FROM jsonb_each((SELECT item_upgrades FROM public.herzies WHERE user_id = t.initiator_id)) AS x(k, v) WHERE init_inv ? k) WHERE user_id = t.initiator_id;
  UPDATE public.herzies SET item_upgrades = (SELECT COALESCE(jsonb_object_agg(k, v), '{}'::jsonb) FROM jsonb_each((SELECT item_upgrades FROM public.herzies WHERE user_id = t.target_id)) AS x(k, v) WHERE targ_inv ? k) WHERE user_id = t.target_id;

  UPDATE public.trades SET state = 'completed', updated_at = now() WHERE id = trade_id;

  RETURN true;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.sync_context(p_user_id uuid)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select jsonb_build_object(
    'herzie', (
      select to_jsonb(h) from public.herzies h where h.user_id = p_user_id
    ),
    'multipliers', (
      select coalesce(
        jsonb_agg(jsonb_build_object(
          'name', m.name, 'bonus', m.bonus, 'schedule', m.schedule
        )), '[]'::jsonb)
      from public.multipliers m
      where m.active = true
        and m.starts_at <= now()
        and m.ends_at >= now()
    ),
    'pending_drops', (
      select coalesce(
        jsonb_agg(jsonb_build_object(
          'id', d.id, 'item_id', d.item_id, 'dropped_at', d.dropped_at
        ) order by d.dropped_at), '[]'::jsonb)
      from public.pending_drops d
      where d.user_id = p_user_id
    ),
    'active_hunts', (
      select coalesce(
        jsonb_agg(jsonb_build_object('id', e.id, 'title', e.title)), '[]'::jsonb)
      from public.events e
      where e.type = 'song_hunt'
        and e.active = true
        and e.starts_at <= now()
        and e.ends_at >= now()
    ),
    'active_boss', (
      select jsonb_build_object(
        'id', e.id,
        'title', e.title,
        'hatedGenres', coalesce(e.config -> 'hatedGenres', '[]'::jsonb)
      )
      from public.events e
      join public.boss_state bs on bs.event_id = e.id
      where e.type = 'boss_fight'
        and e.active = true
        and e.starts_at <= now()
        and e.ends_at > now()
        and not bs.killed
        and not bs.escaped
      -- spawn_boss_fight guarantees at most one; the order is only there so
      -- that guarantee failing would still pick deterministically.
      order by e.starts_at desc
      limit 1
    ),
    'pending_trade', (
      select jsonb_build_object(
        'tradeId', t.id,
        'fromName', ih.name,
        'fromFriendCode', ih.friend_code
      )
      from public.trades t
      join public.herzies ih on ih.user_id = t.initiator_id
      where t.target_id = p_user_id
        and t.state = 'pending'
        and t.expires_at > now()
      order by t.created_at desc
      limit 1
    ),
    'friend_requests', (
      select coalesce(
        jsonb_agg(jsonb_build_object(
          'requestId', fr.id,
          'incoming', fr.to_user_id = p_user_id,
          'name', oh.name,
          'friendCode', oh.friend_code,
          'createdAt', fr.created_at
        ) order by fr.created_at desc), '[]'::jsonb)
      from public.friend_requests fr
      join public.herzies oh
        on oh.user_id = case
             when fr.to_user_id = p_user_id then fr.from_user_id
             else fr.to_user_id
           end
      where (fr.from_user_id = p_user_id or fr.to_user_id = p_user_id)
        and fr.status = 'pending'
    )
  );
$function$
;

CREATE OR REPLACE FUNCTION public.grant_cds(p_user_id uuid, p_quantity integer, p_cds_granted integer)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
BEGIN
  UPDATE public.herzies
  SET inventory_v2 = jsonb_set(
        inventory_v2,
        '{cd}',
        to_jsonb(COALESCE((inventory_v2->>'cd')::int, 0) + p_quantity)
      ),
      cds_granted = p_cds_granted
  WHERE user_id = p_user_id;
END;
$function$
;

-- CREATE OR REPLACE keeps the privileges of functions that still existed; the two
-- that were dropped and recreated need the same lockdown 00008 gave them.
revoke execute on function public.apply_item_upgrade(uuid, text, text) from public, anon, authenticated;
revoke execute on function public.grant_cds(uuid, integer, integer) from public, anon, authenticated;

-- 3. Remove the new functions and table. Dropping item_units discards per-copy
-- identity only; the legacy columns already hold the current state.
drop function if exists public.sell_units(uuid, uuid[]);
drop function if exists public.buy_item_units(uuid, text, int);
drop function if exists public.equip_unit(uuid, uuid, text, text);
drop function if exists public.trade_offer_unit_ids(jsonb, uuid);
drop function if exists public.refresh_item_projection(uuid[]);
drop function if exists public.item_state(uuid);
drop function if exists public.item_units_json(uuid);
drop table if exists public.item_units;
drop function if exists public.item_projection(uuid);

-- 4. First Edition Card stackable again.
update public.items set stackable = true where id = 'first-edition';

commit;
