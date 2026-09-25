import { normalizeUnits } from "@herzies/shared";
import { NextResponse } from "next/server";
import { authenticateRequest, isAuthError } from "@/lib/auth";
import {
  countByItem,
  type OfferedUnit,
  type StoredOffer,
  sameOffer,
  unitsForLegacyCount,
} from "@/lib/item-units";
import { isParseError, parseBody, tradeOfferSchema } from "@/lib/schemas";
import { createAdminClient } from "@/lib/supabase-admin";

export async function POST(request: Request) {
  const auth = await authenticateRequest(request);
  if (isAuthError(auth)) return auth;

  const body = await parseBody(request, tradeOfferSchema);
  if (isParseError(body)) return body;

  const { tradeId, offer } = body;

  const admin = createAdminClient();

  const { data: trade } = await admin
    .from("trades")
    .select("*")
    .eq("id", tradeId)
    .single();

  if (!trade) {
    return NextResponse.json({ error: "Trade not found" }, { status: 404 });
  }

  const isInitiator = trade.initiator_id === auth.userId;
  const isTarget = trade.target_id === auth.userId;

  if (!isInitiator && !isTarget) {
    return NextResponse.json({ error: "Not your trade" }, { status: 403 });
  }

  // Can only update offer in active or locked states (not pending, completed, cancelled)
  const allowedStates = [
    "active",
    "initiator_locked",
    "target_locked",
    "both_locked",
  ];
  if (!allowedStates.includes(trade.state as string)) {
    return NextResponse.json(
      { error: `Cannot update offer in ${trade.state} state` },
      { status: 400 },
    );
  }

  // Validate player has what they're offering
  const { data: herzie } = await admin
    .from("herzies")
    .select("currency")
    .eq("user_id", auth.userId)
    .single();

  if (!herzie) {
    return NextResponse.json({ error: "Herzie not found" }, { status: 404 });
  }

  if ((herzie.currency as number) < offer.currency) {
    return NextResponse.json({ error: "Not enough currency" }, { status: 400 });
  }

  const { data: rows } = await admin
    .from("item_units")
    .select("id, item_id, upgrade_level, equipped_slot, acquired_at")
    .eq("user_id", auth.userId)
    .order("acquired_at", { ascending: true })
    .order("id", { ascending: true });

  const owned = normalizeUnits(
    (rows ?? []).map((r) => ({
      id: r.id,
      itemId: r.item_id,
      upgradeLevel: r.upgrade_level,
      equippedSlot: r.equipped_slot,
    })),
  );

  // What are they giving? Named copies (current clients), or — from a client
  // that predates copies — a count per item id, which we resolve to copies: the
  // plainest unworn ones first, so a spare goes before one you've upgraded.
  let unitIds: string[];
  if (offer.units) {
    unitIds = [...new Set(offer.units)];
  } else {
    unitIds = [];
    // Only unworn copies can be traded, so a count that could only be met by
    // wearing-down your equipment is "not enough", not a silent partial offer.
    const unworn = owned.filter((u) => u.equippedSlot === null);
    for (const [itemId, qty] of Object.entries(offer.items ?? {})) {
      const picked = unitsForLegacyCount(unworn, itemId, qty);
      if (!picked) {
        return NextResponse.json(
          { error: `Not enough ${itemId}` },
          { status: 400 },
        );
      }
      unitIds.push(...picked);
    }
  }

  const byId = new Map(owned.map((u) => [u.id, u]));
  const offered: OfferedUnit[] = [];
  for (const id of unitIds) {
    const u = byId.get(id);
    if (!u) {
      return NextResponse.json(
        { error: "You don't own one of those items" },
        { status: 400 },
      );
    }
    // A worn copy can't be traded: nothing else would stop you giving away the
    // hat you have on, leaving it worn by nobody. Unequip it first.
    if (u.equippedSlot !== null) {
      return NextResponse.json(
        { error: "Unequip an item before trading it" },
        { status: 400 },
      );
    }
    offered.push({
      unitId: u.id,
      itemId: u.itemId,
      upgradeLevel: u.upgradeLevel,
    });
  }

  const stored: StoredOffer = {
    units: offered,
    items: countByItem(offered),
    currency: offer.currency,
  };

  // Only reset locks if the offer actually changed. Resending the same offer
  // (which happens on every Lock click — see TradeView.handleLock) must be a
  // no-op for state, otherwise simultaneous locks ping-pong each other and
  // the trade can never reach both_locked.
  const currentOffer = (
    isInitiator ? trade.initiator_offer : trade.target_offer
  ) as Partial<StoredOffer> | null;
  const offerChanged = !sameOffer(currentOffer, stored);

  const update: Record<string, unknown> = {
    updated_at: new Date().toISOString(),
  };

  if (isInitiator) {
    update.initiator_offer = stored;
  } else {
    update.target_offer = stored;
  }

  if (offerChanged) {
    // The deal changed, so any accepts are stale.
    update.initiator_accepted = false;
    update.target_accepted = false;
    // Only release the lock of the side whose offer changed. Locking means
    // "my own offer is final" — the partner's lock must survive my edits,
    // otherwise the second player's first offer-send (part of their Lock
    // click) silently unlocks the first player and locks ping-pong forever.
    const state = trade.state as string;
    if (isInitiator) {
      if (state === "initiator_locked") update.state = "active";
      else if (state === "both_locked") update.state = "target_locked";
    } else {
      if (state === "target_locked") update.state = "active";
      else if (state === "both_locked") update.state = "initiator_locked";
    }
    // Give both sides time to react to the new offer instead of dying at the
    // original created_at + 5min mark.
    update.expires_at = new Date(Date.now() + 5 * 60_000).toISOString();
  }

  const { error } = await admin.from("trades").update(update).eq("id", tradeId);

  if (error) {
    return NextResponse.json(
      { error: "Failed to update offer" },
      { status: 500 },
    );
  }

  return NextResponse.json({ ok: true });
}
