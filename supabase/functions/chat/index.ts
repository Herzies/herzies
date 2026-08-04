/**
 * `chat` Edge Function — port of `GET/POST /api/chat` from the Next.js game
 * server. Like `sync`, the chat endpoint is DB-bound (every call is a Postgres
 * read or write), so co-locating it with the database removes a Vercel
 * round-trip and serverless invocation cost.
 *
 * Only the platform glue (HTTP, auth, validation, sanitization) lives here.
 * The moderation + rate-limit rules are enforced by triggers on the
 * `chat_messages` table, so they apply regardless of which server inserts.
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { corsHeaders, jsonResponse } from "../_shared/cors.ts";

// Mirrors @herzies/shared (packages/shared/src/chat.ts). The Supabase runtime
// can't import the monorepo package, so keep these in sync by hand.
const CHAT_MESSAGE_MAX_LENGTH = 400;
const CHAT_RETENTION_HOURS = 24;
const CHAT_RETENTION_MS = CHAT_RETENTION_HOURS * 60 * 60 * 1000;

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

/** Last.fm track URLs are allowed in chat (e.g. /current_song). Others stripped. */
const LASTFM_CHAT_URL = /https:\/\/(?:www\.)?last\.fm\/music\/[^\s<>]+/gi;

function sanitizeContent(raw: string): string {
  let content = raw.trim();
  content = content.replace(/<[^>]*>/g, "");
  const preserved: string[] = [];
  content = content.replace(LASTFM_CHAT_URL, (match) => {
    const i = preserved.length;
    preserved.push(match);
    return `%%__HERZIES_LF_URL_${i}__%%`;
  });
  content = content.replace(/https?:\/\/\S+/gi, "");
  content = content.replace(/www\.\S+/gi, "");
  for (let i = 0; i < preserved.length; i++) {
    const p = preserved[i];
    if (p) content = content.replace(`%%__HERZIES_LF_URL_${i}__%%`, p);
  }
  return content.trim();
}

interface ChatRow {
  id: string;
  user_id: string;
  content: string;
  item_refs: string[] | null;
  user_refs: string[] | null;
  created_at: string;
}

function formatMessage(
  msg: ChatRow,
  username: string,
  friendCode: string | null,
) {
  return {
    id: msg.id,
    userId: msg.user_id,
    username,
    friendCode,
    content: msg.content,
    itemRefs: msg.item_refs ?? [],
    userRefs: msg.user_refs ?? [],
    createdAt: msg.created_at,
  };
}

async function handleGet(
  admin: SupabaseClient,
  request: Request,
): Promise<Response> {
  const url = new URL(request.url);
  const limit = Math.min(
    Math.max(parseInt(url.searchParams.get("limit") ?? "50", 10) || 50, 1),
    100,
  );

  // The global chat is ephemeral: never serve messages older than the
  // retention window, even if the scheduled purge hasn't run yet.
  const retentionCutoff = new Date(Date.now() - CHAT_RETENTION_MS).toISOString();

  const { data: messages, error } = await admin
    .from("chat_messages")
    .select("id, user_id, content, item_refs, user_refs, created_at")
    .gte("created_at", retentionCutoff)
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error) {
    return jsonResponse({ error: "Failed to fetch messages" }, 500);
  }

  if (!messages || messages.length === 0) {
    return jsonResponse({ messages: [] });
  }

  const userIds = [...new Set(messages.map((m) => m.user_id))];
  const { data: herzies } = await admin
    .from("herzies")
    .select("user_id, name, friend_code")
    .in("user_id", userIds);

  const herzieMap = new Map(
    (herzies ?? []).map((h) => [
      h.user_id,
      { name: h.name as string, friendCode: h.friend_code as string },
    ]),
  );

  const chronological = (messages as ChatRow[]).reverse().map((msg) => {
    const h = herzieMap.get(msg.user_id);
    return formatMessage(msg, h?.name ?? "Unknown", h?.friendCode ?? null);
  });

  return jsonResponse({ messages: chronological });
}

