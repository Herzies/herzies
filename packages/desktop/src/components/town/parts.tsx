import { mulberry32 } from "@herzies/shared";
import { useLayoutEffect, useRef } from "react";
import * as THREE from "three";

// What the Town's instanced scenery is made of: a thing placed on the
// ground, the parts it's drawn with, and one draw call per part.

export type Placed = {
  x: number;
  /** The ground it stands on. */
  y: number;
  z: number;
  scale: number;
  yaw: number;
  /** Stretched taller (or shorter) than its scale. */
  tall?: number;
  /** Leaning over, about x and z, in radians. */
  tilt?: [number, number];
  /** Tinted (times its own colours). */
  tint?: THREE.Color;
};
/** One of several drawn per thing (a flower in a patch): its offset in
 * the thing's own frame, and its size. */
export type Copy = { x: number; z: number; s: number };
export type Part = {
  geometry: THREE.BufferGeometry;
  material: THREE.Material;
  /** Where the part sits on a thing of scale 1 (and its own scale). */
  y: number;
  shape?: [number, number, number];
  /** Draw it several times per thing (default: once, in the middle). */
  copies?: Copy[];
  /** Tint each copy with one of these, picked steadily per copy. */
  palette?: string[];
  /** What its shadow is drawn with, if not the usual. */
  shadow?: THREE.Material;
};

/** A shape coloured all over one colour, ready to merge. */
export function painted(
  g: THREE.BufferGeometry,
  hex: string,
): THREE.BufferGeometry {
  const out = g.index ? g.toNonIndexed() : g;
  out.deleteAttribute("uv");
  const c = new THREE.Color(hex);
  const colors = new Float32Array(out.attributes.position.count * 3);
  for (let i = 0; i < colors.length; i += 3) c.toArray(colors, i);
  out.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  return out;
}

export const ONCE: Copy[] = [{ x: 0, z: 0, s: 1 }];

/** One part (say, every tree's leaves) as one instanced draw call. */
export function PartMesh({
  part,
  things,
  cast,
}: {
  part: Part;
  things: Placed[];
  cast: boolean;
}) {
  const ref = useRef<THREE.InstancedMesh>(null);
  useLayoutEffect(() => {
    const mesh = ref.current;
    if (!mesh) return;
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const lean = new THREE.Quaternion();
    const euler = new THREE.Euler();
    const up = new THREE.Vector3(0, 1, 0);
    const [sx, sy, sz] = part.shape ?? [1, 1, 1];
    const copies = part.copies ?? ONCE;
    const color = new THREE.Color();
    let i = 0;
    for (const t of things) {
      q.setFromAxisAngle(up, t.yaw);
      if (t.tilt) {
        q.premultiply(lean.setFromEuler(euler.set(t.tilt[0], 0, t.tilt[1])));
      }
      const tall = t.tall ?? 1;
      const cos = Math.cos(t.yaw);
      const sin = Math.sin(t.yaw);
      for (const [j, cp] of copies.entries()) {
        const s = t.scale * cp.s;
        m.compose(
          new THREE.Vector3(
            t.x + (cp.x * cos + cp.z * sin) * t.scale,
            t.y + part.y * s,
            t.z + (cp.z * cos - cp.x * sin) * t.scale,
          ),
          q,
          new THREE.Vector3(sx * s, sy * s * tall, sz * s),
        );
        mesh.setMatrixAt(i, m);
        if (part.palette) {
          const pick = mulberry32(Math.round(t.x * 131 + t.z * 7919) + j)();
          color.set(part.palette[Math.floor(pick * part.palette.length)]);
          mesh.setColorAt(i, color);
        } else if (t.tint) mesh.setColorAt(i, t.tint);
        i++;
      }
    }
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    mesh.computeBoundingSphere();
  }, [part, things]);
  const count = things.length * (part.copies?.length ?? 1);
  if (count === 0) return null;
  return (
    <instancedMesh
      // A new count needs a new mesh.
      key={count}
      ref={ref}
      args={[part.geometry, part.material, count]}
      customDepthMaterial={part.shadow}
      castShadow={cast}
      receiveShadow
    />
  );
}
