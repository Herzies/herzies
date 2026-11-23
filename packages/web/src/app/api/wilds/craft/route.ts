import { getItem, recipeFor } from "@herzies/shared";
import { NextResponse } from "next/server";
import { authenticateRequest, isAuthError } from "@/lib/auth";
import { type ItemState, itemResponse } from "@/lib/item-units";
import { isParseError, parseBody, wildsCraftSchema } from "@/lib/schemas";
import { createAdminClient } from "@/lib/supabase-admin";

/**
 * Crafts a Wilds instrument (wilds-loot.ts WILDS_RECIPES) from a copy of its
 * base instrument and bits. The base copy must be in the bag — not worn, no
 * loadout holding it — and is used up; the new instrument keeps its upgrade
 * level. The recipe's costs come from the shared table here; wilds_craft
 * (00154) checks and takes them under the herzie's row lock.
 */
export async function POST(request: Request) {
  const auth = await authenticateRequest(request);
  if (isAuthError(auth)) return auth;

  const body = await parseBody(request, wildsCraftSchema);
  if (isParseError(body)) return body;

  const recipe = recipeFor(body.recipe);
  if (!recipe) {
    return NextResponse.json(
      { error: "The Crafting Station can't make that" },
      { status: 400 },
    );
  }
  const base = getItem(recipe.base)?.name ?? "base instrument";

  const admin = createAdminClient();
  const { data, error } = await admin.rpc("wilds_craft", {
    p_user: auth.userId,
    p_item: recipe.id,
    p_base: recipe.base,
    p_bits: recipe.bits,
  });
  if (error) {
    return NextResponse.json({ error: "Crafting failed" }, { status: 500 });
  }

  const result = data as {
    ok: boolean;
    reason?: string;
    unitId?: string;
    state?: ItemState;
  } | null;
  if (!result?.ok || !result.state || !result.unitId) {
    const reasons: Record<string, string> = {
      "not-found": "Herzie not found",
      "unknown-recipe": "The Crafting Station can't make that",
      "no-base": `You need a ${base} in your bag`,
      worn: `Take your ${base} off first`,
      held: `Your ${base} is in your other loadout`,
      "not-enough-bits": "You don't have enough bits for that",
    };
    return NextResponse.json(
      { error: reasons[result?.reason ?? ""] ?? "Crafting failed" },
      { status: 400 },
    );
  }

  return NextResponse.json({
    ok: true,
    item: recipe.id,
    unitId: result.unitId,
    ...itemResponse(result.state),
  });
}
