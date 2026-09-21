import { GENRES } from "@herzies/shared";
import { NextResponse } from "next/server";
import type { z } from "zod";
import { unauthorizedAdmin, verifyAdmin } from "@/lib/admin-auth";
import { adminEventSchema, isParseError, parseBody } from "@/lib/schemas";
import { createAdminClient } from "@/lib/supabase-admin";

type AdminEventBody = z.infer<typeof adminEventSchema>;

/** List all events */
export async function GET(request: Request) {
  if (!verifyAdmin(request)) {
    return unauthorizedAdmin();
  }

  const admin = createAdminClient();
  const { data, error } = await admin
    .from("events")
    .select("*")
    .order("created_at", { ascending: false });

  if (error) {
    return NextResponse.json(
      { error: "Failed to fetch events" },
      { status: 500 },
    );
  }

  // Live HP for bosses, so the list shows how a fight is going and the edit
  // form starts from the real pool rather than the config copy.
  const bossIds = (data ?? [])
    .filter((e) => e.type === "boss_fight")
    .map((e) => e.id);
  const { data: states } = bossIds.length
    ? await admin
        .from("boss_state")
        .select("event_id, hp, max_hp, killed, escaped")
        .in("event_id", bossIds)
    : { data: [] };

  const events = (data ?? []).map((e) => {
    const state = states?.find((s) => s.event_id === e.id);
    return state
      ? {
          ...e,
          boss: {
            hp: state.hp,
            maxHp: state.max_hp,
            killed: state.killed,
            escaped: state.escaped,
          },
        }
      : e;
  });

  return NextResponse.json({ events });
}

/** Create or update an event */
export async function POST(request: Request) {
  if (!verifyAdmin(request)) {
    return unauthorizedAdmin();
  }

  const body = await parseBody(request, adminEventSchema);
  if (isParseError(body)) return body;

  const { id, type, title, description, active, startsAt, endsAt, config } =
    body;

  const admin = createAdminClient();

  if (type === "boss_fight") {
    return saveBossFight(admin, body);
  }

  // If an event has a rewardItemId, ensure the item exists in the items table
  if (config?.rewardItemId) {
    const { data: existingItem } = await admin
      .from("items")
      .select("id")
      .eq("id", config.rewardItemId as string)
      .single();

    if (!existingItem) {
      // Auto-create the item entry
      await admin.from("items").insert({
        id: config.rewardItemId,
        name: (config.rewardItemName as string) ?? title,
        description:
          (config.rewardItemDescription as string) ?? `Reward for: ${title}`,
        rarity: (config.rewardItemRarity as string) ?? "legendary",
      });
    }
  }

  if (id) {
    // Update existing event
    const { data, error } = await admin
      .from("events")
      .update({
        type,
        title,
        description: description ?? null,
        active: active ?? true,
        starts_at: startsAt,
        ends_at: endsAt,
        config: config ?? {},
      })
      .eq("id", id)
      .select()
      .single();

    if (error) {
      return NextResponse.json(
        { error: "Failed to update event" },
        { status: 500 },
      );
    }
    return NextResponse.json({ event: data });
  }

  // Create new event
  const { data, error } = await admin
    .from("events")
    .insert({
      type,
      title,
      description: description ?? null,
      active: active ?? true,
      starts_at: startsAt,
      ends_at: endsAt,
      config: config ?? {},
    })
    .select()
    .single();

  if (error) {
    return NextResponse.json(
      { error: "Failed to create event" },
      { status: 500 },
    );
  }

  return NextResponse.json({ event: data }, { status: 201 });
}

/**
 * Create or update a boss_fight event.
 *
 * Separate from the generic path because a boss is two rows: the event, and a
 * boss_state row holding its HP. Without the second one sync_context never
 * reports the boss and deal_boss_damage drops every hit, so the event would
 * look live and be unkillable.
 */
