import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase-admin";
import { unauthorizedAdmin, verifyAdmin } from "@/lib/admin-auth";
import { adminItemSchema, isParseError, parseBody } from "@/lib/schemas";

/** List all catalog items */
export async function GET(request: Request) {
	if (!verifyAdmin(request)) {
		return unauthorizedAdmin();
	}

	const admin = createAdminClient();
	const { data, error } = await admin
		.from("items")
		.select("*")
		.order("id", { ascending: true });

	if (error) {
		return NextResponse.json({ error: "Failed to fetch items" }, { status: 500 });
	}

	return NextResponse.json({ items: data });
}

/** Create or update a catalog item */
export async function POST(request: Request) {
	if (!verifyAdmin(request)) {
		return unauthorizedAdmin();
	}

	const body = await parseBody(request, adminItemSchema);
	if (isParseError(body)) return body;

	const { id, name, description, rarity, sellPrice, stackable, equipable } = body;

	const row = {
		id,
		name,
		description: description ?? "",
		rarity,
		sell_price: sellPrice ?? null,
		stackable: stackable ?? false,
		equipable: equipable ?? false,
	};

	const admin = createAdminClient();
	const { data: existing } = await admin.from("items").select("id").eq("id", id).maybeSingle();

	if (existing) {
		const { data, error } = await admin
			.from("items")
			.update({
				name: row.name,
				description: row.description,
				rarity: row.rarity,
				sell_price: row.sell_price,
				stackable: row.stackable,
				equipable: row.equipable,
			})
			.eq("id", id)
			.select()
			.single();

		if (error) {
			return NextResponse.json({ error: "Failed to update item" }, { status: 500 });
		}
		return NextResponse.json({ item: data });
	}

	const { data, error } = await admin.from("items").insert(row).select().single();

	if (error) {
		return NextResponse.json({ error: "Failed to create item" }, { status: 500 });
	}

	return NextResponse.json({ item: data }, { status: 201 });
}

/** Delete a catalog item */
export async function DELETE(request: Request) {
	if (!verifyAdmin(request)) {
		return unauthorizedAdmin();
	}

	const { searchParams } = new URL(request.url);
	const id = searchParams.get("id");

	if (!id) {
		return NextResponse.json({ error: "id query param is required" }, { status: 400 });
	}

	const admin = createAdminClient();
	const { error } = await admin.from("items").delete().eq("id", id);

	if (error) {
		return NextResponse.json({ error: "Failed to delete item" }, { status: 500 });
	}

	return NextResponse.json({ ok: true });
}
