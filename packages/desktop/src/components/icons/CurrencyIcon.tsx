import { PixelIcon } from "./PixelIcon";

// Two overlapping coins — computed from circle math rather than hand-drawn,
// since a hand-authored bitmap circle at this size reads lumpy. The back
// coin is clipped a pixel past the front coin's edge, so a thin gap
// separates them instead of fusing into one blob.
function inDisk(x: number, y: number, cx: number, cy: number, r: number) {
  const dx = x + 0.5 - cx;
  const dy = y + 0.5 - cy;
  return Math.sqrt(dx * dx + dy * dy) <= r;
}

const BACK = { cx: 4.2, cy: 4.6, r: 3.8 };
const FRONT = { cx: 9.5, cy: 9.3, r: 4.3 };
const SEAM_GAP = 0.6;

function buildCoinPackGrid(): string[] {
  const rows: string[] = [];
  for (let y = 0; y < 16; y++) {
    let row = "";
    for (let x = 0; x < 16; x++) {
      const front = inDisk(x, y, FRONT.cx, FRONT.cy, FRONT.r);
      const seamGap = inDisk(x, y, FRONT.cx, FRONT.cy, FRONT.r + SEAM_GAP);
      const back = !seamGap && inDisk(x, y, BACK.cx, BACK.cy, BACK.r);
      row += front || back ? "#" : ".";
    }
    rows.push(row);
  }
  return rows;
}

const COIN_PACK = buildCoinPackGrid();

export function CoinPackIcon({ className }: { className?: string }) {
  return <PixelIcon grid={COIN_PACK} className={className} />;
}
