import { describe, expect, it } from "vitest";
import { BENCH, benchesOf, SIT_RANGE, seatNear } from "./Benches";
import { emptyMap, MAP_SIZE, type TownMap, withFacing } from "./map";

const MID = MAP_SIZE / 2;

function put(map: TownMap, ch: string, col: number, row: number) {
  const line = map.objects[row];
  map.objects[row] = `${line.slice(0, col)}${ch}${line.slice(col + 1)}`;
}
function pave(map: TownMap, col: number, row: number) {
  const line = map.terrain[row];
  map.terrain[row] = `${line.slice(0, col)}g${line.slice(col + 1)}`;
}

describe("benches", () => {
  it("seats two, side by side, facing the path", () => {
    const map = emptyMap();
    put(map, BENCH, MID, MID);
    pave(map, MID, MID + 3);
    const [bench] = benchesOf(map);
    expect(bench.seats).toHaveLength(2);
    // The path is to +z: it faces that way…
    expect(bench.yaw).toBeCloseTo(0, 6);
    const [a, b] = bench.seats;
    // …with its seats either side along x, room for a herzie each.
    expect(Math.abs(a.x - b.x)).toBeGreaterThan(1.1);
    expect(a.z).toBeCloseTo(b.z, 6);
    // Standing up puts you in front, toward the path.
    expect(a.stand.z).toBeGreaterThan(a.z + 1);
    expect(a.heading).toBe(bench.yaw);
  });

  it("picks the nearest free seat in reach", () => {
    const map = emptyMap();
    put(map, BENCH, MID, MID);
    const benches = benchesOf(map);
    const [a, b] = benches[0].seats;
    const free = () => false;
    expect(seatNear(benches, a.stand.x, a.stand.z, free)).toBe(a);
    // Someone's on it: the other one.
    expect(seatNear(benches, a.stand.x, a.stand.z, (s) => s === a)).toBe(b);
    // Both taken: none.
    expect(seatNear(benches, a.stand.x, a.stand.z, () => true)).toBeNull();
    // Too far.
    expect(seatNear(benches, a.x + SIT_RANGE + 2, a.z, free)).toBeNull();
  });
});

describe("turned benches", () => {
  it("face the way they were turned, path or not", () => {
    let map = emptyMap();
    put(map, BENCH, MID, MID);
    pave(map, MID, MID + 3);
    map = withFacing(map, MID, MID, 2);
    const [bench] = benchesOf(map);
    expect(bench.yaw).toBeCloseTo(Math.PI / 2, 9);
    // Seats along z now, standing up toward +x.
    const [a] = bench.seats;
    expect(a.stand.x).toBeGreaterThan(a.x + 1);
  });
});
