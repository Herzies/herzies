import { useEffect, useMemo } from "react";
import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { ambient } from "./ambient";
import { SKY_GRADIENT_GLSL, skyUniforms } from "./Islands";
import { islandRadius, type TownMap } from "./map";
import { portalsOf } from "./portal";
import {
  ASHLAR,
  ashlar,
  box,
  chain,
  DOOR,
  DOOR_DARK,
  disc,
  FOOTING,
  GOLD,
  INDIGO,
  IRON,
  paint,
  RECESS,
  RIB,
  STEP,
  STONE,
  TRIM,
  tris,
} from "./Tower";

/**
 * The Tower's hall, inside (a map with `room: "tower"`): the drum you
 * see from the town, from within. Twelve walls of the same pale ashlar,
 * a pilaster with a torch at every corner, a tall arched window in every
 * wall showing the sky as it is outside, indigo-and-gold banners either
 * side, a ribbed vault closing in overhead, and a floor of flagstones laid
 * in rings round a gold-ringed compass. The way out is a round-headed
 * doorway with its purple doors swung open on the daylight; the way on
 * (the `next` portal) an arch with a stair climbing away into the dark.
 * Doorway and stair stand wherever the map's portals are.
 *
 * Its light is DayLight's ("tower"): warm at any hour. The torches light
 * the stone round them in its shader (no lights of their own), and by day
 * faint shafts fall from the windows.
 *
 * The camera often stands outside the walls (it's 12 behind you, and you
 * can walk to the wall's foot): everything on the walls is cut away where
 * the camera's beyond them (`cutaway`), so the near side of the hall opens
 * like a doll's house, cleanly, rather than showing backs of banners.
 *
 * All built once per map, merged: five draws — the stone, the floor, the
 * windows, the flames, and the glow (torch halos and sun shafts). Nothing
 * moves on the CPU; the flames flicker on the shared clock.
 */

/** The walls: as many as the Tower's drum has sides, each centred on a
 * multiple of 30° (0 facing +z), corners between them. */
const SIDES = 12;
const STEP_A = (2 * Math.PI) / SIDES;
const CORNER0 = -Math.PI / SIDES;
/** How tall the walls stand before the vault springs, and its crown. */
const WALL_H = 15;
const VAULT_TOP = 24;
/** The windows: sill, where the round head starts, and width. */
const SILL = 5.2;
const HEAD = 10.4;
const WINDOW_W = 2;
/** The doorway's and the stair's opening: half its width, and where its
 * round head springs (the portal's disc, 1.08 across from 1.55 up, fits
 * inside). The frame round it: half its width, and its height. */
const OPEN_HALF = 1.4;
const OPEN_SPRING = 2.2;
const FRAME_HALF = 2.3;
const FRAME_H = 4.9;
/** The torches: up the pilasters' faces, how far out on their brackets,
 * and so where the flame's base is, out from the wall's corner (the
 * pilaster stands 1.2 out of it). */
const TORCH_Y = 3.6;
const TORCH_OUT = 0.55;
const FLAME_OUT = 1.2 + TORCH_OUT;
/** The floor's stone, a touch darker and warmer than the walls'. */
const FLOOR = "#b8ab97";
/** The far end of the stair, lost in the dark. */
const DEEP = "#2a221d";

/** Where everything is, from the map's size. */
type Plan = {
  /** The walls' corners from the middle, and each wall's distance. */
  corner: number;
  apothem: number;
  /** Past this (the camera, along a fragment's direction), cut away. */
  cut: number;
  /** The torches' light: from the middle, and up (the flames' middle). */
  torchR: number;
  torchY: number;
};

function planFor(map: TownMap): Plan {
  const corner = islandRadius(map) - 0.6;
  const apothem = corner * Math.cos(Math.PI / SIDES);
  return {
    corner,
    apothem,
    cut: apothem - 0.3,
    torchR: corner - FLAME_OUT,
    torchY: TORCH_Y + 0.35,
  };
}

/** Something made facing +z, set up `d` from the middle at angle `a`
 * facing in: its +z toward the middle, its origin on the wall's plane. */
function place(g: THREE.BufferGeometry, a: number, d: number) {
  return g.rotateY(a + Math.PI).translate(Math.sin(a) * d, 0, Math.cos(a) * d);
}

/** A cylinder turned inside out: seen from within. */
function inward(g: THREE.BufferGeometry): THREE.BufferGeometry {
  const out = g.index ? g.toNonIndexed() : g;
  out.deleteAttribute("uv");
  out.deleteAttribute("normal");
  const p = out.attributes.position;
  for (let i = 0; i < p.count; i += 3) {
    const x = p.getX(i + 1);
    const y = p.getY(i + 1);
    const z = p.getZ(i + 1);
    p.setXYZ(i + 1, p.getX(i + 2), p.getY(i + 2), p.getZ(i + 2));
    p.setXYZ(i + 2, x, y, z);
  }
  out.computeVertexNormals();
  return out;
}

