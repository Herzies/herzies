import { randomUUID } from "node:crypto";
import type { Herzie } from "@herzies/shared";
import { generateAppearance } from "./appearance.js";
import { generateFriendCode } from "./friends.js";

/** Create a brand new Herzie */
export function createHerzie(name: string): Herzie {
  return {
    id: randomUUID(),
    name,
    createdAt: new Date().toISOString(),
    appearance: generateAppearance(),
    xp: 0,
    level: 1,
    stage: 1,
    totalMinutesListened: 0,
    genreMinutes: {},
    friendCode: generateFriendCode(),
    friendCodes: [],
    lastCravingDate: "",
    lastCravingGenre: "",
    streakDays: 0,
    streakLastDate: null,
    currency: 0,
  };
}
