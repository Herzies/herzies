import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { mulberry32 } from "../creature-renderer.js";

// The Town's scenery shapes (trees, bushes, grass, rocks), plain geometry
// with colours baked in per vertex: the Town draws them with its own
// swaying materials, and anything else (the website's little islands)
// with plain ones.

/** Colour a geometry by height: `shade(y, x, z)` per vertex. In the shape
 * mergeGeometries wants: no index, no uvs. */
function shaded(
  g: THREE.BufferGeometry,
  shade: (y: number, x: number, z: number) => THREE.Color,
): THREE.BufferGeometry {
  const out = g.index ? g.toNonIndexed() : g;
  out.deleteAttribute("uv");
  const pos = out.attributes.position;
  const colors: number[] = [];
  for (let i = 0; i < pos.count; i++) {
    const c = shade(pos.getY(i), pos.getX(i), pos.getZ(i));
    colors.push(c.r, c.g, c.b);
  }
  out.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
  return out;
}

const flat = (hex: string) => {
  const c = new THREE.Color(hex);
  return () => c;
};

/** A branch: a thin cylinder from `from`, leaning out toward `yaw`. */
function branch(
  from: [number, number, number],
  length: number,
  radius: number,
  lean: number,
  yaw: number,
): THREE.BufferGeometry {
  const g = new THREE.CylinderGeometry(radius * 0.6, radius, length, 5);
  g.translate(0, length / 2, 0);
  g.rotateZ(-lean);
  g.rotateY(yaw);
  return g.translate(...from);
}

/** A steady 0–1 for a point: the same wherever the same corner turns up
 * (in each face that shares it), so displacing by it leaves no cracks. */
function hash3(x: number, y: number, z: number): number {
  const k = (v: number) => Math.round(v * 1000);
  return mulberry32(
    Math.imul(k(x), 73856093) ^
      Math.imul(k(y), 19349663) ^
      Math.imul(k(z), 83492791),
  )();
}

/**
 * A leafy crown: a few dark masses inside, and over them many smaller,
 * lumpy clumps of leaves, spread over an ellipsoid and heaped up on top, so
 * the outline is broken and bumpy. Coloured face by face — dark inside and
 * underneath, lit on the outer, sunward side, each face a shade of its own
 * and a few catching the light — so it reads as leaves, not balls.
 */