async function saveBossFight(
  admin: ReturnType<typeof createAdminClient>,
  body: AdminEventBody,
) {
  const { id, title, description, active, startsAt, endsAt } = body;
  const config = body.config ?? {};

  const hatedGenres = config.hatedGenres;
  if (
    !Array.isArray(hatedGenres) ||
    hatedGenres.length === 0 ||
    !hatedGenres.every((g) => (GENRES as readonly unknown[]).includes(g))
  ) {
    return badRequest(`hatedGenres must be a non-empty subset of GENRES`);
  }

  const maxHp = Number(config.maxHp);
  if (!Number.isFinite(maxHp) || maxHp <= 0) {
    return badRequest("maxHp must be a positive number");
  }

  if (new Date(endsAt) <= new Date(startsAt)) {
    return badRequest("Boss must end after it starts");
  }

  // Unlike other events, reward items are never auto-created: settle_boss_fight
  // grants them long after this form is closed, and a typo would only surface
  // as a failed payout.
  const itemIds = [config.rewardItemId, config.topRewardItemId].filter(
    (v): v is string => typeof v === "string" && v.length > 0,
  );
  if (typeof config.rewardItemId !== "string" || !config.rewardItemId) {
    return badRequest("rewardItemId is required");
  }
  const { data: items } = await admin
    .from("items")
    .select("id")
    .in("id", itemIds);
  const missing = itemIds.filter((i) => !items?.some((row) => row.id === i));
  if (missing.length > 0) {
    return badRequest(`Unknown item: ${missing.join(", ")}`);
  }

  // At most one boss at a time: sync_context picks "the" active boss.
  if (active ?? true) {
    let overlap = admin
      .from("events")
      .select("id, title")
      .eq("type", "boss_fight")
      .eq("active", true)
      .lt("starts_at", endsAt)
      .gt("ends_at", startsAt);
    if (id) overlap = overlap.neq("id", id);
    const { data: clash } = await overlap.limit(1);
    if (clash && clash.length > 0) {
      return NextResponse.json(
        { error: `Overlaps another boss fight: "${clash[0].title}"` },
        { status: 409 },
      );
    }
  }

  const row = {
    type: "boss_fight",
    title,
    description: description ?? null,
    active: active ?? true,
    starts_at: startsAt,
    ends_at: endsAt,
    config: {
      hatedGenres,
      rewardItemId: config.rewardItemId,
      topRewardItemId:
        typeof config.topRewardItemId === "string" && config.topRewardItemId
          ? config.topRewardItemId
          : undefined,
      topCount: Number.isInteger(config.topCount) ? config.topCount : 3,
      maxHp,
    },
  };

  if (id) {
    // HP first: it is the half that can be refused (boss already dead, or the
    // new pool is smaller than the damage already dealt).
    const { error: hpError } = await admin.rpc("admin_set_boss_hp", {
      p_event_id: id,
      p_max_hp: maxHp,
    });
    if (hpError) return badRequest(hpError.message);

    const { data, error } = await admin
      .from("events")
      .update(row)
      .eq("id", id)
      .select()
      .single();
    if (error) {
      return NextResponse.json(
        { error: "Failed to update event" },
        { status: 500 },
      );
    }
    return NextResponse.json({ event: data });
  }

  const { data, error } = await admin
    .from("events")
    .insert(row)
    .select()
    .single();
  if (error || !data) {
    return NextResponse.json(
      { error: "Failed to create event" },
      { status: 500 },
    );
  }

  const { error: hpError } = await admin.rpc("admin_set_boss_hp", {
    p_event_id: data.id,
    p_max_hp: maxHp,
  });
  if (hpError) {
    // Don't leave a boss with no HP pool behind.
    await admin.from("events").delete().eq("id", data.id);
    return badRequest(hpError.message);
  }

  return NextResponse.json({ event: data }, { status: 201 });
}

function badRequest(error: string) {
  return NextResponse.json({ error }, { status: 400 });
}

/** Delete an event */
export async function DELETE(request: Request) {
  if (!verifyAdmin(request)) {
    return unauthorizedAdmin();
  }

  const { searchParams } = new URL(request.url);
  const id = searchParams.get("id");

  if (!id) {
    return NextResponse.json(
      { error: "id query param is required" },
      { status: 400 },
    );
  }

  const admin = createAdminClient();
  const { error } = await admin.from("events").delete().eq("id", id);

  if (error) {
    return NextResponse.json(
      { error: "Failed to delete event" },
      { status: 500 },
    );
  }

  return NextResponse.json({ ok: true });
}
