import { PixelIcon } from "./PixelIcon";

// Two offset card outlines — the conventional "duplicate" glyph, hand-drawn
// as a 16x16 bitmap (rather than a stroked vector) so it stays crisp beside
// the SortIcon it sits next to, which is a PixelIcon too. Outlines with a 1px
// gap knocked out of the back card, not solid fills: at 16px two filled
// rectangles this close merge into one blob.
const DUPLICATES = [
  "................",
  ".......########.",
  ".......#......#.",
  ".......#......#.",
  ".......#......#.",
  "..............#.",
  "..########....#.",
  "..#......#....#.",
  "..#......#....#.",
  "..#......#....#.",
  "..#......#....#.",
  "..#......#.####.",
  "..#......#......",
  "..#......#......",
  "..########......",
  "................",
];

export function DuplicatesIcon({ className }: { className?: string }) {
  return <PixelIcon grid={DUPLICATES} className={className} />;
}
