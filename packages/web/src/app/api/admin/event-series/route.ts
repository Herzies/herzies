import { NextResponse } from "next/server";
import type { z } from "zod";
import { unauthorizedAdmin, verifyAdmin } from "@/lib/admin-auth";
import {
  type ConfigResult,
  validateBossConfig,
  validateMerchantConfig,
} from "@/lib/event-config";
import { adminEventSeriesSchema, isParseError, parseBody } from "@/lib/schemas";
import { createAdminClient } from "@/lib/supabase-admin";

/**
 * Recurring event series (00081).
 *
 * A series is only a template and a schedule. materialize_event_series writes
 * each upcoming slot out as an ordinary events row, and those rows are what
 * the admin edits, skips or deletes one at a time via /api/admin/events.
 */
export async function GET(request: Request) {
  if (!verifyAdmin(request)) {
    return unauthorizedAdmin();
  }

  const admin = createAdminClient();
  const { data, error } = await admin
    .from("event_series")
    .select("*")
    .order("created_at", { ascending: true });

  if (error) {
    return NextResponse.json(
      { error: "Failed to fetch event series" },
      { status: 500 },
    );
  }

  return NextResponse.json({ series: data ?? [] });
}

/** Create or update a series, then top up its occurrences. */
export async function POST(request: Request) {
  if (!verifyAdmin(request)) {
    return unauthorizedAdmin();
  }

  const body = await parseBody(request, adminEventSeriesSchema);
  if (isParseError(body)) return body;

  const admin = createAdminClient();

  if (Number.isNaN(new Date(body.anchorAt).getTime())) {
    return badRequest("First start is not a valid date");
  }
  if (body.until && new Date(body.until) <= new Date(body.anchorAt)) {
    return badRequest("The series must end after its first start");
  }

  const template = await validateTemplate(admin, body);
  if ("error" in template) return badRequest(template.error);

  const row = {
    type: body.type,
    title: body.title,
    description: body.description ?? null,
    enabled: body.enabled ?? true,
    anchor_at: body.anchorAt,
    interval_days: body.intervalDays,
    duration_minutes: body.durationMinutes,
    until: body.until ?? null,
    config_template: template.config,
    updated_at: new Date().toISOString(),
  };

  let seriesId = body.id;
  if (seriesId) {
    const { data: existing } = await admin
      .from("event_series")
      .select("type")
      .eq("id", seriesId)
      .maybeSingle();
    if (!existing) {
      return NextResponse.json({ error: "Series not found" }, { status: 404 });
    }
    if (existing.type !== body.type) {
      return badRequest("A series cannot change type");
    }

    const { error } = await admin
      .from("event_series")
      .update(row)
      .eq("id", seriesId);
    if (error) {
      return NextResponse.json(
        { error: "Failed to update series" },
        { status: 500 },
      );
    }
    // Regenerate from the new schedule and template, but only what nobody has
    // touched: skipped and hand-edited occurrences stay exactly as they are.
    const cleared = await deleteUntouchedFuture(admin, seriesId);
    if (cleared) return cleared;
  } else {
    const { data, error } = await admin
      .from("event_series")
      .insert(row)
      .select("id")
      .single();
    if (error || !data) {
      return NextResponse.json(
        { error: "Failed to create series" },
        { status: 500 },
      );
    }
    seriesId = data.id as string;
  }

  const { data: created, error: materializeError } = await admin.rpc(
    "materialize_event_series",
    { p_series_id: seriesId },
  );
  if (materializeError) {
    return NextResponse.json(
      { error: `Saved, but scheduling failed: ${materializeError.message}` },
      { status: 500 },
    );
  }

  return NextResponse.json(
    { id: seriesId, created: created as number },
    { status: body.id ? 200 : 201 },
  );
}

/**
 * Delete a series and its future untouched occurrences. Anything live,
 * finished, skipped or hand-edited is kept (and simply loses its series link).
 */
export async function DELETE(request: Request) {
  if (!verifyAdmin(request)) {
    return unauthorizedAdmin();
  }

  const id = new URL(request.url).searchParams.get("id");
  if (!id) {
    return badRequest("id query param is required");
  }

  const admin = createAdminClient();
  const cleared = await deleteUntouchedFuture(admin, id);
  if (cleared) return cleared;

  const { error } = await admin.from("event_series").delete().eq("id", id);
  if (error) {
    return NextResponse.json(
      { error: "Failed to delete series" },
      { status: 500 },
    );
  }

  return NextResponse.json({ ok: true });
}

async function deleteUntouchedFuture(
  admin: ReturnType<typeof createAdminClient>,
  seriesId: string,
) {
  const { error } = await admin
    .from("events")
    .delete()
    .eq("series_id", seriesId)
    .eq("customized", false)
    .eq("skipped", false)
    .gt("starts_at", new Date().toISOString());
  if (error) {
    return NextResponse.json(
      { error: "Failed to clear upcoming occurrences" },
      { status: 500 },
    );
  }
  return null;
}

async function validateTemplate(
  admin: ReturnType<typeof createAdminClient>,
  body: z.infer<typeof adminEventSeriesSchema>,
): Promise<ConfigResult> {
  const config = body.configTemplate ?? {};
  if (body.type === "boss_fight") {
    return validateBossConfig(admin, config, { template: true });
  }
  if (body.type === "merchant") {
    return validateMerchantConfig(admin, config);
  }
  // Song hunts: the reward carries over to every week; the track and hints
  // are curated per occurrence.
  const maxClaims = Number(config.maxClaims ?? 50);
  if (!Number.isInteger(maxClaims) || maxClaims <= 0) {
    return { error: "maxClaims must be a positive whole number" };
  }
  return {
    config: {
      ...(typeof config.rewardItemId === "string" && config.rewardItemId
        ? { rewardItemId: config.rewardItemId }
        : {}),
      maxClaims,
    },
  };
}

function badRequest(error: string) {
  return NextResponse.json({ error }, { status: 400 });
}
