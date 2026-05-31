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
  let query = admin.from("herzies").select("user_id, inventory_v2");
  if (herzieName) {
    query = query.ilike("name", herzieName);
  } else {
    query = query.eq("friend_code", friendCode!);
  }

  const { data: herzie } = await query.single();
  if (!herzie) {
    return NextResponse.json({ error: "Herzie not found" }, { status: 404 });
  }

  const inv = (herzie.inventory_v2 ?? {}) as Record<string, number>;
  inv[itemId] = (inv[itemId] ?? 0) + quantity;

  const { error } = await admin
    .from("herzies")
    .update({ inventory_v2: inv })
    .eq("user_id", herzie.user_id);

  if (error) {
    return NextResponse.json(
      { error: "Failed to grant item" },
      { status: 500 },
    );
  }

  return NextResponse.json({
    ok: true,
    itemId,
    quantity,
    total: inv[itemId],
  });
}
