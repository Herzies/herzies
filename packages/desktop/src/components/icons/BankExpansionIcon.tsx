import { PixelIcon } from "./PixelIcon";

// The inventory grid with one more row growing out of it: two solid rows of
// slots, a third of hollow (still-empty) slots, and a slot-sized plus where the
// last one would be. Hand-drawn as a 16x16 bitmap like SortIcon, so it sits with the
// item pips and reads the same at 16px and blown up on the store's card.
const BANK_EXPANSION = [
  "................",
  "................",
  "..###.###.###...",
  "..###.###.###...",
  "..###.###.###...",
  "................",
  "..###.###.###...",
  "..###.###.###...",
  "..###.###.###...",
  "................",
  "..###.###..#....",
  "..#.#.#.#.###...",
  "..###.###..#....",
  "................",
  "................",
  "................",
];

export function BankExpansionIcon({ className }: { className?: string }) {
  return <PixelIcon grid={BANK_EXPANSION} className={className} />;
}
