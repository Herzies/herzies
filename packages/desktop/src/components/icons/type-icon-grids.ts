import type { ItemType } from "@herzies/shared";

// The generic per-type icons: what an item shows until it gets a bespoke one
// in item-icon-grids.json. Plain TS with no runtime imports, so the
// icon-editor's server (plain Node) can load it too and start an unpainted
// item from exactly what the app shows for it.

// Every item is a card (the store's buy tab is literally called "Cards"), so
// each type icon is the same chamfered-corner card outline with a small pip
// marking the category — like a suit mark on a playing card.
const CARD_FRAME = [
  "........................",
  ".....##############.....",
  "....#..............#....",
  "....#..............#....",
  "....#..............#....",
  "....#..............#....",
  "....#..............#....",
  "....#..............#....",
  "....#..............#....",
  "....#..............#....",
  "....#..............#....",
  "....#..............#....",
  "....#..............#....",
  "....#..............#....",
  "....#..............#....",
  "....#..............#....",
  "....#..............#....",
  "....#..............#....",
  "....#..............#....",
  "....#..............#....",
  "....#..............#....",
  "....#..............#....",
  ".....##############.....",
  "........................",
];

function cardIcon(pipRows: string[], startRow: number): string[] {
  const rows = [...CARD_FRAME];
  pipRows.forEach((seg, i) => {
    const r = startRow + i;
    rows[r] = rows[r].slice(0, 7) + seg + rows[r].slice(17);
  });
  return rows;
}

export const TYPE_ICON_GRIDS: Record<ItemType, string[]> = {
  // A plain square die face (5-pip layout) — deliberately NOT cardIcon/
  // CARD_FRAME. Every other type icon (including artefact) is fine sharing
  // that chamfered card-shaped outline since those items genuinely are
  // cards; a die isn't, and wrapping its pips in the card frame was the
  // same "reads as a card" complaint at icon size instead of full size (see
  // renderPowerDiceFrame's block comment). Square outline, not tall.
  dice: [
    "........................",
    "........................",
    "........................",
    "........................",
    "........................",
    ".....##############.....",
    ".....#............#.....",
    ".....#............#.....",
    ".....#..##....##..#.....",
    ".....#..##....##..#.....",
    ".....#............#.....",
    ".....#.....##.....#.....",
    ".....#.....##.....#.....",
    ".....#............#.....",
    ".....#..##....##..#.....",
    ".....#..##....##..#.....",
    ".....#............#.....",
    ".....#............#.....",
    ".....##############.....",
    "........................",
    "........................",
    "........................",
    "........................",
    "........................",
  ],
  // A guitar pick — like dice, not a card, so no card frame.
  charm: [
    "........................",
    "........................",
    "........................",
    "........................",
    "........................",
    "......############......",
    ".....#............#.....",
    ".....#............#.....",
    ".....#............#.....",
    ".....#............#.....",
    "......#..........#......",
    "......#..........#......",
    ".......#........#.......",
    ".......#........#.......",
    "........#......#........",
    "........#......#........",
    ".........#....#.........",
    "..........#..#..........",
    "...........##...........",
    "........................",
    "........................",
    "........................",
    "........................",
    "........................",
  ],
  // Paint drop — appearance/palette, no hue needed to read as "color".
  skin: cardIcon(
    [
      "....##....",
      "...####...",
      "..######..",
      "..######..",
      ".########.",
      ".########.",
      "..######..",
      "...####...",
    ],
    8,
  ),
  // Sun + mountain — background scenery.
  sceneryCard: cardIcon(
    [
      ".......##.",
      "......####",
      "......####",
      ".......##.",
      "....##....",
      "...####...",
      "..######..",
      ".########.",
    ],
    8,
  ),
  // Shield — generic catch-all gear.
  equipable: cardIcon(
    [
      ".########.",
      ".########.",
      ".########.",
      "..######..",
      "..######..",
      "...####...",
      "...####...",
      "....##....",
    ],
    8,
  ),
  // Ribboned box — a placed prop, not something worn.
  accessory: cardIcon(
    [
      ".########.",
      ".###..###.",
      ".###..###.",
      ".########.",
      ".########.",
      ".###..###.",
      ".###..###.",
      ".########.",
    ],
    8,
  ),
  // Up-arrow — a stat-changing effect.
  modifier: cardIcon(
    [
      "....##....",
      "...####...",
      "..######..",
      ".########.",
      "....##....",
      "....##....",
      "....##....",
      "....##....",
    ],
    8,
  ),
  // Faceted gem — rare, uncategorized treasure.
  artefact: cardIcon(
    [
      "..######..",
      ".########.",
      "##########",
      ".########.",
      "..######..",
      "...####...",
      "....##....",
    ],
    8,
  ),
};