function leafyCrown(
  rand: () => number,
  centre: [number, number, number],
  radii: [number, number, number],
  palette: { deep: string; mid: string; lit: string; glint: string },
): THREE.BufferGeometry[] {
  const [cx, cy, cz] = centre;
  const [rx, ry, rz] = radii;
  const lumps: [number, number, number, number][] = [];
  // The dark masses inside, holding the shape together.
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + rand();
    lumps.push([
      cx + Math.cos(a) * rx * 0.35,
      cy + (rand() - 0.4) * ry * 0.5,
      cz + Math.sin(a) * rz * 0.35,
      Math.min(rx, rz) * (0.6 + rand() * 0.15),
    ]);
  }
  // Clumps over the surface, fewer underneath.
  for (let i = 0; i < 22; i++) {
    const a = rand() * Math.PI * 2;
    const up = rand() * 1.5 - 0.5;
    const t = Math.max(-0.55, Math.min(1, up));
    const flat = Math.sqrt(1 - t * t);
    const r = 0.65 + rand() * 0.55;
    const out = 0.8 + rand() * 0.2;
    lumps.push([
      cx + Math.cos(a) * flat * rx * out,
      cy + t * ry * out,
      cz + Math.sin(a) * flat * rz * out,
      r,
    ]);
  }
  const deep = new THREE.Color(palette.deep);
  const mid = new THREE.Color(palette.mid);
  const lit = new THREE.Color(palette.lit);
  const glint = new THREE.Color(palette.glint);
  const sun = new THREE.Vector3(-0.4, 0.8, 0.45).normalize();
  const c = new THREE.Color();
  return lumps.map(([x, y, z, r]) => {
    const g = new THREE.IcosahedronGeometry(r, 1);
    // Lumpy: each corner pushed in or out a little.
    const pos = g.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      const px = pos.getX(i);
      const py = pos.getY(i);
      const pz = pos.getZ(i);
      const k = 0.78 + hash3(px + x, py + y, pz + z) * 0.4;
      pos.setXYZ(i, px * k + x, py * k * 0.88 + y, pz * k + z);
    }
    // Face by face (three corners each, unindexed).
    const colors: number[] = [];
    const a = new THREE.Vector3();
    const b = new THREE.Vector3();
    const d = new THREE.Vector3();
    const n = new THREE.Vector3();
    const mid3 = new THREE.Vector3();
    for (let f = 0; f < pos.count; f += 3) {
      a.fromBufferAttribute(pos, f);
      b.fromBufferAttribute(pos, f + 1);
      d.fromBufferAttribute(pos, f + 2);
      mid3.copy(a).add(b).add(d).divideScalar(3);
      n.copy(b).sub(a).cross(d.clone().sub(a)).normalize();
      // How far out of the crown, and how high: the inside and the
      // underside in shadow.
      const ox = (mid3.x - cx) / rx;
      const oy = (mid3.y - cy) / ry;
      const oz = (mid3.z - cz) / rz;
      const outward = Math.min(1, Math.hypot(ox, oy, oz));
      const height = Math.min(1, Math.max(0, oy * 0.5 + 0.5));
      const light = Math.max(0, n.dot(sun));
      let t = outward * 0.55 + height * 0.3 + light * 0.25;
      t += (hash3(mid3.x, mid3.y, mid3.z) - 0.5) * 0.22;
      t = Math.min(1, Math.max(0, t));
      if (t < 0.5) c.lerpColors(deep, mid, t / 0.5);
      else c.lerpColors(mid, lit, (t - 0.5) / 0.5);
      // Now and then a face on the sunny side catches the light.
      if (light > 0.55 && outward > 0.8 && hash3(mid3.z, mid3.x, 7) < 0.14) {
        c.lerp(glint, 0.7);
      }
      for (let v = 0; v < 3; v++) colors.push(c.r, c.g, c.b);
    }
    g.deleteAttribute("uv");
    g.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
    return g;
  });
}

/** A pine: a stack of tiers, each dark at its rim and lit higher up, so
 * every tier — and every tree beside it — stands out from the next. */
export function pineGeometry(seed: number): THREE.BufferGeometry {
  const rand = mulberry32(seed);
  const parts = [
    shaded(
      new THREE.CylinderGeometry(0.22, 0.34, 3.6, 6).translate(0, 1.8, 0),
      flat("#5a4030"),
    ),
  ];
  const tiers = 4;
  let base = 2.3 + rand() * 0.3;
  for (let i = 0; i < tiers; i++) {
    const t = i / (tiers - 1);
    const radius = (2.1 - t * 1.25) * (0.92 + rand() * 0.16);
    const height = 3.3 - t * 0.9;
    const dx = (rand() - 0.5) * 0.16;
    const dz = (rand() - 0.5) * 0.16;
    const turn = rand() * Math.PI;
    const shade = (() => {
      const rim = new THREE.Color("#1d4529");
      const lit = new THREE.Color(i % 2 === 0 ? "#3f7a45" : "#3a7442");
      const tip = new THREE.Color("#2f6338");
      const c = new THREE.Color();
      return (y: number) => {
        const f = (y - base) / height;
        return f < 0.45
          ? c.lerpColors(rim, lit, f / 0.45)
          : c.lerpColors(lit, tip, (f - 0.45) / 0.55);
      };
    })();
    const cone = new THREE.ConeGeometry(radius, height, 7, 1, true)
      .rotateY(turn)
      .translate(dx, base + height / 2, dz);
    parts.push(shaded(cone, shade));
    // Closed underneath, in shadow.
    const under = new THREE.CircleGeometry(radius, 7)
      .rotateX(Math.PI / 2)
      .rotateY(turn)
      .translate(dx, base + 0.02, dz);
    parts.push(shaded(under, flat("#163a22")));
    // The next tier starts a little over halfway up this one.
    base += height * (0.5 + rand() * 0.06);
  }
  return mergeGeometries(parts) as THREE.BufferGeometry;
}

