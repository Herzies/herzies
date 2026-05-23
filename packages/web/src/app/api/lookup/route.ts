import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase-admin";

/**
 * Look up herzies by friend code(s). Public endpoint (no auth required).
 *
 * GET /api/lookup?code=HERZ-XXXX          — single lookup
 * GET /api/lookup?codes=HERZ-XXXX,HERZ-YYYY — batch lookup
 */
export async function GET(request: Request) {
	const { searchParams } = new URL(request.url);
	const singleCode = searchParams.get("code");
	const batchCodes = searchParams.get("codes");

	if (!singleCode && !batchCodes) {
		return NextResponse.json(
			{ error: "code or codes query param is required" },
			{ status: 400 },
		);
	}

	const admin = createAdminClient();

	if (singleCode) {
		const { data, error } = await admin
			.from("herzies")
			.select("user_id, name, friend_code, stage, level, currency, appearance, equipped")
			.eq("friend_code", singleCode.toUpperCase().trim())
			.single();

		if (error || !data) {
			return NextResponse.json({ herzie: null });
		}

		const topArtists = await getTopArtists(admin, data.user_id);

		return NextResponse.json({
			herzie: {
				name: data.name,
				friendCode: data.friend_code,
				stage: data.stage,
				level: data.level,
				currency: data.currency,
				appearance: data.appearance,
				topArtists,
				equipped: data.equipped,
			},
		});
	}

	const codes = batchCodes!
		.split(",")
		.map((c) => c.trim().toUpperCase())
		.filter(Boolean)
		.slice(0, 50);

	if (codes.length === 0) {
		return NextResponse.json({ herzies: [] });
	}

	const { data, error } = await admin
		.from("herzies")
		.select("user_id, name, friend_code, stage, level, currency, appearance, equipped")
		.in("friend_code", codes);

	if (error || !data) {
		return NextResponse.json({ herzies: [] });
	}

	const herzies = await Promise.all(
		data.map(async (row) => ({
			name: row.name,
			friendCode: row.friend_code,
			stage: row.stage,
			level: row.level,
			currency: row.currency,
			appearance: row.appearance,
			equipped: row.equipped,
			topArtists: await getTopArtists(admin, row.user_id),
		})),
	);

	return NextResponse.json({ herzies });
}

const LISTEN_LOG_PAGE_SIZE = 1000;

async function getTopArtists(
	admin: ReturnType<typeof createAdminClient>,
	userId: string,
): Promise<{ name: string; plays: number }[]> {
	const counts: Record<string, number> = {};
	let from = 0;

	while (true) {
		const { data: page } = await admin
			.from("listen_log")
			.select("artist_name")
			.eq("user_id", userId)
			.range(from, from + LISTEN_LOG_PAGE_SIZE - 1);

		if (!page?.length) break;

		for (const row of page) {
			counts[row.artist_name] = (counts[row.artist_name] ?? 0) + 1;
		}

		if (page.length < LISTEN_LOG_PAGE_SIZE) break;
		from += LISTEN_LOG_PAGE_SIZE;
	}

	return Object.entries(counts)
		.sort((a, b) => b[1] - a[1])
		.slice(0, 3)
		.map(([name, plays]) => ({ name, plays }));
}
