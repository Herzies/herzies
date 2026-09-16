import { PixelIcon } from "./PixelIcon";

// Down arrow beside three shortening bars — the conventional "sort" glyph,
// hand-drawn as a 16x16 bitmap (rather than a stroked vector) so it stays
// crisp next to the item pips, which are all PixelIcons too.
const SORT = [
  "................",
  "................",
  "..##............",
  "..##...########.",
  "..##...########.",
  "..##............",
  "..##............",
  "..##...######...",
  "..##...######...",
  "..##............",
  "######..........",
  ".####..####.....",
  "..##...####.....",
  "................",
  "................",
  "................",
];

export function SortIcon({ className }: { className?: string }) {
  return <PixelIcon grid={SORT} className={className} />;
}
