import * as THREE from "three";
import { inSeason, seeThrough } from "../ambient";
import {
  bellGeometry,
  lanternFrame,
  lanternGlass,
  lanternGlassAt,
  merge,
  paint,
  planked,
  Surface,
  swingClapper,
} from "./AirshipModel";
import { type BellPose, poseBell } from "./bell";
import { type Berth, PIER_WIDTH } from "./berth";

/**
 * A Sky Dock: a wooden pier laid flush with the grass from the dock's
 * landward step out to the island's walkable edge, where the moored
 * ship's gangplank comes down. An arch stands over the pier's end, and
 * beside it a bell on a post that swings when the ship's about to go.
 *
 * Built in its own frame — the pier's end at the origin on the ground,
 * the pier running out along +z — and set at the berth by `root`, so it
 * sits in the island's own frame like everything else on it. The pier is
 * walked on (the ground under it, really); what stands beside it is
 * solid (`dockObstacles`), and all of it keeps clear of the walkway.
 *
 * Four draw calls: the pier, what stands up (dithered where it hides the
 * player), the bell, the lanterns.
 */

/** What stands beside the pier, in the dock's own frame (x across, z out
 * along the pier, its end at 0): where, and how wide. */
type Spot = { x: number; z: number; r: number };

/** How far either side of the pier's middle its posts stand (the pier's
 * edge, plus a little). */
const SIDE = PIER_WIDTH / 2 + 0.3;
/** How far past the pier's end its boards run (past where anyone walks,
 * over the rim). */
const PIER_PAST_END = 0.8;
/** The pier's boards' top, over the ground: just proud of the grass. */
const PIER_TOP = 0.03;

/** The dock's layout, in its own frame. */
function layoutOf(berth: Berth) {
  const len = Math.hypot(
    berth.pierEnd.x - berth.pierStart.x,
    berth.pierEnd.z - berth.pierStart.z,
  );
  return {
    len,
    /** How much higher the ground is at the pier's start than its end. */
    rise: berth.pierStart.y - berth.pierEnd.y,
    arch: [
      { x: -SIDE, z: -0.5, r: 0.25 },
      { x: SIDE, z: -0.5, r: 0.25 },
    ],
    bell: { x: SIDE + 0.75, z: -1.9, r: 0.18 },
  };
}

/** A spot in the dock's frame, in the island's. */
function onIsland(
  berth: Berth,
  x: number,
  z: number,
): { x: number; z: number } {
  const c = Math.cos(berth.out);
  const s = Math.sin(berth.out);
  return {
    x: berth.pierEnd.x + x * c + z * s,
    z: berth.pierEnd.z - x * s + z * c,
  };
}

/** What stands round the dock that you can't walk through, island-local
 * circles (x, z, radius): the arch's posts and the bell's. None of them on
 * the pier. */
export function dockObstacles(
  berth: Berth,
): { x: number; z: number; r: number }[] {
  const l = layoutOf(berth);
  return [...l.arch, l.bell].map((p: Spot) => ({
    ...onIsland(berth, p.x, p.z),
    r: p.r,
  }));
}

const WOOD = "#a8743f";
const WOOD_LIGHT = "#b98450";
const WOOD_DARK = "#6b4528";
const POST = "#6e4a2a";
const IRON = "#2b2d33";

/** Where the dock's bell hangs from, in its frame. */
const BELL_HANG = 2.45;

/** A Sky Dock's model, at `berth`. */
export class DockModel {
  /** In the island's frame. */
  readonly root = new THREE.Group();

  private readonly geometries: THREE.BufferGeometry[] = [];
  private readonly materials: THREE.Material[] = [];
  private readonly glass: THREE.InstancedMesh;
  private readonly bell: THREE.Mesh;
  /** The bell's pose as rung, this frame. */
  private readonly rung: BellPose = { swing: 0, clapper: 0 };

