import { NextResponse } from "next/server";
import { unauthorizedAdmin, verifyAdmin } from "@/lib/admin-auth";
import { grantItemSchema, isParseError, parseBody } from "@/lib/schemas";
import { createAdminClient } from "@/lib/supabase-admin";

/** Manually grant an item to a user by name or friend code */
export async function POST(request: Request) {
  if (!verifyAdmin(request)) {
    return unauthorizedAdmin();
  }

  const body = await parseBody(request, grantItemSchema);
  if (isParseError(body)) return body;

  const { itemId, herzieName, friendCode } = body;
  const quantity = body.quantity ?? 1;

  const admin = createAdminClient();

  // Ensure the item exists in the catalog before granting it.
  const { data: item } = await admin
    .from("items")
    .select("id")
    .eq("id", itemId)
    .maybeSingle();
  if (!item) {
    return NextResponse.json(
      { error: `Item "${itemId}" is not in the catalog` },
      { status: 404 },
    );
  }

  // Find the herzie
  let query = admin.from("herzies").select("user_id");
  if (herzieName) {
    query = query.ilike("name", herzieName);
  } else {
    query = query.eq("friend_code", friendCode!);
  }

  const { data: herzie } = await query.single();
  if (!herzie) {
    return NextResponse.json({ error: "Herzie not found" }, { status: 404 });
  }

  // The same grant every other reward goes through, so a granted item is a
  // real owned copy (a row in item_units) like any other — a direct write to
  // the inventory column would be rejected, since that column is derived.
  const { error } = await admin.rpc("grant_inventory_item", {
    p_user_id: herzie.user_id,
    p_item_id: itemId,
    p_quantity: quantity,
  });

  if (error) {
    return NextResponse.json(
      { error: "Failed to grant item" },
      { status: 500 },
    );
  }

  const { data: after } = await admin
    .from("herzies")
    .select("inventory_v2")
    .eq("user_id", herzie.user_id)
    .single();
  const inv = (after?.inventory_v2 ?? {}) as Record<string, number>;

  return NextResponse.json({
    ok: true,
    itemId,
    quantity,
    total: inv[itemId] ?? 0,
  });
}