/** A painted geometry fading to `to` as `t` (0–1, from where a vertex
 * is) goes: the vault into its dark, the stair into the deep. */
function fade(
  g: THREE.BufferGeometry,
  to: string,
  t: (x: number, y: number, z: number) => number,
): THREE.BufferGeometry {
  const c = g.attributes.color;
  const p = g.attributes.position;
  const k = new THREE.Color(to);
  for (let i = 0; i < p.count; i++) {
    const f = Math.min(1, Math.max(0, t(p.getX(i), p.getY(i), p.getZ(i))));
    c.setXYZ(
      i,
      c.getX(i) + (k.r - c.getX(i)) * f,
      c.getY(i) + (k.g - c.getY(i)) * f,
      c.getZ(i) + (k.b - c.getZ(i)) * f,
    );
  }
  return g;
}

/** An outline with a round-headed opening `x0` across, from the floor:
 * up its left jamb, over its head, down its right. */
function opening(s: THREE.Shape, x0: number) {
  s.lineTo(x0 - OPEN_HALF, 0);
  s.lineTo(x0 - OPEN_HALF, OPEN_SPRING);
  s.absarc(x0, OPEN_SPRING, OPEN_HALF, Math.PI, 0, true);
  s.lineTo(x0 + OPEN_HALF, 0);
}

/** One wall, `width` across, with a doorway-sized gap at `x0` if any. */
function wallPanel(width: number, x0: number | null): THREE.BufferGeometry {
  const s = new THREE.Shape();
  s.moveTo(-width / 2, 0);
  if (x0 !== null) opening(s, x0);
  s.lineTo(width / 2, 0);
  s.lineTo(width / 2, WALL_H);
  s.lineTo(-width / 2, WALL_H);
  s.closePath();
  return new THREE.ShapeGeometry(s, 8);
}

/** The thick stone round an opening, standing `depth` out from the wall
 * into the hall, and the pale band round its head. */
function frame(body: THREE.BufferGeometry[], x0: number, depth: number) {
  const s = new THREE.Shape();
  s.moveTo(x0 - FRAME_HALF, 0);
  opening(s, x0);
  s.lineTo(x0 + FRAME_HALF, 0);
  s.lineTo(x0 + FRAME_HALF, FRAME_H);
  s.lineTo(x0 - FRAME_HALF, FRAME_H);
  s.closePath();
  body.push(
    paint(
      new THREE.ExtrudeGeometry(s, {
        depth,
        bevelEnabled: false,
        curveSegments: 10,
      }),
      STONE,
      ASHLAR,
    ),
  );
  const band = new THREE.Shape();
  const r = OPEN_HALF + 0.4;
  band.moveTo(x0 - r, 0);
  opening(band, x0);
  band.lineTo(x0 + r, 0);
  band.lineTo(x0 + r, OPEN_SPRING);
  band.absarc(x0, OPEN_SPRING, r, 0, Math.PI, false);
  band.closePath();
  body.push(
    paint(
      new THREE.ExtrudeGeometry(band, {
        depth: 0.12,
        bevelEnabled: false,
        curveSegments: 10,
      }).translate(0, 0, depth),
      TRIM,
    ),
    paint(box(0.5, 0.62, 0.2, x0, OPEN_SPRING + r - 0.1, depth + 0.08), GOLD),
  );
}

/** The way out: a short passage behind the opening, its purple doors
 * swung back against its sides, the day beyond (the window glass). */
function doorway(
  body: THREE.BufferGeometry[],
  glass: THREE.BufferGeometry[],
  x0: number,
  depth: number,
) {
  const back = 1.6;
  const h = OPEN_SPRING + OPEN_HALF;
  for (const s of [-1, 1]) {
    body.push(
      paint(
        box(0.3, h, back, x0 + s * (OPEN_HALF + 0.15), h / 2, -back / 2),
        STONE,
      ),
      // A door leaf, open: flat to the passage's side.
      paint(
        box(
          0.12,
          h - 0.7,
          1.3,
          x0 + s * (OPEN_HALF - 0.08),
          (h - 0.7) / 2,
          -0.75,
        ),
        DOOR,
      ),
      paint(
        box(0.06, 0.12, 1.1, x0 + s * (OPEN_HALF - 0.16), 0.9, -0.75),
        DOOR_DARK,
      ),
      paint(
        box(0.06, 0.12, 1.1, x0 + s * (OPEN_HALF - 0.16), h - 1.6, -0.75),
        DOOR_DARK,
      ),
    );
  }
  body.push(
    paint(box(OPEN_HALF * 2 + 0.6, 0.3, back, x0, h + 0.15, -back / 2), STONE),
    paint(
      box(OPEN_HALF * 2, 0.06, back + depth, x0, 0.03, (depth - back) / 2),
      STEP,
    ),
  );
  glass.push(box(OPEN_HALF * 2 + 0.2, h + 0.2, 0.05, x0, h / 2, -back));
}

