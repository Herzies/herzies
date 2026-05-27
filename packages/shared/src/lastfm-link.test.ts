import { describe, expect, it } from "vitest";
import { formatCurrentSongChatMessage, lastFmTrackUrl } from "./lastfm-link.js";

describe("lastFmTrackUrl", () => {
	it("encodes artist and track for Last.fm path", () => {
		expect(lastFmTrackUrl("The Beatles", "Hey Jude")).toBe(
			"https://www.last.fm/music/The+Beatles/_/Hey+Jude",
		);
	});
});

describe("formatCurrentSongChatMessage", () => {
	it("truncates intro when over max length but keeps URL on second line", () => {
		const long = "A".repeat(300);
		const msg = formatCurrentSongChatMessage(long, "B".repeat(40), 400);
		expect(msg.length).toBeLessThanOrEqual(400);
		expect(msg).toMatch(/\nhttps:\/\/www\.last\.fm\/music\//);
	});
});
