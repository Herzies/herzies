import { randomInt } from "node:crypto";
import type { ColorScheme, HerzieAppearance } from "@herzies/shared";

const COLOR_SCHEMES: ColorScheme[] = [
  "pink",
  "blue",
  "green",
  "purple",
  "orange",
  "yellow",
  "cyan",
  "red",
];

/** Generate a random appearance for a new Herzie */
export function generateAppearance(): HerzieAppearance {
  return {
    headIndex: randomInt(4),
    eyesIndex: randomInt(6),
    mouthIndex: randomInt(5),
    accessoryIndex: randomInt(6),
    limbsIndex: randomInt(4),
    bodyIndex: randomInt(4),
    legsIndex: randomInt(4),
    colorScheme: COLOR_SCHEMES[randomInt(COLOR_SCHEMES.length)],
  };
}
