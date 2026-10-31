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

type Palette = { deep: string; mid: string; lit: string };

/** A colour along a palette, 0 (deep) to 1 (lit). */
function along(p: Palette, t: number, out: THREE.Color): THREE.Color {
  const k = Math.min(1, Math.max(0, t));
  return k < 0.5
    ? out.lerpColors(new THREE.Color(p.deep), new THREE.Color(p.mid), k / 0.5)
    : out.lerpColors(
        new THREE.Color(p.mid),
        new THREE.Color(p.lit),
        (k - 0.5) / 0.5,
      );
}

/** Which clump each corner belongs to, 0–1 (the wood: 1): the Town tells
 * an oak's leaves from its wood by it, and varies its colours clump to
 * clump. */
function lumped(g: THREE.BufferGeometry, lump: number): THREE.BufferGeometry {
  const n = g.attributes.position.count;
  g.setAttribute(
    "lump",
    new THREE.Float32BufferAttribute(new Float32Array(n).fill(lump), 1),
  );
  return g;
}

/** The light the crowns are shaded toward (matches the Town's sun). */
const SUN = new THREE.Vector3(-0.4, 0.8, 0.45).normalize();

/**
 * One rounded clump of leaves: a smooth, gently lumpy ball, lit as part
 * of the whole crown — its normals lean out from the crown's middle
 * (`from`), so a few clumps shade as one soft mass, dark underneath and
 * lit on top, rather than each its own facets.
 */
function clump(
  centre: THREE.Vector3,
  radii: THREE.Vector3,
  palette: Palette,
  from: THREE.Vector3,
  seed: number,
): THREE.BufferGeometry {
  const g = new THREE.IcosahedronGeometry(1, 3);
  g.deleteAttribute("uv");
  const pos = g.attributes.position;
  const normals: number[] = [];
  const colors: number[] = [];
  const v = new THREE.Vector3();
  const own = new THREE.Vector3();
  const out = new THREE.Vector3();
  const c = new THREE.Color();
  const phase = seed * 1.7;
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    // Its own (ellipsoid) normal, before it's pushed about.
    own.copy(v).divide(radii).normalize();
    const k =
      1 +
      0.1 *
        Math.sin(v.x * 5.1 + v.y * 3.3 + phase) *
        Math.sin(v.z * 4.7 - v.y * 2.1 + phase);
    v.multiplyScalar(k).multiply(radii).add(centre);
    pos.setXYZ(i, v.x, v.y, v.z);
    out.copy(v).sub(from).normalize();
    own.lerp(out, 0.6).normalize();
    normals.push(own.x, own.y, own.z);
    along(palette, 0.28 + 0.5 * (own.y * 0.5 + 0.5) + 0.12 * own.dot(SUN), c);
    colors.push(c.r, c.g, c.b);
  }
  g.setAttribute("normal", new THREE.Float32BufferAttribute(normals, 3));
  g.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
  return g;
}

/** A pine: a stack of tiers, each a cone with a ragged hem hanging off
 * it, dark at the rim and lit higher up — lit softly, as one cone (its
 * normals out and up from the trunk), not facet by facet. */
