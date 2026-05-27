/**
 * Canonical Last.fm track page URL for an artist + track title.
 * Path segments use `+` for spaces (matches Last.fm’s own URLs).
 */
export function lastFmTrackUrl(artist: string, track: string): string {
	const enc = (s: string) =>
		encodeURIComponent(s.trim()).replace(/%20/g, "+");
	return `https://www.last.fm/music/${enc(artist)}/_/${enc(track)}`;
}

/**
 * Chat payload for /current_song: first line is visible metadata, second line
 * is the Last.fm URL (hidden in the UI; opened when the user clicks the line).
 */
export function formatCurrentSongChatMessage(
	title: string,
	artist: string,
	maxLen: number,
): string {
	const url = lastFmTrackUrl(artist, title);
	const intro = `♪ ${title} — ${artist}`;
	const full = `${intro}\n${url}`;
	if (full.length <= maxLen) return full;
	const suffix = `\n${url}`;
	if (suffix.length >= maxLen) {
		return url.length <= maxLen ? url : url.slice(0, maxLen);
	}
	const introBudget = maxLen - suffix.length - 1; // ellipsis before newline+url
	if (introBudget < 2) return url.slice(0, maxLen);
	return `${intro.slice(0, introBudget)}…${suffix}`;
}
