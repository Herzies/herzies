import { z } from "zod";

// --- Shared helpers ---

const tradeIdBody = z.object({ tradeId: z.string().min(1) });

/** A unit id. guid, not uuid: zod's strict uuid rejects ids whose version bits
 * aren't RFC 4122, and all that matters here is that it parses as one. */
const unitId = z.guid();

// --- Schemas ---

export const registerHerzieSchema = z.object({
  name: z
    .string()
    .min(1)
    .max(20)
    .regex(/^[a-zA-Z0-9 _-]+$/),
  appearance: z.record(z.string(), z.unknown()),
  friendCode: z.string().min(1),
});

export const syncRequestSchema = z.object({
  nowPlaying: z
    .object({
      title: z.string(),
      artist: z.string(),
      genre: z.string().optional(),
      // Last.fm's remote artwork URL only — never the local system/data: URL,
      // which can be a multi-MB base64 blob unfit for DB storage or for other
      // viewers' clients to fetch. No `.url()` check: a malformed value here
      // should just mean no thumbnail, not a 400 that drops the whole sync
      // (and with it this tick's XP).
      albumArtUrl: z.string().max(500).optional(),
    })
    .nullable(),
  minutesListened: z.number().nonnegative().max(10),
  genres: z.array(z.string()).default([]),
});

/** Sell named copies. Older clients (which only knew item ids) send
 * `{itemId, quantity}` instead; the route resolves that to specific copies. */
export const sellItemSchema = z.union([
  z.object({ unitIds: z.array(unitId).min(1).max(500) }),
  z.object({
    itemId: z.string().min(1),
    quantity: z.number().int().min(1),
  }),
]);

export const buyItemSchema = z.object({
  itemId: z.string().min(1),
  quantity: z.number().int().min(1),
});

const equipAction = z.enum(["equip", "unequip"]);
/** Required when equipping a ground-category item. */
const equipSide = z.enum(["left", "right"]).optional();

/** Equip one named copy. `{itemId}` is the older client's spelling. */
export const equipItemSchema = z.union([
  z.object({ unitId, action: equipAction, side: equipSide }),
  z.object({
    itemId: z.string().min(1),
    action: equipAction,
    side: equipSide,
  }),
]);

/** Upgrade one named copy. `{targetItemId}` is the older client's spelling. */
export const upgradeItemSchema = z.union([
  z.object({ diceItemId: z.string().min(1), targetUnitId: unitId }),
  z.object({
    diceItemId: z.string().min(1),
    targetItemId: z.string().min(1),
  }),
]);

export const createTradeSchema = z.object({
  targetFriendCode: z.string().min(1),
});

export const tradeIdSchema = tradeIdBody;

export const tradeOfferSchema = z.object({
  tradeId: z.string().min(1),
  // What you're giving: named copies (`units`), or — from a client that
  // predates them — a count per item id (`items`) that the route resolves to
  // copies. At least one of the two must be present, even if empty.
  offer: z
    .object({
      units: z.array(unitId).max(500).optional(),
      items: z.record(z.string(), z.number().int().min(1)).optional(),
      currency: z.number().int().nonnegative(),
    })
    .refine((o) => o.units !== undefined || o.items !== undefined, {
      message: "offer needs units or items",
    }),
});

export const friendCodePairSchema = z.object({
  myCode: z.string().min(1),
  theirCode: z.string().min(1),
});

export const friendRequestIdSchema = z.object({
  requestId: z.string().min(1),
});

export const claimEventSchema = z.object({
  eventId: z.string().min(1),
});

export const hintAudioPlaySchema = z.object({
  eventId: z.string().min(1),
  hintIndex: z.number().int().nonnegative(),
});

export const refreshTokenSchema = z.object({
  refreshToken: z.string().min(1),
});

export const adminEventSchema = z.object({
  id: z.string().optional(),
  type: z.string().min(1),
  title: z.string().min(1),
  description: z.string().optional(),
  active: z.boolean().optional(),
  startsAt: z.string().min(1),
  endsAt: z.string().min(1),
  config: z.record(z.string(), z.unknown()).optional(),
});

export const adminBossSettingsSchema = z.object({
  autoSpawn: z.boolean(),
  /** null = scale with active players. */
  defaultHp: z.number().positive().nullable(),
  rewardItemId: z.string().min(1),
  topRewardItemId: z.string().min(1).nullable(),
  topCount: z.number().int().nonnegative(),
});

export const adminBossSkipSchema = z.object({
  /** UTC date (YYYY-MM-DD) of the Thursday the weekly spawn should skip. */
  weekOf: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  skip: z.boolean(),
});

export const adminItemSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string().optional(),
  rarity: z.enum(["common", "uncommon", "rare", "legendary"]),
  sellPrice: z.number().int().nonnegative().nullable().optional(),
  stackable: z.boolean().optional(),
  equipable: z.boolean().optional(),
  equipSlot: z
    .enum(["head", "face", "body", "scenery", "ground", "modifier"])
    .nullable()
    .optional(),
});

export const adminMultiplierSchema = z.object({
  id: z.string().optional(),
  name: z.string().min(1),
  bonus: z.number(),
  active: z.boolean().optional(),
  startsAt: z.string().min(1),
  endsAt: z.string().min(1),
  schedule: z.string().nullable().optional(),
});

export const checkoutSchema = z.object({
  productId: z.string().min(1),
});

export const grantItemSchema = z
  .object({
    itemId: z.string().min(1),
    herzieName: z.string().optional(),
    friendCode: z.string().optional(),
    quantity: z.number().int().positive().optional(),
  })
  .refine((d) => d.herzieName || d.friendCode, {
    message: "herzieName or friendCode is required",
  });

/** Parse request JSON with a Zod schema. Returns parsed data or a 400 Response. */
export async function parseBody<T>(
  request: Request,
  schema: z.ZodType<T>,
): Promise<T | Response> {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    const { NextResponse } = await import("next/server");
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const result = schema.safeParse(raw);
  if (!result.success) {
    const { NextResponse } = await import("next/server");
    return NextResponse.json(
      { error: result.error.issues[0].message },
      { status: 400 },
    );
  }

  return result.data;
}

/** Type guard: true if parseBody returned an error Response */
export function isParseError<T>(value: T | Response): value is Response {
  return value instanceof Response;
}
