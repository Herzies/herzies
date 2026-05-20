import { NextResponse } from "next/server";
import { authenticateRequest, isAuthError } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase-admin";
import { tradeOfferSchema, parseBody, isParseError } from "@/lib/schemas";

function offersEqual(
	a: { items: Record<string, number>; currency: number } | null,
	b: { items: Record<string, number>; currency: number },
): boolean {
	if (!a) return false;
	if (a.currency !== b.currency) return false;
	const aKeys = Object.keys(a.items ?? {}).filter((k) => (a.items[k] ?? 0) > 0);
	const bKeys = Object.keys(b.items ?? {}).filter((k) => (b.items[k] ?? 0) > 0);
	if (aKeys.length !== bKeys.length) return false;
	for (const k of bKeys) {
		if ((a.items[k] ?? 0) !== (b.items[k] ?? 0)) return false;
	}
	return true;
}

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
	const allowedStates = ["active", "initiator_locked", "target_locked", "both_locked"];
	if (!allowedStates.includes(trade.state as string)) {
		return NextResponse.json({ error: `Cannot update offer in ${trade.state} state` }, { status: 400 });
	}

	// Validate player has what they're offering
	const { data: herzie } = await admin
		.from("herzies")
		.select("inventory_v2, currency")
		.eq("user_id", auth.userId)
		.single();

	if (!herzie) {
		return NextResponse.json({ error: "Herzie not found" }, { status: 404 });
	}

	const inv = (herzie.inventory_v2 ?? {}) as Record<string, number>;

	if ((herzie.currency as number) < offer.currency) {
		return NextResponse.json({ error: "Not enough currency" }, { status: 400 });
	}

	for (const [itemId, qty] of Object.entries(offer.items)) {
		if ((inv[itemId] ?? 0) < qty) {
			return NextResponse.json({ error: `Not enough ${itemId}` }, { status: 400 });
		}
	}

	// Only reset locks if the offer actually changed. Resending the same offer
	// (which happens on every Lock click — see TradeView.handleLock) must be a
	// no-op for state, otherwise simultaneous locks ping-pong each other and
	// the trade can never reach both_locked.
	const currentOffer = (isInitiator ? trade.initiator_offer : trade.target_offer) as
		| { items: Record<string, number>; currency: number }
		| null;
	const offerChanged = !offersEqual(currentOffer, offer);

	const update: Record<string, unknown> = {
		updated_at: new Date().toISOString(),
	};

	if (isInitiator) {
		update.initiator_offer = offer;
	} else {
		update.target_offer = offer;
	}

	if (offerChanged) {
		update.state = "active";
		update.initiator_accepted = false;
		update.target_accepted = false;
	}

	const { error } = await admin
		.from("trades")
		.update(update)
		.eq("id", tradeId);

	if (error) {
		return NextResponse.json({ error: "Failed to update offer" }, { status: 500 });
	}

	return NextResponse.json({ ok: true });
}