async function handlePost(
  admin: SupabaseClient,
  userId: string,
  request: Request,
): Promise<Response> {
  let body: {
    content?: unknown;
    itemRefs?: unknown;
    userRefs?: unknown;
  };
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: "Invalid JSON body" }, 400);
  }

  if (typeof body.content !== "string") {
    return jsonResponse({ error: "content is required" }, 400);
  }

  const content = sanitizeContent(body.content);
  if (content.length === 0) {
    return jsonResponse({ error: "content is empty after sanitization" }, 400);
  }
  if (content.length > CHAT_MESSAGE_MAX_LENGTH) {
    return jsonResponse(
      { error: `content exceeds ${CHAT_MESSAGE_MAX_LENGTH} characters` },
      400,
    );
  }

  let itemRefs: string[] = [];
  if (body.itemRefs !== undefined) {
    if (
      !Array.isArray(body.itemRefs) ||
      body.itemRefs.some((r: unknown) => typeof r !== "string")
    ) {
      return jsonResponse({ error: "itemRefs must be an array of strings" }, 400);
    }
    if (body.itemRefs.length > 10) {
      return jsonResponse({ error: "itemRefs cannot exceed 10 items" }, 400);
    }
    itemRefs = body.itemRefs as string[];
  }

  let userRefs: string[] = [];
  if (body.userRefs !== undefined) {
    if (
      !Array.isArray(body.userRefs) ||
      body.userRefs.some((r: unknown) => typeof r !== "string")
    ) {
      return jsonResponse({ error: "userRefs must be an array of strings" }, 400);
    }
    if (body.userRefs.length > 10) {
      return jsonResponse({ error: "userRefs cannot exceed 10 mentions" }, 400);
    }
    userRefs = body.userRefs as string[];
  }

  if (userRefs.length > 0) {
    const { data: me } = await admin
      .from("herzies")
      .select("friend_codes, friend_code")
      .eq("user_id", userId)
      .single();

    const allowed = new Set<string>(me?.friend_codes ?? []);
    const { data: recent } = await admin
      .from("chat_messages")
      .select("user_id")
      .order("created_at", { ascending: false })
      .limit(100);
    const participantIds = [...new Set((recent ?? []).map((m) => m.user_id))];
    if (participantIds.length > 0) {
      const { data: participants } = await admin
        .from("herzies")
        .select("friend_code")
        .in("user_id", participantIds);
      for (const p of participants ?? []) {
        if (p.friend_code) allowed.add(p.friend_code as string);
      }
    }
    if (me?.friend_code) allowed.delete(me.friend_code as string);

    for (const ref of userRefs) {
      if (!allowed.has(ref)) {
        return jsonResponse({ error: "Invalid user mention" }, 400);
      }
    }
  }

  const { data: msg, error } = await admin
    .from("chat_messages")
    .insert({
      user_id: userId,
      content,
      item_refs: itemRefs,
      user_refs: userRefs,
    })
    .select("id, user_id, content, item_refs, user_refs, created_at")
    .single();

  if (error || !msg) {
    if (error?.message?.includes("Rate limit")) {
      return jsonResponse({ error: "Slow down — only 1 message per second" }, 429);
    }
    if (error?.message?.includes("blocked content")) {
      return jsonResponse({ error: "Message contains blocked content" }, 400);
    }
    return jsonResponse({ error: "Failed to create message" }, 500);
  }

  const { data: herzie } = await admin
    .from("herzies")
    .select("name, friend_code")
    .eq("user_id", userId)
    .single();

  return jsonResponse({
    message: formatMessage(
      msg as ChatRow,
      herzie?.name ?? "Unknown",
      herzie?.friend_code ?? null,
    ),
  });
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }
  if (request.method !== "GET" && request.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, 405);
  }

  // --- Authenticate the caller's access token ---
  const authHeader = request.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return jsonResponse(
      { error: "Missing or invalid Authorization header" },
      401,
    );
  }
  const token = authHeader.slice(7);

  const authClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const {
    data: { user },
    error: authError,
  } = await authClient.auth.getUser(token);

  if (authError || !user) {
    return jsonResponse({ error: "Invalid or expired token" }, 401);
  }

  // Service role bypasses RLS, matching the Next.js route's admin client.
  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  try {
    if (request.method === "GET") {
      return await handleGet(admin, request);
    }
    return await handlePost(admin, user.id, request);
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Internal server error";
    return jsonResponse({ error: message }, 500);
  }
});