/** The way on: an arch with a stair behind it, climbing out of the hall
 * and away into the dark. */
function stair(body: THREE.BufferGeometry[], x0: number, depth: number) {
  const steps = 12;
  const rise = 0.3;
  const run = 0.5;
  const back = steps * run - depth + 0.4;
  const deep = (z: number) => (-z - 0.5) / back;
  for (let i = 0; i < steps; i++) {
    const z = depth - i * run - run / 2;
    body.push(
      fade(
        paint(
          box(OPEN_HALF * 2, rise * (i + 1), run, x0, (rise * (i + 1)) / 2, z),
          STEP,
        ),
        DEEP,
        (_x, _y, vz) => deep(vz) * 0.9,
      ),
    );
  }
  const h = 8;
  for (const s of [-1, 1]) {
    body.push(
      fade(
        paint(
          box(0.3, h, back, x0 + s * (OPEN_HALF + 0.15), h / 2, -back / 2),
          STONE,
        ),
        DEEP,
        (_x, _y, z) => deep(z),
      ),
    );
  }
  // The ceiling climbs with the stair, from just over the arch's head.
  const slope = Math.atan2(rise, run);
  const length = back / Math.cos(slope);
  const top = OPEN_SPRING + OPEN_HALF + 0.3;
  body.push(
    fade(
      paint(
        box(OPEN_HALF * 2 + 0.6, 0.3, length)
          .rotateX(slope)
          .translate(x0, top + (back / 2) * Math.tan(slope), -back / 2),
        STONE,
      ),
      DEEP,
      (_x, _y, z) => deep(z),
    ),
    paint(box(OPEN_HALF * 2 + 0.6, h, 0.3, x0, h / 2, -back - 0.15), DEEP),
  );
}

/** An indigo banner hung from a gilt rod, gold-edged, with a gold lozenge
 * and a swallowtail (as on the Tower's cornices). */
function banner(body: THREE.BufferGeometry[], x: number, top: number) {
  const len = 4.6;
  const w = 1.4;
  body.push(
    paint(box(w + 0.3, 0.1, 0.1, x, top, 0.16), GOLD),
    paint(box(w, len, 0.05, x, top - len / 2, 0.1), INDIGO),
    paint(
      box(w * 0.34, w * 0.34, 0.05)
        .rotateZ(Math.PI / 4)
        .translate(x, top - len * 0.32, 0.13),
      GOLD,
    ),
  );
  for (const s of [-1, 1]) {
    body.push(
      paint(
        box(0.08, len, 0.06, x + s * (w / 2 - 0.06), top - len / 2, 0.11),
        GOLD,
      ),
    );
  }
  const d = w * 0.45;
  body.push(
    paint(
      tris(
        [-w / 2, 0, 0],
        [-w / 2, -d, 0],
        [0, 0, 0],
        [0, 0, 0],
        [w / 2, -d, 0],
        [w / 2, 0, 0],
      ).translate(x, top - len, 0.1),
      INDIGO,
    ),
  );
}

/** A tall arched window: a dark reveal, the glass (sky), its leading, a
 * sill and a keystone. */
function archWindow(
  body: THREE.BufferGeometry[],
  glass: THREE.BufferGeometry[],
) {
  const w = WINDOW_W;
  const mid = (SILL + HEAD) / 2;
  body.push(
    paint(box(w + 0.5, HEAD - SILL + 0.1, 0.08, 0, mid, 0.04), RECESS),
    paint(disc(w / 2 + 0.25, 0.08).translate(0, HEAD, 0.04), RECESS),
    paint(
      box(
        0.08,
        HEAD - SILL + w / 2,
        0.06,
        0,
        SILL + (HEAD - SILL + w / 2) / 2,
        0.15,
      ),
      IRON,
    ),
    paint(box(w + 0.7, 0.16, 0.4, 0, SILL - 0.08, 0.2), TRIM),
    paint(box(0.34, 0.5, 0.14, 0, HEAD + w / 2 + 0.3, 0.07), TRIM),
  );
  for (const y of [SILL + 1.75, SILL + 3.5]) {
    body.push(paint(box(w, 0.08, 0.06, 0, y, 0.15), IRON));
  }
  glass.push(
    box(w, HEAD - SILL, 0.04, 0, mid, 0.1),
    disc(w / 2, 0.04).translate(0, HEAD, 0.1),
  );
}

