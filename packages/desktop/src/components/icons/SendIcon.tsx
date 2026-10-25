import { PixelIcon } from "@herzies/shared";

// An up arrow, for the chat's send button: a 9x9 bitmap with 1px lines (odd,
// so the stem has a middle), drawn at 9px so each pixel lands on a whole one.
const SEND = [
  ".........",
  "....#....",
  "...###...",
  "..#.#.#..",
  ".#..#..#.",
  "....#....",
  "....#....",
  "....#....",
  ".........",
];

export function SendIcon({ className }: { className?: string }) {
  return <PixelIcon grid={SEND} className={className} />;
}
