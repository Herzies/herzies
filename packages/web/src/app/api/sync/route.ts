import type { SyncResponse } from "@herzies/shared";
import { NextResponse } from "next/server";
import { authenticateRequest, isAuthError } from "@/lib/auth";
import { processSync } from "@/lib/game-server";
import { isParseError, parseBody, syncRequestSchema } from "@/lib/schemas";
import { createAdminClient } from "@/lib/supabase-admin";

export async function POST(request: Request) {
  const auth = await authenticateRequest(request);
  if (isAuthError(auth)) return auth;

  const body = await parseBody(request, syncRequestSchema);
  if (isParseError(body)) return body;

  const { nowPlaying, minutesListened, genres } = body;

  try {
    const admin = createAdminClient();
    const result = await processSync(
      admin,
      auth.userId,
      nowPlaying,
      minutesListened,
      genres,
    );

    const response: SyncResponse = {
      herzie: result.herzie,
      notifications: result.notifications,
      multipliers: result.multipliers,
      pendingTradeRequest: result.pendingTradeRequest,
      pendingFriendRequest: result.pendingFriendRequest,
      incomingFriendRequests: result.incomingFriendRequests,
      outgoingFriendRequests: result.outgoingFriendRequests,
    };

    return NextResponse.json(response);
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Internal server error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