/** A pilaster in the corner, its torch on a bracket, and the torch's
 * halo; the flame itself is the flames' (its base FLAME_OUT from the
 * corner, TORCH_Y up). */
function pilaster(body: THREE.BufferGeometry[], glow: Glow) {
  body.push(
    paint(box(1.7, 0.8, 1.45, 0, 0.4, 0.72), FOOTING),
    paint(box(1.4, WALL_H - 1.6, 1.2, 0, 0.8 + (WALL_H - 1.6) / 2, 0.6), RIB),
    paint(box(1.75, 0.45, 1.5, 0, WALL_H - 0.6, 0.75), TRIM),
    paint(
      box(
        0.12,
        0.12,
        TORCH_OUT + 0.1,
        0,
        TORCH_Y - 0.2,
        FLAME_OUT - TORCH_OUT / 2,
      ),
      IRON,
    ),
    paint(
      new THREE.CylinderGeometry(0.18, 0.1, 0.3, 8).translate(
        0,
        TORCH_Y - 0.05,
        FLAME_OUT,
      ),
      IRON,
    ),
  );
  glow.halo(0, TORCH_Y + 0.35, 1.22, 1.1);
}

/** The torch halos and the window shafts, as one additive geometry: each
 * vertex its strength (`aAlpha`), whether it's a shaft of day (`aKind` 1)
 * or a torch's glow (0), and its torch's flicker (`aSeed`). */
class Glow {
  pos: number[] = [];
  alpha: number[] = [];
  kind: number[] = [];
  seed: number[] = [];
  private start = 0;
  /** The torch (or window) what's added now flickers with. */
  seedNow = 0;
  private v(x: number, y: number, z: number, a: number, kind: number) {
    this.pos.push(x, y, z);
    this.alpha.push(a);
    this.kind.push(kind);
    this.seed.push(this.seedNow);
  }
  /** A disc of glow, brightest in its middle, facing +z. */
  halo(x: number, y: number, z: number, r: number) {
    const n = 14;
    for (let i = 0; i < n; i++) {
      const a0 = (i / n) * Math.PI * 2;
      const a1 = ((i + 1) / n) * Math.PI * 2;
      this.v(x, y, z, 1, 0);
      this.v(x + Math.cos(a0) * r, y + Math.sin(a0) * r, z, 0, 0);
      this.v(x + Math.cos(a1) * r, y + Math.sin(a1) * r, z, 0, 0);
    }
  }
  /** A shaft from a window's rectangle, down and into the hall. */
  shaft() {
    const w = WINDOW_W / 2 - 0.1;
    const dir = new THREE.Vector3(0, -0.6, 0.8).multiplyScalar(9);
    const near = [
      [-w, SILL],
      [w, SILL],
      [w, HEAD],
      [-w, HEAD],
    ].map(([x, y]) => new THREE.Vector3(x, y, 0.16));
    const far = near.map((p) => p.clone().add(dir));
    for (let i = 0; i < 4; i++) {
      const j = (i + 1) % 4;
      for (const [p, a] of [
        [near[i], 1],
        [near[j], 1],
        [far[j], 0],
        [near[i], 1],
        [far[j], 0],
        [far[i], 0],
      ] as const) {
        this.v(p.x, p.y, p.z, a, 1);
      }
    }
  }
  /** Everything added since the last call, set where `place` puts it. */
  take(set: (g: THREE.BufferGeometry) => THREE.BufferGeometry) {
    const g = new THREE.BufferGeometry();
    g.setAttribute(
      "position",
      new THREE.Float32BufferAttribute(this.pos.slice(this.start * 3), 3),
    );
    set(g);
    const p = g.attributes.position;
    for (let i = 0; i < p.count; i++) {
      this.pos[(this.start + i) * 3] = p.getX(i);
      this.pos[(this.start + i) * 3 + 1] = p.getY(i);
      this.pos[(this.start + i) * 3 + 2] = p.getZ(i);
    }
    this.start = this.alpha.length;
  }
  geometry(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute("aAlpha", new THREE.Float32BufferAttribute(this.alpha, 1));
    g.setAttribute("aKind", new THREE.Float32BufferAttribute(this.kind, 1));
    g.setAttribute("aSeed", new THREE.Float32BufferAttribute(this.seed, 1));
    return g;
  }
}

type Hall = {
  body: THREE.BufferGeometry;
  floor: THREE.BufferGeometry;
  glass: THREE.BufferGeometry;
  flames: THREE.BufferGeometry;
  glow: THREE.BufferGeometry;
};

