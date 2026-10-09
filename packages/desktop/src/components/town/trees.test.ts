import type * as THREE from "three";
import { describe, expect, it } from "vitest";
import { MAP_SIZE, objectAt, terrainAt } from "./map";
import { HOME_MAP } from "./runtime";
import { SPECIES, TREE_VARIANTS, treeSpecies } from "./trees";

/** Every tree on the home map, and which kind it is. */
function homeTrees() {
  const out: { col: number; row: number; kind: string }[] = [];
  for (let row = 0; row < MAP_SIZE; row++) {
    for (let col = 0; col < MAP_SIZE; col++) {
      if (objectAt(HOME_MAP, col, row) === "T") {
        out.push({ col, row, kind: treeSpecies(HOME_MAP, col, row) });
      }
    }
  }
  return out;
}

function nearWater(col: number, row: number, reach: number) {
  for (let dr = -reach; dr <= reach; dr++) {
    for (let dc = -reach; dc <= reach; dc++) {
      if (terrainAt(HOME_MAP, col + dc, row + dr) === "~") return true;
    }
  }
  return false;
}

describe("trees", () => {
  it("picks the same kind every time", () => {
    for (const { col, row, kind } of homeTrees()) {
      expect(treeSpecies(HOME_MAP, col, row)).toBe(kind);
    }
  });

  it("mixes all three kinds on the home island", () => {
    const trees = homeTrees();
    for (const kind of SPECIES) {
      const share = trees.filter((t) => t.kind === kind).length / trees.length;
      expect(share).toBeGreaterThan(0);
      expect(share).toBeLessThan(0.7);
    }
  });

  it("grows birches by the water", () => {
    const trees = homeTrees();
    const birchShare = (ts: typeof trees) =>
      ts.filter((t) => t.kind === "birch").length / Math.max(1, ts.length);
    const wet = trees.filter((t) => nearWater(t.col, t.row, 3));
    const dry = trees.filter((t) => !nearWater(t.col, t.row, 3));
    expect(birchShare(wet)).toBeGreaterThan(birchShare(dry));
  });

  it("stands every shape on the ground, taller than a herzie", () => {
    for (const variants of Object.values(TREE_VARIANTS)) {
      for (const g of variants) {
        g.computeBoundingBox();
        const box = g.boundingBox as THREE.Box3;
        expect(box.min.y).toBeCloseTo(0, 1);
        expect(box.max.y).toBeGreaterThan(8);
        expect(box.max.y).toBeLessThan(12);
      }
    }
  });
});
