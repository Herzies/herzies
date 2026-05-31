import { z } from "zod";

// --- Shared helpers ---

const tradeIdBody = z.object({ tradeId: z.string().min(1) });

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
    })
    .nullable(),
  minutesListened: z.number().nonnegative().max(10),
  genres: z.array(z.string()).default([]),
});

export const sellItemSchema = z.object({
  itemId: z.string().min(1),
  quantity: z.number().int().min(1),
});

export const equipItemSchema = z.object({
  itemId: z.string().min(1),
  action: z.enum(["equip", "unequip"]),
});

export const createTradeSchema = z.object({
  targetFriendCode: z.string().min(1),
});

export const tradeIdSchema = tradeIdBody;

export const tradeOfferSchema = z.object({
  tradeId: z.string().min(1),
  offer: z.object({
    items: z.record(z.string(), z.number().int().min(1)),
    currency: z.number().int().nonnegative(),
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

export const adminItemSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string().optional(),
  rarity: z.enum(["common", "uncommon", "rare", "legendary"]),
  sellPrice: z.number().int().nonnegative().nullable().optional(),
  stackable: z.boolean().optional(),
  equipable: z.boolean().optional(),
  equipSlot: z.enum(["head", "scenery"]).nullable().optional(),
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