function buildHall(map: TownMap, plan: Plan): Hall {
  const { corner, apothem } = plan;
  const width = 2 * apothem * Math.tan(Math.PI / SIDES);
  // Which wall each portal's in, and where along it: the way out gets a
  // doorway, the way on a stair.
  const ways = new Map<number, { x0: number; depth: number; next: boolean }>();
  for (const p of portalsOf(map)) {
    const a = Math.atan2(p.x, p.z);
    const k = ((Math.round(a / STEP_A) % SIDES) + SIDES) % SIDES;
    const af = k * STEP_A;
    // Along the wall (its +x, as `place` turns it) and in from it.
    const x0 = -p.x * Math.cos(af) + p.z * Math.sin(af);
    const into = apothem - (p.x * Math.sin(af) + p.z * Math.cos(af));
    ways.set(k, {
      x0,
      depth: Math.max(0.6, into - 0.45),
      next: !!p.next,
    });
  }

  const body: THREE.BufferGeometry[] = [];
  const glass: THREE.BufferGeometry[] = [];
  const glow = new Glow();
  const onWall = (
    parts: THREE.BufferGeometry[],
    from: number,
    a: number,
    d: number,
  ) => {
    for (let i = from; i < parts.length; i++) place(parts[i], a, d);
  };

  for (let k = 0; k < SIDES; k++) {
    const a = k * STEP_A;
    const way = ways.get(k);
    const b0 = body.length;
    const g0 = glass.length;
    body.push(paint(wallPanel(width, way?.x0 ?? null), STONE, ASHLAR));
    // A dark footing and a pale string course, the footing broken by
    // the doorway.
    const foot = (x: number, w: number) =>
      body.push(paint(box(w, 0.7, 0.16, x, 0.35, 0.08), FOOTING));
    if (way) {
      const l = way.x0 - FRAME_HALF;
      const r = way.x0 + FRAME_HALF;
      foot((-width / 2 + l) / 2, l + width / 2);
      foot((r + width / 2) / 2, width / 2 - r);
      frame(body, way.x0, way.depth);
      if (way.next) stair(body, way.x0, way.depth);
      else doorway(body, glass, way.x0, way.depth);
    } else {
      foot(0, width);
      banner(body, -3.3, 9.6);
      banner(body, 3.3, 9.6);
    }
    body.push(
      paint(box(width, 0.22, 0.14, 0, 4.5, 0.07), TRIM),
      paint(box(width, 0.5, 0.3, 0, WALL_H - 0.25, 0.15), TRIM),
    );
    archWindow(body, glass);
    onWall(body, b0, a, apothem);
    onWall(glass, g0, a, apothem);
    glow.seedNow = k;
    glow.shaft();
    glow.take((g) => place(g, a, apothem));
  }

  // The pilasters and their torches, in the corners.
  const flamesAt: { at: THREE.Vector3; seed: number }[] = [];
  for (let k = 0; k < SIDES; k++) {
    const c = CORNER0 + k * STEP_A;
    const b0 = body.length;
    glow.seedNow = k;
    pilaster(body, glow);
    onWall(body, b0, c, corner);
    glow.take((g) => place(g, c, corner));
    const r = corner - FLAME_OUT;
    flamesAt.push({
      at: new THREE.Vector3(Math.sin(c) * r, TORCH_Y + 0.1, Math.cos(c) * r),
      seed: k,
    });
  }

  // The vault: from the walls' top up to its crown, darkening as it
  // rises out of the light, a rib up from every corner to a gold boss.
  const vault = (g: THREE.BufferGeometry) =>
    fade(g, "#3b3029", (_x, y) => ((y - WALL_H) / (VAULT_TOP - WALL_H)) * 0.95);
  body.push(
    vault(
      paint(
        inward(
          new THREE.CylinderGeometry(
            0.6,
            corner,
            VAULT_TOP - WALL_H,
            SIDES,
            4,
            true,
            CORNER0,
          ).translate(0, (WALL_H + VAULT_TOP) / 2, 0),
        ),
        "#b9ae9d",
      ),
    ),
    paint(
      new THREE.CylinderGeometry(1, 1, 0.3, 12).translate(
        0,
        VAULT_TOP - 0.2,
        0,
      ),
      GOLD,
    ),
  );
  const crown = new THREE.Vector3(0, VAULT_TOP, 0);
  const z = new THREE.Vector3(0, 0, 1);
  for (let k = 0; k < SIDES; k++) {
    const c = CORNER0 + k * STEP_A;
    const from = new THREE.Vector3(
      Math.sin(c) * (corner - 0.6),
      WALL_H,
      Math.cos(c) * (corner - 0.6),
    );
    const along = crown.clone().sub(from);
    const g = box(0.5, 0.4, along.length())
      .applyQuaternion(
        new THREE.Quaternion().setFromUnitVectors(z, along.clone().normalize()),
      )
      .translate(
        (from.x + crown.x) / 2,
        (from.y + crown.y) / 2,
        (from.z + crown.z) / 2,
      );
    body.push(vault(paint(g, RIB)));
  }

  // The floor: the walls' shape, flat (the flagstones are its shader's).
  const floor = new THREE.CircleGeometry(corner, SIDES, CORNER0).rotateX(
    -Math.PI / 2,
  );

  // The flames: little cones, each knowing its base (to flicker about).
  const flameParts = flamesAt.map(({ at, seed }) => {
    const g = new THREE.ConeGeometry(0.15, 0.55, 6)
      .translate(at.x, at.y + 0.275, at.z)
      .toNonIndexed();
    g.deleteAttribute("uv");
    g.deleteAttribute("normal");
    const n = g.attributes.position.count;
    const centre = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) centre.set([at.x, at.y, at.z], i * 3);
    g.setAttribute("aCenter", new THREE.BufferAttribute(centre, 3));
    g.setAttribute(
      "aSeed",
      new THREE.BufferAttribute(new Float32Array(n).fill(seed), 1),
    );
    return g;
  });

  const glassParts = glass.map((g) => {
    const out = g.index ? g.toNonIndexed() : g;
    out.deleteAttribute("uv");
    out.deleteAttribute("normal");
    return out;
  });

  const merge = (parts: THREE.BufferGeometry[]) => {
    const g = mergeGeometries(parts);
    if (!g) throw new Error("TowerHall: parts don't merge");
    for (const p of parts) p.dispose();
    return g;
  };
  return {
    body: merge(body),
    floor,
    glass: merge(glassParts),
    flames: merge(flameParts),
    glow: glow.geometry(),
  };
}

