import { PixelIcon } from "@herzies/shared";

// Two arrows, one each way: the classic "swap" glyph, as a 16x16 bitmap like
// the other UI icons (SortIcon), in the text's colour.
const SWAP = [
  "................",
  "..........#.....",
  "..........##....",
  "..###########...",
  "..###########...",
  "..........##....",
  "..........#.....",
  "................",
  "................",
  ".....#..........",
  "....##..........",
  "...###########..",
  "...###########..",
  "....##..........",
  ".....#..........",
  "................",
];

export function SwapIcon({ className }: { className?: string }) {
  return <PixelIcon grid={SWAP} className={className} />;
}
