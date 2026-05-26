import { CHAT_MESSAGE_MAX_LENGTH } from "@herzies/shared";
import { NextResponse } from "next/server";
import { authenticateRequest, isAuthError } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase-admin";

function sanitizeContent(raw: string): string {
	let content = raw.trim();
	content = content.replace(/<[^>]*>/g, "");
	content = content.replace(/https?:\/\/\S+/gi, "");
	content = content.replace(/www\.\S+/gi, "");
	return content.trim();
}

function formatMessage(
	msg: { id: string; user_id: string; content: string; item_refs: string[] | null; created_at: string },
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
		createdAt: msg.created_at,
	};
}

export async function GET(request: Request) {
	const auth = await authenticateRequest(request);
	if (isAuthError(auth)) return auth;

	const url = new URL(request.url);
	const limit = Math.min(Math.max(parseInt(url.searchParams.get("limit") ?? "50", 10) || 50, 1), 100);

	const admin = createAdminClient();
	const { data: messages, error } = await admin
		.from("chat_messages")
		.select("id, user_id, content, item_refs, created_at")
		.order("created_at", { ascending: false })
		.limit(limit);

	if (error) {
		return NextResponse.json({ error: "Failed to fetch messages" }, { status: 500 });
	}

	if (!messages || messages.length === 0) {
		return NextResponse.json({ messages: [] });
	}

	const userIds = [...new Set(messages.map((m) => m.user_id))];
	const { data: herzies } = await admin
		.from("herzies")
		.select("user_id, name, friend_code")
		.in("user_id", userIds);

	const herzieMap = new Map(
		(herzies ?? []).map((h) => [
			h.user_id,
			{ name: h.name, friendCode: h.friend_code as string },
		]),
	);

	const chronological = messages.reverse().map((msg) => {
		const h = herzieMap.get(msg.user_id);
		return formatMessage(msg, h?.name ?? "Unknown", h?.friendCode ?? null);
	});

	return NextResponse.json({ messages: chronological });
}

export async function POST(request: Request) {
	const auth = await authenticateRequest(request);
	if (isAuthError(auth)) return auth;

	const body = await request.json();

	if (typeof body.content !== "string") {
		return NextResponse.json({ error: "content is required" }, { status: 400 });
	}

	const content = sanitizeContent(body.content);
	if (content.length === 0) {
		return NextResponse.json({ error: "content is empty after sanitization" }, { status: 400 });
	}
	if (content.length > CHAT_MESSAGE_MAX_LENGTH) {
		return NextResponse.json(
			{ error: `content exceeds ${CHAT_MESSAGE_MAX_LENGTH} characters` },
			{ status: 400 },
		);
	}

	let itemRefs: string[] = [];
	if (body.itemRefs !== undefined) {
		if (!Array.isArray(body.itemRefs) || body.itemRefs.some((r: unknown) => typeof r !== "string")) {
			return NextResponse.json({ error: "itemRefs must be an array of strings" }, { status: 400 });
		}
		if (body.itemRefs.length > 10) {
			return NextResponse.json({ error: "itemRefs cannot exceed 10 items" }, { status: 400 });
		}
		itemRefs = body.itemRefs;
	}

	const admin = createAdminClient();
	const { data: msg, error } = await admin
		.from("chat_messages")
		.insert({ user_id: auth.userId, content, item_refs: itemRefs })
		.select("id, user_id, content, item_refs, created_at")
		.single();

	if (error || !msg) {
		if (error?.message?.includes("Rate limit")) {
			return NextResponse.json({ error: "Slow down — only 1 message per second" }, { status: 429 });
		}
		if (error?.message?.includes("blocked content")) {
			return NextResponse.json({ error: "Message contains blocked content" }, { status: 400 });
		}
		return NextResponse.json({ error: "Failed to create message" }, { status: 500 });
	}

	const { data: herzie } = await admin
		.from("herzies")
		.select("name, friend_code")
		.eq("user_id", auth.userId)
		.single();

	return NextResponse.json({
		message: formatMessage(
			msg,
			herzie?.name ?? "Unknown",
			herzie?.friend_code ?? null,
		),
	});
}