/** Cut away whatever's on the wall at a fragment's bearing when the
 * camera's beyond that wall (see the top). */
function cutawayGlsl(cut: number) {
  return /* glsl */ `
void cutaway( vec3 w ) {
  float l = length( w.xz );
  if ( l > 0.5 && dot( cameraPosition.xz, w.xz / l ) > ${cut.toFixed(3)} ) discard;
}`;
}

/** The nearest torch's light on a point (the torches don't light anything
 * themselves): warm, falling off with distance, flickering on the clock. */
function torchGlsl(plan: Plan) {
  return /* glsl */ `
uniform float uTime;
vec3 torchLight( vec3 p ) {
  const float STEP_A = ${STEP_A.toFixed(6)};
  const float CORNER0 = ${CORNER0.toFixed(6)};
  float k = floor( ( atan( p.x, p.z ) - CORNER0 ) / STEP_A + 0.5 );
  float a = CORNER0 + k * STEP_A;
  vec3 d = p - vec3( sin( a ) * ${plan.torchR.toFixed(3)}, ${plan.torchY.toFixed(3)}, cos( a ) * ${plan.torchR.toFixed(3)} );
  float flick = 0.85 + 0.1 * sin( uTime * 9.0 + k * 1.7 ) + 0.05 * sin( uTime * 23.0 + k * 3.1 );
  return vec3( 1.0, 0.62, 0.3 ) * ( 0.9 * flick / ( 1.0 + dot( d, d ) * 0.18 ) );
}`;
}

/** Where a fragment is in the world, for the patches below. */
function withWorld(
  shader: THREE.WebGLProgramParametersWithUniforms,
  fragmentCommon: string,
) {
  shader.uniforms.uTime = ambient.uTime;
  shader.vertexShader = shader.vertexShader
    .replace(
      "#include <common>",
      /* glsl */ `#include <common>
varying vec3 vHallWorld;`,
    )
    .replace(
      "#include <project_vertex>",
      /* glsl */ `#include <project_vertex>
vHallWorld = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;`,
    );
  shader.fragmentShader = shader.fragmentShader
    .replace(
      "#include <common>",
      /* glsl */ `#include <common>
varying vec3 vHallWorld;
${fragmentCommon}`,
    )
    .replace(
      "#include <emissivemap_fragment>",
      /* glsl */ `#include <emissivemap_fragment>
totalEmissiveRadiance += diffuseColor.rgb * torchLight( vHallWorld );`,
    );
}

