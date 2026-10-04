import type { ItemType } from "@herzies/shared";

// The generic per-type icons: what an item shows until it gets a bespoke one
// in item-icon-grids.json. Plain TS with no runtime imports, so the
// icon-editor's server (plain Node) can load it too and start an unpainted
// item from exactly what the app shows for it.

// Every item is a card (the store's buy tab is literally called "Cards"), so
// each type icon is the same chamfered-corner card outline with a small pip
// marking the category — like a suit mark on a playing card.
const CARD_FRAME = [
  "................",
  "....########....",
  "...#........#...",
  "...#........#...",
  "...#........#...",
  "...#........#...",
  "...#........#...",
  "...#........#...",
  "...#........#...",
  "...#........#...",
  "...#........#...",
  "...#........#...",
  "...#........#...",
  "...#........#...",
  "....########....",
  "................",
];

function cardIcon(pipRows: string[], startRow: number): string[] {
  const rows = [...CARD_FRAME];
  pipRows.forEach((seg, i) => {
    const r = startRow + i;
    rows[r] = rows[r].slice(0, 4) + seg + rows[r].slice(12);
  });
  return rows;
}

export const TYPE_ICON_GRIDS: Record<ItemType, string[]> = {
  // A plain square die face (5-pip layout) — deliberately NOT cardIcon/
  // CARD_FRAME. Every other type icon (including artefact) is fine sharing
  // that chamfered card-shaped outline since those items genuinely are
  // cards; a die isn't, and wrapping its pips in the card frame was the
  // same "reads as a card" complaint at 16x16 instead of full size (see
  // renderPowerDiceFrame's block comment). Square outline, not tall.
  dice: [
    "................",
    "................",
    "................",
    "................",
    "....########....",
    "....#......#....",
    "....#.#..#.#....",
    "....#......#....",
    "....#...#..#....",
    "....#.#..#.#....",
    "....#......#....",
    "....########....",
    "................",
    "................",
    "................",
    "................",
  ],
  // A guitar pick — like dice, not a card, so no card frame.
  charm: [
    "................",
    "................",
    "................",
    "....########....",
    "...#........#...",
    "...#........#...",
    "...#........#...",
    "....#......#....",
    "....#......#....",
    ".....#....#.....",
    ".....#....#.....",
    "......#..#......",
    ".......##.......",
    "................",
    "................",
    "................",
  ],
  // Paint drop — appearance/palette, no hue needed to read as "color".
  skin: cardIcon(
    ["...##...", "..####..", "..####..", "..####..", "...##..."],
    6,
  ),
  // Sun + mountain — background scenery.
  sceneryCard: cardIcon(
    [".....##.", ".....##.", "...##...", "..####..", ".######."],
    6,
  ),
  // Shield — generic catch-all gear.
  equipable: cardIcon(
    ["..####..", "..####..", "...##...", "...##...", "...##..."],
    5,
  ),
  // Ribboned box — a placed prop, not something worn.
  accessory: cardIcon(
    [".######.", ".##..##.", ".##..##.", ".##..##.", ".######."],
    6,
  ),
  // Up-arrow — a stat-changing effect.
  modifier: cardIcon(
    ["...##...", "..####..", "...##...", "...##...", "...##..."],
    6,
  ),
  // Faceted gem — rare, uncategorized treasure.
  artefact: cardIcon(["..####..", ".######.", "..####..", "...##..."], 6),
};