export function pineGeometry(seed: number): THREE.BufferGeometry {
  const rand = mulberry32(seed);
  const parts = [
    shaded(
      new THREE.CylinderGeometry(0.22, 0.34, 3.6, 6).translate(0, 1.8, 0),
      flat("#5a4030"),
    ),
  ];
  const palette = { deep: "#163a22", mid: "#2f6338", lit: "#4f8a50" };
  const tiers = 4;
  let base = 2.3 + rand() * 0.3;
  for (let i = 0; i < tiers; i++) {
    const t = i / (tiers - 1);
    const radius = (2.1 - t * 1.25) * (0.92 + rand() * 0.16);
    const height = 3.3 - t * 0.9;
    const turn = rand() * Math.PI;
    const teeth = 8 + Math.floor(rand() * 3);
    const cone = new THREE.ConeGeometry(radius, height, 18, 3, true)
      .rotateY(turn)
      .translate(0, base + height / 2, 0)
      .toNonIndexed();
    cone.deleteAttribute("uv");
    const pos = cone.attributes.position;
    const normals: number[] = [];
    const colors: number[] = [];
    const c = new THREE.Color();
    const n = new THREE.Vector3();
    for (let k = 0; k < pos.count; k++) {
      let x = pos.getX(k);
      let y = pos.getY(k);
      let z = pos.getZ(k);
      const f = (y - base) / height;
      if (f < 0.02) {
        // The hem: every other point hangs lower and a little further out.
        const tooth = Math.cos((Math.atan2(z, x) - turn) * teeth) > 0 ? 1 : 0;
        y -= tooth * 0.45;
        x *= 1 + tooth * 0.08;
        z *= 1 + tooth * 0.08;
        pos.setXYZ(k, x, y, z);
      }
      n.set(x, radius * 0.9, z).normalize();
      normals.push(n.x, n.y, n.z);
      along(palette, 0.15 + f * 0.75 + n.dot(SUN) * 0.15, c);
      colors.push(c.r, c.g, c.b);
    }
    cone.setAttribute("normal", new THREE.Float32BufferAttribute(normals, 3));
    cone.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
    parts.push(cone);
    // Closed underneath, in shadow.
    const under = new THREE.CircleGeometry(radius, 9)
      .rotateX(Math.PI / 2)
      .rotateY(turn)
      .translate(0, base + 0.02, 0);
    parts.push(shaded(under, flat("#163a22")));
    // The next tier starts a little over halfway up this one.
    base += height * (0.5 + rand() * 0.06);
  }
  return mergeGeometries(parts) as THREE.BufferGeometry;
}

/** An oak: a thick, short trunk forking into heavy limbs that end in
 * twigs (bare, in winter, it's still a tree), under a crown of a few big
 * rounded clumps of leaves. */
export function oakGeometry(seed: number): THREE.BufferGeometry {
  const rand = mulberry32(seed);
  const bark = flat("#4e3828");
  const wood = (g: THREE.BufferGeometry) => lumped(shaded(g, bark), 1);
  const yaw = rand() * Math.PI * 2;
  const parts = [
    wood(new THREE.CylinderGeometry(0.38, 0.6, 3.6, 7).translate(0, 1.8, 0)),
  ];
  const limbs: [number, number, number, number, number][] = [
    [3.1, 2.2, 0.3, 0.6, 0],
    [3.3, 2.0, 0.26, 0.55, 2.4],
    [3.4, 1.7, 0.2, 0.75, 4.3],
    [3.6, 1.6, 0.16, 0.35, 1.2],
  ];
  for (const [y, length, radius, lean, turn] of limbs) {
    parts.push(wood(branch([0, y, 0], length, radius, lean, yaw + turn)));
    // Where the limb ends, a few twigs fork on.
    const tip = new THREE.Vector3(0, length, 0)
      .applyAxisAngle(new THREE.Vector3(0, 0, 1), -lean)
      .applyAxisAngle(new THREE.Vector3(0, 1, 0), yaw + turn)
      .add(new THREE.Vector3(0, y, 0));
    for (let k = 0; k < 3; k++) {
      parts.push(
        wood(
          branch(
            [tip.x, tip.y, tip.z],
            0.8 + rand() * 0.7,
            radius * 0.45,
            lean * 0.6 + (rand() - 0.5) * 0.9,
            yaw + turn + (rand() - 0.5) * 1.6,
          ),
        ),
      );
    }
  }
  const palette = { deep: "#1a3418", mid: "#3a6a2c", lit: "#7aa84a" };
  const middle = new THREE.Vector3(0, 6, 0);
  const lumps: [number, number, number, number][] = [
    [0, 6.2, 0, 1.7],
    [1.3, 5.6, 0.5, 1.3],
    [-1.3, 5.7, -0.3, 1.35],
    [0.2, 5.5, -1.3, 1.2],
    [-0.3, 5.4, 1.3, 1.2],
    [0.3, 7.2, 0.2, 1.1],
  ];
  for (const [i, [x, y, z, r]] of lumps.entries()) {
    const k = 0.9 + rand() * 0.2;
    const spin = yaw * 0.5;
    const at = new THREE.Vector3(x, y, z).applyAxisAngle(
      new THREE.Vector3(0, 1, 0),
      spin,
    );
    parts.push(
      lumped(
        clump(
          at,
          new THREE.Vector3(r * k, r * 0.85 * k, r * k),
          palette,
          middle,
          seed * 13 + i,
        ),
        // Spread through 0–1, steady per clump: the order they drop in
        // (the big middle one last).
        1 - (i + 0.5) / lumps.length,
      ),
    );
  }
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