/** The stone: the Tower's ashlar on the walls, torchlit, cut away. */
function bodyMaterial(plan: Plan): THREE.Material {
  const blocks = Math.round((2 * Math.PI * plan.apothem) / 1.5);
  return chain(
    ashlar(
      new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true }),
      plan.apothem,
      blocks,
    ),
    `hall:${plan.corner}`,
    (shader) => {
      withWorld(shader, `${torchGlsl(plan)}\n${cutawayGlsl(plan.cut)}`);
      shader.fragmentShader = shader.fragmentShader.replace(
        "#include <clipping_planes_fragment>",
        /* glsl */ `#include <clipping_planes_fragment>
cutaway( vHallWorld );`,
      );
    },
  );
}

/**
 * The floor: flagstones in rings round the middle, a whole number to a
 * ring, staggered ring to ring, each stone its own shade with dark joints;
 * in the middle a compass — a pale eight-pointed star on indigo in a gold
 * ring — and another gold ring further out; darker stones at the walls'
 * feet. Torchlit like the walls. Far off, the joints give way to their
 * average.
 */
function floorMaterial(plan: Plan): THREE.Material {
  const gold = new THREE.Color(GOLD);
  const indigo = new THREE.Color(INDIGO);
  const pale = new THREE.Color(TRIM);
  const v3 = (c: THREE.Color) =>
    `vec3( ${c.r.toFixed(4)}, ${c.g.toFixed(4)}, ${c.b.toFixed(4)} )`;
  return chain(
    new THREE.MeshLambertMaterial({ color: FLOOR }),
    `hallFloor:${plan.corner}`,
    (shader) => {
      withWorld(
        shader,
        /* glsl */ `${torchGlsl(plan)}
float flagHash( vec2 p ) {
  p = fract( p * vec2( 123.34, 456.21 ) );
  p += dot( p, p + 45.32 );
  return fract( p.x * p.y );
}`,
      );
      shader.fragmentShader = shader.fragmentShader.replace(
        "#include <color_fragment>",
        /* glsl */ `#include <color_fragment>
{
  vec2 p = vHallWorld.xz;
  float r = length( p );
  float a = atan( p.x, p.y );
  float px = fwidth( r ) + 1e-4;
  const float W = 1.5;
  const float R0 = 2.7;
  vec3 base = diffuseColor.rgb;
  if ( r < 2.4 ) {
    // The compass: a star's points reach 2.1 out, its waist 0.9.
    float slice = 3.14159265 / 4.0;
    float off = abs( mod( a + slice / 2.0, slice ) - slice / 2.0 ) / ( slice / 2.0 );
    float edge = mix( 2.1, 0.9, off );
    float star = 1.0 - smoothstep( edge - px, edge + px, r );
    diffuseColor.rgb = mix( ${v3(indigo)}, ${v3(pale)} * 0.9, star );
  } else if ( r < R0 ) {
    diffuseColor.rgb = ${v3(gold)};
  } else {
    float ring = floor( ( r - R0 ) / W );
    float mid = R0 + ( ring + 0.5 ) * W;
    float n = max( 8.0, floor( 6.2831853 * mid / 1.7 ) );
    float len = 6.2831853 * mid / n;
    float along = ( a / 6.2831853 + 0.5 ) * n + mod( ring, 2.0 ) * 0.5;
    float fu = fract( along ) * len;
    float fv = fract( ( r - R0 ) / W ) * W;
    float e = min( min( fu, len - fu ), min( fv, W - fv ) );
    float joint = 1.0 - smoothstep( 0.04, 0.04 + px * 1.5, e );
    float tone = 0.86 + 0.2 * flagHash( vec2( floor( along ), ring ) );
    if ( r > ${(plan.apothem - 1.2).toFixed(3)} ) tone *= 0.78;
    vec3 stone = mix( base * tone, base * 0.6, joint );
    diffuseColor.rgb = mix( stone, base * 0.9, smoothstep( 0.3, 0.7, px ) );
    float inlay = 1.0 - smoothstep( 0.08, 0.08 + px, abs( r - ( R0 + 6.0 * W ) ) );
    diffuseColor.rgb = mix( diffuseColor.rgb, ${v3(gold)}, inlay );
  }
}`,
      );
    },
  );
}

/** The windows: the sky behind them as you'd see it from where you
 * stand (the same sky the islands have, at the same hour), a little
 * brighter for the light coming through. */