/** An oak: a thick, short trunk forking into heavy branches, under a
 * broad, lumpy crown. */
export function oakGeometry(seed: number): THREE.BufferGeometry {
  const rand = mulberry32(seed);
  const bark = flat("#4e3828");
  const yaw = rand() * Math.PI * 2;
  const parts = [
    shaded(
      new THREE.CylinderGeometry(0.38, 0.6, 3.6, 7).translate(0, 1.8, 0),
      bark,
    ),
    shaded(branch([0, 3.1, 0], 2.2, 0.3, 0.6, yaw), bark),
    shaded(branch([0, 3.3, 0], 2.0, 0.26, 0.55, yaw + 2.4), bark),
    shaded(branch([0, 3.4, 0], 1.7, 0.2, 0.75, yaw + 4.3), bark),
    shaded(branch([0, 3.6, 0], 1.6, 0.16, 0.35, yaw + 1.2), bark),
    ...leafyCrown(
      rand,
      [(rand() - 0.5) * 0.4, 6.0 + rand() * 0.4, (rand() - 0.5) * 0.4],
      [2.5 + rand() * 0.3, 1.75, 2.4 + rand() * 0.3],
      { deep: "#1a3418", mid: "#3a6a2c", lit: "#6e9e44", glint: "#a8c860" },
    ),
  ];
  return mergeGeometries(parts) as THREE.BufferGeometry;
}

/** A tuft of tall grass: blades leaning out every which way, dark at the
 * root and light at the tip. */
export function tuftGeometry(): THREE.BufferGeometry {
  const rand = mulberry32(4711);
  const base = new THREE.Color("#2c5a2c");
  const tip = new THREE.Color("#9cc76a");
  const blades = Array.from({ length: 11 }, () => {
    const h = 0.55 + rand() * 0.45;
    const g = new THREE.ConeGeometry(0.06, h, 3).toNonIndexed();
    g.translate(0, h / 2, 0);
    g.rotateZ((rand() - 0.5) * 0.7);
    g.rotateY(rand() * Math.PI * 2);
    const a = rand() * Math.PI * 2;
    const r = Math.sqrt(rand()) * 0.4;
    g.translate(Math.cos(a) * r, 0, Math.sin(a) * r);
    const pos = g.attributes.position;
    const colors: number[] = [];
    const c = new THREE.Color();
    for (let i = 0; i < pos.count; i++) {
      c.lerpColors(base, tip, Math.min(1, pos.getY(i) / h));
      colors.push(c.r, c.g, c.b);
    }
    g.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
    g.deleteAttribute("uv");
    return g;
  });
  const tuft = mergeGeometries(blades) as THREE.BufferGeometry;
  tuft.computeVertexNormals();
  return tuft;
}

/** A bush: a few leafy lumps huddled together, dark underneath and lit
 * on top. */
export function bushGeometry(): THREE.BufferGeometry {
  const dark = new THREE.Color("#2c5a2c");
  const light = new THREE.Color("#5c9a48");
  const lumps = (
    [
      [0, 0.55, 0, 0.6],
      [0.36, 0.4, 0.2, 0.45],
      [-0.32, 0.42, -0.14, 0.48],
      [0.04, 0.38, -0.4, 0.4],
      [-0.12, 0.36, 0.4, 0.38],
    ] as const
  ).map(([x, y, z, r]) => {
    const g = new THREE.IcosahedronGeometry(r, 1);
    g.scale(1, 0.85, 1);
    g.translate(x, y, z);
    const pos = g.attributes.position;
    const colors: number[] = [];
    const c = new THREE.Color();
    for (let i = 0; i < pos.count; i++) {
      c.lerpColors(dark, light, Math.min(1, Math.max(0, pos.getY(i) / 1.05)));
      colors.push(c.r, c.g, c.b);
    }
    g.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
    g.deleteAttribute("uv");
    return g;
  });
  return mergeGeometries(lumps) as THREE.BufferGeometry;
}

