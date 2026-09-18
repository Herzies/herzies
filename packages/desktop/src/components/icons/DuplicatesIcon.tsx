import { PixelIcon } from "./PixelIcon";

// Two offset card outlines — the conventional "duplicate" glyph, hand-drawn
// as a 16x16 bitmap (rather than a stroked vector) to match the SortIcon it
// sits beside, which is a PixelIcon too.
//
// Strokes are 2px, like SortIcon's, for two reasons: the pair reads as one
// set at the same weight, and these render at 14px, where a 16x16 grid lands
// on fractional device pixels — a 1px stroke would go visibly soft, a 2px one
// survives. The front card also knocks a 2px gap out of the back one, since
// at this size two outlines meeting directly merge into a single shape.
const DUPLICATES = [
  "................",
  ".......########.",
  ".......########.",
  ".............##.",
  ".............##.",
  ".########....##.",
  ".########....##.",
  ".##....##....##.",
  ".##....##....##.",
  ".##....##..####.",
  ".##....##..####.",
  ".##....##.......",
  ".##....##.......",
  ".########.......",
  ".########.......",
  "................",
];

export function DuplicatesIcon({ className }: { className?: string }) {
  return <PixelIcon grid={DUPLICATES} className={className} />;
}