  constructor(berth: Berth) {
    const l = layoutOf(berth);
    /** The ground's height along the pier (its end at 0). */
    const ground = (z: number) =>
      l.rise * THREE.MathUtils.clamp(-z / l.len, 0, 1);
    const low: THREE.BufferGeometry[] = [];
    const tall: THREE.BufferGeometry[] = [];
    const lanterns: THREE.Matrix4[] = [];

    // The pier: boards across it, edge beams, sloping with the ground.
    const length = l.len + PIER_PAST_END;
    const deck = [
      paint(
        new THREE.BoxGeometry(PIER_WIDTH, 0.12, length, 1, 1, 6).translate(
          0,
          PIER_TOP - 0.06,
          (PIER_PAST_END - l.len) / 2,
        ),
        WOOD_LIGHT,
        Surface.Across,
      ),
      ...[-1, 1].map((s) =>
        paint(
          new THREE.BoxGeometry(0.16, 0.24, length, 1, 1, 6).translate(
            (s * (PIER_WIDTH + 0.16)) / 2,
            PIER_TOP - 0.1,
            (PIER_PAST_END - l.len) / 2,
          ),
          WOOD_DARK,
        ),
      ),
      paint(
        new THREE.BoxGeometry(PIER_WIDTH + 0.32, 0.24, 0.16).translate(
          0,
          PIER_TOP - 0.1,
          PIER_PAST_END + 0.08,
        ),
        WOOD_DARK,
      ),
    ];
    for (const g of deck) {
      const p = g.attributes.position;
      for (let i = 0; i < p.count; i++)
        p.setY(i, p.getY(i) + ground(p.getZ(i)));
      low.push(g);
    }

    // The arch over the pier's end, a lantern hung off each post (outward,
    // clear of the walkway).
    const ARCH_H = 3.3;
    for (const a of l.arch) {
      const s = Math.sign(a.x);
      tall.push(
        paint(
          new THREE.BoxGeometry(0.26, ARCH_H, 0.26).translate(
            a.x,
            ARCH_H / 2,
            a.z,
          ),
          POST,
        ),
        paint(
          new THREE.BoxGeometry(0.36, 0.12, 0.36).translate(a.x, 0.06, a.z),
          WOOD_DARK,
        ),
        paint(
          new THREE.BoxGeometry(0.5, 0.06, 0.06).translate(
            a.x + s * 0.3,
            2.62,
            a.z,
          ),
          IRON,
        ),
        // A brace from the post up to the beam.
        paint(
          new THREE.BoxGeometry(0.1, 0.9, 0.1)
            .rotateZ(s * 0.75)
            .translate(a.x - s * 0.3, ARCH_H - 0.3, a.z),
          WOOD_DARK,
        ),
        ...lanternFrame(a.x + s * 0.5, 2.2, a.z),
      );
      lanterns.push(lanternGlassAt(a.x + s * 0.5, 2.2, a.z));
    }
    tall.push(
      paint(
        new THREE.BoxGeometry(SIDE * 2 + 0.7, 0.24, 0.32).translate(
          0,
          ARCH_H + 0.12,
          l.arch[0].z,
        ),
        WOOD,
      ),
    );

    // The bell post: a post, an arm reaching over toward the pier, a
    // little roof over the bell.
    const bell = l.bell;
    tall.push(
      paint(
        new THREE.BoxGeometry(0.2, 2.75, 0.2).translate(bell.x, 1.375, bell.z),
        POST,
      ),
      paint(
        new THREE.BoxGeometry(0.85, 0.12, 0.14).translate(
          bell.x - 0.35,
          BELL_HANG + 0.12,
          bell.z,
        ),
        WOOD,
      ),
      paint(
        new THREE.BoxGeometry(0.08, 0.5, 0.08)
          .rotateZ(-0.8)
          .translate(bell.x - 0.15, BELL_HANG - 0.1, bell.z),
        WOOD_DARK,
      ),
      paint(
        new THREE.ConeGeometry(0.42, 0.28, 4)
          .rotateY(Math.PI / 4)
          .translate(bell.x - 0.45, BELL_HANG + 0.34, bell.z),
        "#7a3b2e",
      ),
    );

    // The pier never hides the player (it's the ground); what stands up
    // might.
    const wood = () =>
      inSeason(
        planked(
          new THREE.MeshLambertMaterial({
            vertexColors: true,
            flatShading: true,
          }),
        ),
      );
    const lowMat = this.own(wood());
    const tallMat = this.own(seeThrough(wood()));
    const pier = new THREE.Mesh(this.keep(merge(low)), lowMat);
    pier.receiveShadow = true;
    pier.castShadow = true;
    const standing = new THREE.Mesh(this.keep(merge(tall)), tallMat);
    standing.castShadow = true;
    standing.receiveShadow = true;

    this.glass = lanternGlass(lanterns);

    this.bell = new THREE.Mesh(this.keep(bellGeometry(0.22)), tallMat);
    this.bell.position.set(bell.x - 0.6, BELL_HANG + 0.06, bell.z);
    this.bell.castShadow = true;

    this.root.add(pier, standing, this.glass, this.bell);
    this.root.position.set(berth.pierEnd.x, berth.pierEnd.y, berth.pierEnd.z);
    this.root.rotation.y = berth.out;
    this.update({ bell: Number.POSITIVE_INFINITY, strikes: 0 });
  }

  private keep<G extends THREE.BufferGeometry>(g: G): G {
    this.geometries.push(g);
    return g;
  }

  private own<M extends THREE.Material>(m: M): M {
    this.materials.push(m);
    return m;
  }

  /** `bell`: seconds since the ship's bell began ringing (Infinity: not
   * lately), `strikes` times. */
  update(s: { bell: number; strikes: number }): void {
    // The bell rings with the ship's: swung by each blow, its clapper on
    // the rim at each chime (bell.ts).
    const rung = poseBell(s.bell, s.strikes, this.rung);
    this.bell.rotation.x = rung.swing;
    swingClapper(this.bell, rung.clapper);
  }

  dispose(): void {
    for (const g of this.geometries) g.dispose();
    for (const m of this.materials) m.dispose();
    this.glass.dispose();
    this.root.removeFromParent();
    this.root.clear();
  }
}
