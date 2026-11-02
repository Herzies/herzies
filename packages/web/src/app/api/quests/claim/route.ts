import {
  bankCapacity,
  bankSlotsUsed,
  getQuest,
  normalizeEquipped,
} from "@herzies/shared";
import { NextResponse } from "next/server";
import { authenticateRequest, isAuthError } from "@/lib/auth";
import { type ItemState, itemResponse } from "@/lib/item-units";
import { loadQuestBoard } from "@/lib/quests";
import { createAdminClient } from "@/lib/supabase-admin";

const REASONS: Record<string, { status: number; error: string }> = {
  "not-found": { status: 404, error: "Quest not found" },
  "not-complete": { status: 400, error: "That quest isn't finished yet" },
  "already-claimed": { status: 409, error: "Already turned in" },
};

/** Turn a finished quest in to its giver. The reward comes from the quest's
 * definition, never the client: XP lands on the next sync (pending_xp),
 * coins and items straight away. Answers with the new coin total, the item
 * state when items came, and the fresh board. */
export async function POST(request: Request) {
  const auth = await authenticateRequest(request);
  if (isAuthError(auth)) return auth;

  const body = (await request.json().catch(() => null)) as {
    id?: unknown;
  } | null;
  const id = typeof body?.id === "string" ? body.id : "";
  if (!/^[0-9a-f-]{36}$/i.test(id)) {
    return NextResponse.json({ error: "Bad quest id" }, { status: 400 });
  }

  const admin = createAdminClient();
  const { data: row } = await admin
    .from("user_quests")
    .select("quest_id")
    .eq("id", id)
    .eq("user_id", auth.userId)
    .maybeSingle();
  if (!row) {
    return NextResponse.json({ error: "Quest not found" }, { status: 404 });
  }
  const reward = getQuest(row.quest_id as string)?.reward ?? { coins: 0 };
  const items = reward.items ?? [];

  // Same bank-space rule as Medea: copies past the bank's capacity would
  // never render. The quest stays finished, to turn in once there's room.
  if (items.length > 0) {
    const { data: herzie } = await admin
      .from("herzies")
      .select("inventory_v2, equipped, bank_expansions")
      .eq("user_id", auth.userId)
      .single();
    const inv = { ...((herzie?.inventory_v2 ?? {}) as Record<string, number>) };
    for (const it of items)
      inv[it.itemId] = (inv[it.itemId] ?? 0) + it.quantity;
    if (
      herzie &&
      bankSlotsUsed(inv, normalizeEquipped(herzie.equipped)) >
        bankCapacity(herzie.bank_expansions)
    ) {
      return NextResponse.json(
        { error: "Your bank is full — make some room first", reason: "full" },
        { status: 409 },
      );
    }
  }

  const { data, error } = await admin.rpc("quest_claim", {
    p_user: auth.userId,
    p_id: id,
    p_xp: 0,
    p_coins: reward.coins,
    p_items: items,
  });
  if (error) {
    return NextResponse.json({ error: "Failed to turn in" }, { status: 500 });
  }
  const result = data as {
    ok: boolean;
    reason?: string;
    newCurrency?: number;
    state?: ItemState;
  } | null;
  if (!result?.ok) {
    const known = REASONS[result?.reason ?? ""];
    return NextResponse.json(
      { error: known?.error ?? "Failed to turn in", reason: result?.reason },
      { status: known?.status ?? 400 },
    );
  }

  const board = await loadQuestBoard(admin, auth.userId);
  return NextResponse.json({
    ok: true,
    reward,
    newCurrency: result.newCurrency,
    ...(result.state ? itemResponse(result.state) : {}),
    board,
  });
}