function glassMaterial(plan: Plan): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      uTop: skyUniforms.uTop,
      uHorizon: skyUniforms.uHorizon,
      uBottom: skyUniforms.uBottom,
      uSunDir: skyUniforms.uSunDir,
      uSunColor: skyUniforms.uSunColor,
      uFlash: skyUniforms.uFlash,
    },
    vertexShader: /* glsl */ `
      varying vec3 vWorld;
      void main() {
        vec4 w = modelMatrix * vec4( position, 1.0 );
        vWorld = w.xyz;
        gl_Position = projectionMatrix * viewMatrix * w;
      }
    `,
    fragmentShader: /* glsl */ `
      ${SKY_GRADIENT_GLSL}
      ${cutawayGlsl(plan.cut)}
      varying vec3 vWorld;
      void main() {
        cutaway( vWorld );
        vec3 c = skyColor( normalize( vWorld - cameraPosition ) );
        gl_FragColor = vec4( c * 1.2 + vec3( 0.05, 0.045, 0.03 ), 1.0 );
        #include <colorspace_fragment>
      }
    `,
  });
}

/** The torches' flames: each cone flickers about its base, yellow at the
 * root, orange at the tip. */
function flameMaterial(plan: Plan): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: { uTime: ambient.uTime },
    vertexShader: /* glsl */ `
      uniform float uTime;
      attribute vec3 aCenter;
      attribute float aSeed;
      varying vec3 vWorld;
      varying float vUp;
      void main() {
        vec3 d = position - aCenter;
        float sx = 1.0 + 0.12 * sin( uTime * 11.0 + aSeed * 5.0 );
        float sy = 1.0 + 0.22 * sin( uTime * 7.3 + aSeed * 3.0 ) + 0.1 * sin( uTime * 17.0 + aSeed );
        vUp = clamp( d.y / 0.55, 0.0, 1.0 );
        vec4 w = modelMatrix * vec4( aCenter + vec3( d.x * sx, d.y * sy, d.z * sx ), 1.0 );
        vWorld = w.xyz;
        gl_Position = projectionMatrix * viewMatrix * w;
      }
    `,
    fragmentShader: /* glsl */ `
      ${cutawayGlsl(plan.cut)}
      varying vec3 vWorld;
      varying float vUp;
      void main() {
        cutaway( vWorld );
        gl_FragColor = vec4( mix( vec3( 1.0, 0.9, 0.55 ), vec3( 1.0, 0.42, 0.08 ), vUp ), 1.0 );
        #include <colorspace_fragment>
      }
    `,
  });
}

/** The torches' halos and, by day, the shafts from the windows: added
 * light, nothing hidden behind it. */
function glowMaterial(plan: Plan): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: { uTime: ambient.uTime, uNight: skyUniforms.uNight },
    vertexShader: /* glsl */ `
      uniform float uTime;
      uniform float uNight;
      attribute float aAlpha;
      attribute float aKind;
      attribute float aSeed;
      varying vec3 vWorld;
      varying float vAlpha;
      varying float vKind;
      void main() {
        float flick = 0.8 + 0.12 * sin( uTime * 9.0 + aSeed * 1.7 ) + 0.08 * sin( uTime * 23.0 + aSeed * 3.1 );
        vAlpha = aAlpha * ( aKind < 0.5 ? 0.45 * flick : 0.07 * ( 1.0 - 0.9 * uNight ) );
        vKind = aKind;
        vec4 w = modelMatrix * vec4( position, 1.0 );
        vWorld = w.xyz;
        gl_Position = projectionMatrix * viewMatrix * w;
      }
    `,
    fragmentShader: /* glsl */ `
      ${cutawayGlsl(plan.cut)}
      varying vec3 vWorld;
      varying float vAlpha;
      varying float vKind;
      void main() {
        cutaway( vWorld );
        vec3 c = vKind < 0.5 ? vec3( 1.0, 0.6, 0.25 ) : vec3( 1.0, 0.93, 0.78 );
        gl_FragColor = vec4( c, vAlpha );
        #include <colorspace_fragment>
      }
    `,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
  });
}

/** The Tower's hall, for a map with `room: "tower"`. */
export function TowerHall({ map }: { map: TownMap }) {
  const built = useMemo(() => {
    const plan = planFor(map);
    return {
      hall: buildHall(map, plan),
      body: bodyMaterial(plan),
      floor: floorMaterial(plan),
      glass: glassMaterial(plan),
      flames: flameMaterial(plan),
      glow: glowMaterial(plan),
    };
  }, [map]);
  useEffect(
    () => () => {
      for (const g of Object.values(built.hall)) g.dispose();
      built.body.dispose();
      built.floor.dispose();
      built.glass.dispose();
      built.flames.dispose();
      built.glow.dispose();
    },
    [built],
  );
  const { hall } = built;
  return (
    <>
      <mesh geometry={hall.body} material={built.body} receiveShadow />
      <mesh geometry={hall.floor} material={built.floor} receiveShadow />
      <mesh geometry={hall.glass} material={built.glass} />
      <mesh geometry={hall.flames} material={built.flames} />
      <mesh geometry={hall.glow} material={built.glow} renderOrder={1} />
    </>
  );
}
