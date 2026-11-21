import * as THREE from "three";
import { ambient, gustAt, inSeason, seeThrough } from "../ambient";
import { LANTERN_Y, lampPostGeometry } from "../Lamps";
import {
  bellGeometry,
  cloth,
  fluttering,
  flutterUniforms,
  lanternFrame,
  lanternGlass,
  lanternGlassAt,
  merge,
  paint,
  planked,
  Surface,
  swingClapper,
  wrapTime,
} from "./AirshipModel";
import { type BellPose, poseBell } from "./bell";
import { type Berth, PIER_WIDTH } from "./berth";

/**
 * A Sky Dock: a wooden pier laid flush with the grass from the dock's
 * landward step out to the island's walkable edge, where the moored
 * ship's gangplank comes down. An arch stands over the pier's end; by its
 * foot stand lamp posts and a windsock, and beside the arch a bell on a
 * post that swings when the ship's about to go. Bollards stand out on the
 * rim either side.
 *
 * Built in its own frame — the pier's end at the origin on the ground,
 * the pier running out along +z — and set at the berth by `root`, so it
 * sits in the island's own frame like everything else on it. The pier is
 * walked on (the ground under it, really); what stands beside it is
 * solid (`dockObstacles`), and all of it keeps clear of the walkway.
 *
 * Five draw calls: the pier, what stands up (dithered where it hides the
 * player), the bell, the lanterns, the windsock.
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
const LAMP_SCALE = 0.8;

/** The dock's layout, in its own frame. */
function layoutOf(berth: Berth) {
  const len = Math.hypot(
    berth.pierEnd.x - berth.pierStart.x,
    berth.pierEnd.z - berth.pierStart.z,
  );
  const start = -len;
  return {
    len,
    /** How much higher the ground is at the pier's start than its end. */
    rise: berth.pierStart.y - berth.pierEnd.y,
    lamps: [
      { x: -SIDE, z: start + 0.5, r: 0.22 },
      { x: SIDE, z: start + 0.5, r: 0.22 },
    ],
    arch: [
      { x: -SIDE, z: -0.5, r: 0.25 },
      { x: SIDE, z: -0.5, r: 0.25 },
    ],
    bell: { x: SIDE + 0.75, z: -1.9, r: 0.18 },
    windsock: { x: SIDE + 1.5, z: start + 0.2, r: 0.12 },
    /** Out on the rim, either side of the pier's end. */
    bollards: [
      { x: -5, z: 0.5, r: 0.35 },
      { x: 5, z: 0.5, r: 0.35 },
    ],
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
 * circles (x, z, radius): posts, lamps, the bell, the windsock and the
 * bollards. None of them on the pier. */
export function dockObstacles(
  berth: Berth,
): { x: number; z: number; r: number }[] {
  const l = layoutOf(berth);
  return [...l.lamps, ...l.arch, l.bell, l.windsock, ...l.bollards].map(
    (p: Spot) => ({ ...onIsland(berth, p.x, p.z), r: p.r }),
  );
}

const WOOD = "#a8743f";
const WOOD_LIGHT = "#b98450";
const WOOD_DARK = "#6b4528";
const POST = "#6e4a2a";
const GOLD = "#f2c75c";
const IRON = "#2b2d33";
const ROPE = "#cdb48a";

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
  private readonly sock: THREE.Mesh;
  private readonly flutter = flutterUniforms();
  /** The windsock's spot, island-local (for the gust there). */
  private readonly sockAt: { x: number; z: number };
  private readonly out: number;
  /** The bell's pose as rung, this frame. */
  private readonly rung: BellPose = { swing: 0, clapper: 0 };

  constructor(berth: Berth) {
    const l = layoutOf(berth);
    this.out = berth.out;
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

    // Bollards, each with a coil of rope at its foot.
    for (const b of l.bollards) {
      low.push(
        paint(
          new THREE.CylinderGeometry(0.24, 0.3, 0.5, 8).translate(
            b.x,
            0.25,
            b.z,
          ),
          IRON,
        ),
        paint(
          new THREE.CylinderGeometry(0.32, 0.26, 0.1, 8).translate(
            b.x,
            0.53,
            b.z,
          ),
          IRON,
        ),
        paint(
          new THREE.TorusGeometry(0.28, 0.08, 4, 9)
            .rotateX(Math.PI / 2)
            .translate(b.x + Math.sign(b.x) * 0.75, 0.08, b.z - 0.3),
          ROPE,
        ),
      );
    }

    // Lamp posts at the pier's foot.
    for (const lamp of l.lamps) {
      const y = ground(lamp.z);
      tall.push(
        paint(
          lampPostGeometry()
            .scale(LAMP_SCALE, LAMP_SCALE, LAMP_SCALE)
            .translate(lamp.x, y, lamp.z),
          IRON,
        ),
      );
      lanterns.push(
        new THREE.Matrix4().compose(
          new THREE.Vector3(lamp.x, y + LANTERN_Y * LAMP_SCALE, lamp.z),
          new THREE.Quaternion(),
          new THREE.Vector3().setScalar(LAMP_SCALE),
        ),
      );
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

    // The windsock's pole (the sock flutters, apart).
    const sock = l.windsock;
    const sockY = ground(sock.z) + 4.1;
    tall.push(
      paint(
        new THREE.CylinderGeometry(0.05, 0.08, 4.1, 6).translate(
          sock.x,
          sockY - 2.05,
          sock.z,
        ),
        "#e8e2d4",
      ),
      paint(
        new THREE.TorusGeometry(0.3, 0.035, 4, 10)
          .rotateX(Math.PI / 2)
          .translate(sock.x, sockY, sock.z),
        IRON,
      ),
      paint(
        new THREE.SphereGeometry(0.07, 5, 3).translate(
          sock.x,
          sockY + 0.1,
          sock.z,
        ),
        GOLD,
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

    // The windsock: a striped cone, its mouth on the ring, streaming down
    // its local −z (turned downwind every frame).
    const sockGeometry = new THREE.CylinderGeometry(0.16, 0.3, 1.6, 8, 5, true)
      .rotateX(-Math.PI / 2)
      .translate(0, 0, -0.8)
      .toNonIndexed();
    sockGeometry.deleteAttribute("uv");
    const sp = sockGeometry.attributes.position;
    const colors = new Float32Array(sp.count * 3);
    const red = new THREE.Color("#d8503f");
    const white = new THREE.Color("#f2eee6");
    for (let f = 0; f < sp.count; f += 3) {
      const along = -(sp.getZ(f) + sp.getZ(f + 1) + sp.getZ(f + 2)) / 3;
      const c = Math.floor(along / 0.32) % 2 ? white : red;
      for (let k = 0; k < 3; k++) c.toArray(colors, (f + k) * 3);
    }
    sockGeometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    sockGeometry.setAttribute(
      "surface",
      new THREE.BufferAttribute(new Float32Array(sp.count), 1),
    );
    cloth(sockGeometry, new THREE.Vector3());
    this.sock = new THREE.Mesh(
      this.keep(sockGeometry),
      this.own(
        fluttering(
          new THREE.MeshLambertMaterial({
            vertexColors: true,
            flatShading: true,
            side: THREE.DoubleSide,
          }),
          this.flutter,
        ),
      ),
    );
    this.sock.position.set(sock.x, sockY, sock.z);
    this.sock.frustumCulled = false;
    this.sockAt = onIsland(berth, sock.x, sock.z);

    this.root.add(pier, standing, this.glass, this.bell, this.sock);
    this.root.position.set(berth.pierEnd.x, berth.pierEnd.y, berth.pierEnd.z);
    this.root.rotation.y = berth.out;
    this.update(0, 0, { bell: Number.POSITIVE_INFINITY, strikes: 0 });
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
  update(_dt: number, t: number, s: { bell: number; strikes: number }): void {
    // The bell rings with the ship's: swung by each blow, its clapper on
    // the rim at each chime (bell.ts).
    const rung = poseBell(s.bell, s.strikes, this.rung);
    this.bell.rotation.x = rung.swing;
    swingClapper(this.bell, rung.clapper);

    // The windsock, downwind and filling with the gusts there.
    const w = ambient.uWindDir.value;
    this.sock.rotation.y = Math.atan2(-w.x, -w.y) - this.out;
    const gust = gustAt(this.sockAt.x, this.sockAt.z, t);
    this.flutter.uFlapT.value = wrapTime(t);
    this.flutter.uStream.value = THREE.MathUtils.clamp(0.1 + gust * 0.85, 0, 1);
    this.flutter.uFlutter.value = 0.04 + 0.06 * gust;
  }

  dispose(): void {
    for (const g of this.geometries) g.dispose();
    for (const m of this.materials) m.dispose();
    this.glass.dispose();
    this.root.removeFromParent();
    this.root.clear();
  }
}
