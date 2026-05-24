import { NextResponse } from "next/server";
import { authenticateRequest, isAuthError } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase-admin";
import { equipItemSchema, parseBody, isParseError } from "@/lib/schemas";

export async function POST(request: Request) {
	const auth = await authenticateRequest(request);
	if (isAuthError(auth)) return auth;

	const body = await parseBody(request, equipItemSchema);
	if (isParseError(body)) return body;

	const { itemId, action } = body;

	const admin = createAdminClient();

	// Verify item is equipable
	const { data: item } = await admin
		.from("items")
		.select("id, equipable, equip_slot")
		.eq("id", itemId)
		.single();

	if (!item || !item.equipable) {
		return NextResponse.json({ error: "Item is not equipable" }, { status: 400 });
	}

	// Fetch player data
	const { data: herzie } = await admin
		.from("herzies")
		.select("inventory_v2, equipped")
		.eq("user_id", auth.userId)
		.single();

	if (!herzie) {
		return NextResponse.json({ error: "Herzie not found" }, { status: 404 });
	}

	const inv = (herzie.inventory_v2 ?? {}) as Record<string, number>;
	const current: string[] = (herzie.equipped as string[]) ?? [];
	let updated: string[];

	if (action === "equip") {
		if ((inv[itemId] ?? 0) < 1) {
			return NextResponse.json({ error: "Item not in inventory" }, { status: 400 });
		}
		if (current.includes(itemId)) {
			return NextResponse.json({ error: "Already equipped" }, { status: 400 });
		}

		let cleared = current;
		if (item.equip_slot) {
			const { data: slotItems } = await admin
				.from("items")
				.select("id")
				.eq("equip_slot", item.equip_slot);
			const slotIds = new Set((slotItems ?? []).map((row) => row.id));
			cleared = current.filter((id) => !slotIds.has(id));
		}
		updated = [...cleared, itemId];
	} else {
		if (!current.includes(itemId)) {
			return NextResponse.json({ error: "Item not equipped" }, { status: 400 });
		}
		updated = current.filter((id) => id !== itemId);
	}

	const { error } = await admin
		.from("herzies")
		.update({ equipped: updated })
		.eq("user_id", auth.userId);

	if (error) {
		return NextResponse.json({ error: error.message }, { status: 500 });
	}

	return NextResponse.json({ ok: true, equipped: updated });
}
