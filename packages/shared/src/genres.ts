import { GENRES, type Genre } from "./types.js";

export function classifyGenre(spotifyGenres: string[]): Genre[] {
  const matched = new Set<Genre>();

  for (const raw of spotifyGenres) {
    const lower = raw.toLowerCase();

    for (const genre of GENRES) {
      if (lower.includes(genre) || genre.includes(lower)) {
        matched.add(genre);
      }
    }

    if (
      lower.includes("rap") ||
      lower.includes("trap") ||
      lower.includes("drill")
    ) {
      matched.add("hip-hop");
    }
    if (
      lower.includes("edm") ||
      lower.includes("house") ||
      lower.includes("techno") ||
      lower.includes("dubstep")
    ) {
      matched.add("electronic");
    }
    if (
      lower.includes("alt") ||
      lower.includes("shoegaze") ||
      lower.includes("dream pop")
    ) {
      matched.add("indie");
    }
    if (
      lower.includes("hardcore") ||
      lower.includes("death") ||
      lower.includes("thrash")
    ) {
      matched.add("metal");
    }
    if (
      lower.includes("reggaeton") ||
      lower.includes("salsa") ||
      lower.includes("bachata")
    ) {
      matched.add("latin");
    }
    if (lower.includes("rhythm") || lower.includes("rnb")) {
      matched.add("r&b");
    }
  }

  return matched.size > 0 ? [...matched] : ["pop"];
}

export function recordGenreMinutes(
  genreMinutes: Record<string, number>,
  genres: Genre[],
  minutes: number,
): void {
  const perGenre = minutes / (genres.length || 1);
  for (const genre of genres) {
    genreMinutes[genre] = (genreMinutes[genre] ?? 0) + perGenre;
  }
}