/** A rock: a rough dodecahedron, squashed by its mesh's scale. */
export const rockGeometry = new THREE.DodecahedronGeometry(0.55, 0);

const grassMaterial = new THREE.MeshLambertMaterial({
  color: "#5b9a46",
  flatShading: true,
});
/** Lit mostly from below (the sky light's ground colour), so it glows a
 * little of its own to read against a dark page. */
const earthMaterial = new THREE.MeshLambertMaterial({
  color: "#8a6142",
  emissive: "#3a2618",
  flatShading: true,
});
const rockMaterial = new THREE.MeshLambertMaterial({
  color: "#7d7a80",
  flatShading: true,
});
const plantMaterial = new THREE.MeshLambertMaterial({
  vertexColors: true,
  flatShading: true,
});

let shapes: {
  oak: THREE.BufferGeometry;
  bush: THREE.BufferGeometry;
  tuft: THREE.BufferGeometry;
  top: THREE.BufferGeometry;
  under: THREE.BufferGeometry;
} | null = null;
/** Built the first time an island is, and shared by every one after. */
function islandShapes() {
  if (shapes) return shapes;
  const oak = oakGeometry(3);
  oak.computeVertexNormals();
  const bush = bushGeometry();
  bush.computeVertexNormals();
  shapes = {
    oak,
    bush,
    tuft: tuftGeometry(),
    top: new THREE.CylinderGeometry(2.9, 2.75, 0.35, 18).translate(
      0,
      -0.175,
      0,
    ),
    under: new THREE.ConeGeometry(2.7, 3, 9)
      .rotateX(Math.PI)
      .translate(0, -1.85, 0),
  };
  return shapes;
}

/**
 * A little floating island of the Town's to stand a herzie on (see
 * HerzieView's `scenery`): a grass top over a clod of earth, an oak behind,
 * a bush, a few rocks and tufts of grass, and the Town's daylight. Its own
 * object each call (an object has one parent); the shapes are shared.
 */
export function islandScenery(): THREE.Group {
  const s = islandShapes();
  const group = new THREE.Group();
  const mesh = (
    geometry: THREE.BufferGeometry,
    material: THREE.Material,
    [x, y, z]: [number, number, number],
    scale: number | [number, number, number] = 1,
    yaw = 0,
  ) => {
    const m = new THREE.Mesh(geometry, material);
    m.position.set(x, y, z);
    if (typeof scale === "number") m.scale.setScalar(scale);
    else m.scale.set(...scale);
    m.rotation.y = yaw;
    m.receiveShadow = true;
    group.add(m);
    return m;
  };
  mesh(s.top, grassMaterial, [0, 0, 0]);
  mesh(s.under, earthMaterial, [0, 0, 0]);
  mesh(s.oak, plantMaterial, [-1.5, 0, -1.6], 0.42, 0.6);
  mesh(s.bush, plantMaterial, [1.7, 0, -1.2], 0.75, 1.2);
  mesh(rockGeometry, rockMaterial, [1.9, 0.1, 0.4], [0.6, 0.4, 0.5], 0.4);
  mesh(rockGeometry, rockMaterial, [2.3, 0.06, -0.3], [0.35, 0.25, 0.3], 1.7);
  mesh(rockGeometry, rockMaterial, [-1.9, 0.07, 0.6], [0.4, 0.28, 0.35], 2.3);
  for (const [x, z, k] of [
    [-0.9, 1.3, 0.7],
    [1.0, 1.5, 0.6],
    [-2.2, -0.4, 0.7],
    [0.5, -1.9, 0.8],
    [2.4, 0.9, 0.5],
    [-0.4, -2.2, 0.6],
  ] as const) {
    mesh(s.tuft, plantMaterial, [x, 0, z], k, x * 3);
  }
  // The Town's sky light; the sun is HerzieView's own.
  group.add(new THREE.HemisphereLight("#bcd7ff", "#5a6684", 1.6));
  return group;
}
