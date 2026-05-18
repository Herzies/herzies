import { GENRES, type Genre } from "./types.js";

function simpleHash(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash |= 0;
  }
  return Math.abs(hash);
}

export function todayString(): string {
  return new Date().toISOString().slice(0, 10);
}

export function getDailyCraving(herzieId: string, date?: string): Genre {
  const dateStr = date ?? todayString();
  const seed = simpleHash(herzieId + dateStr);
  const index = seed % GENRES.length;
  return GENRES[index];
}

export function matchesCraving(
  trackGenres: string[],
  cravingGenre: Genre,
): boolean {
  const craving = cravingGenre.toLowerCase();
  return trackGenres.some((g) => {
    const genre = g.toLowerCase();
    return genre.includes(craving) || craving.includes(genre);
  });
}
