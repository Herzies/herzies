import * as THREE from "three";
import { hasCardFrame } from "../card/artwork-from-icon.js";
import { getItemIcon } from "../card/ItemTypeIcon.js";
import { type ItemDef, RARITY_COLORS } from "../items.js";

// An item as the Town drops it: its icon built out of voxels, standing in a
// pillar of its rarity's light. The cave's loot (desktop) and the website's
// about page both draw it.

/** The voxel model's size: world units per pixel of a 24px icon. */
export const ITEM_VOXEL = 0.045;

export type Voxel = {
  /** Grid position: x right, y up (from the bottom row), z out of the card. */
  x: number;
  y: number;
  z: number;
  color: string;
  /** Glows a little (the rarity frame). */
  glow: boolean;
};

/**
 * The item's 24px icon as voxels, two deep. A card icon (most items) keeps
 * its card shape: the frame is painted in the rarity's colour and glows,
 * and the picture stands a voxel proud of the card's face, so it reads in
 * the round. Anything else (dice, the Safety Pick) is simply extruded.
 */
export function voxelsOf(item: ItemDef): Voxel[] {
  const { grid, palette } = getItemIcon(item);
  const card = hasCardFrame(grid);
  const h = grid.length;
  const frameColor = RARITY_COLORS[item.rarity];
  // The card's face colour: the commonest one inside the frame.
  let face: string | null = null;
  if (card) {
    const counts = new Map<string, number>();
    for (let y = 2; y < 22; y++)
      for (let x = 5; x < 19; x++) {
        const c = grid[y][x];
        if (c !== ".") counts.set(c, (counts.get(c) ?? 0) + 1);
      }
    face = [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  }
  const colorOf = (c: string) => {
    if (c === "#" || !palette) return "#d8d8e0";
    const i = Number.parseInt(c, 36);
    return palette[i] ?? "#d8d8e0";
  };
  const out: Voxel[] = [];
  for (let gy = 0; gy < h; gy++) {
    const row = grid[gy];
    for (let gx = 0; gx < row.length; gx++) {
      const c = row[gx];
      if (c === ".") continue;
      const y = h - 1 - gy;
      const frame = card && (gx === 4 || gx === 19 || gy === 1 || gy === 22);
      const color = frame ? frameColor : colorOf(c);
      // Card back and face, and the picture on the face one proud of it.
      out.push({ x: gx, y, z: 0, color, glow: frame });
      out.push({ x: gx, y, z: 1, color, glow: frame });
      if (card && !frame && c !== face)
        out.push({ x: gx, y, z: 2, color, glow: false });
      if (frame) out.push({ x: gx, y, z: 2, color, glow: true });
    }
  }
  return out;
}

const VOXEL_GEOMETRY = new THREE.BoxGeometry(
  ITEM_VOXEL,
  ITEM_VOXEL,
  ITEM_VOXEL,
);

/**
 * The item's voxel model, centred: one instanced mesh for the plain
 * voxels, one for the glowing rarity frame. Its materials are its own;
 * dispose both meshes and their materials when done.
 */
export function itemVoxelMeshes(
  item: ItemDef,
): [plain: THREE.InstancedMesh, glow: THREE.InstancedMesh] {
  const voxels = voxelsOf(item);
  const make = (list: Voxel[], material: THREE.Material) => {
    const mesh = new THREE.InstancedMesh(
      VOXEL_GEOMETRY,
      material,
      Math.max(1, list.length),
    );
    const m = new THREE.Matrix4();
    const c = new THREE.Color();
    list.forEach((vx, i) => {
      m.makeTranslation(
        (vx.x - 11.5) * ITEM_VOXEL,
        (vx.y - 11.5) * ITEM_VOXEL,
        (vx.z - 1) * ITEM_VOXEL,
      );
      mesh.setMatrixAt(i, m);
      mesh.setColorAt(i, c.set(vx.color));
    });
    mesh.count = list.length;
    return mesh;
  };
  return [
    make(
      voxels.filter((v) => !v.glow),
      new THREE.MeshLambertMaterial({ emissive: "#202020" }),
    ),
    make(
      voxels.filter((v) => v.glow),
      new THREE.MeshBasicMaterial({ toneMapped: false }),
    ),
  ];
}

const PILLAR_VERTEX = /* glsl */ `
  varying float vY;
  void main() {
    vY = position.y + 0.5;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;
const PILLAR_FRAGMENT = /* glsl */ `
  uniform vec3 uColor;
  uniform float uOpacity;
  varying float vY;
  void main() {
    // Bright at the floor, fading out up the beam.
    float a = pow(1.0 - clamp(vY, 0.0, 1.0), 1.6) * uOpacity;
    gl_FragColor = vec4(uColor, a);
  }
`;

/** A drop's beam of light: bright at the floor, fading up. Drawn on a unit
 * cylinder (y from -0.5 to 0.5); `uOpacity` fades it. */
export function lootPillarMaterial(color: THREE.Color): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: { uColor: { value: color }, uOpacity: { value: 0 } },
    vertexShader: PILLAR_VERTEX,
    fragmentShader: PILLAR_FRAGMENT,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending,
  });
}
