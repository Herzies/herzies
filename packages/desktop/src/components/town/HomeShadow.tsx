import { useFrame } from "@react-three/fiber";
import { useLayoutEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import { HOME_LAYER } from "./HomeLayer";
import { homeMode } from "./homeMode";

/** A soft round shadow, dark in the middle and gone at the edge. */
const blob = (() => {
  if (typeof document === "undefined") return null;
  const size = 64;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const g = canvas.getContext("2d");
  if (!g) return null;
  const grad = g.createRadialGradient(
    size / 2,
    size / 2,
    0,
    size / 2,
    size / 2,
    size / 2,
  );
  // An alpha map is read from its green: white is solid, black is gone.
  g.fillStyle = "#000";
  g.fillRect(0, 0, size, size);
  grad.addColorStop(0, "#fff");
  grad.addColorStop(0.45, "#b3b3b3");
  grad.addColorStop(1, "#000");
  g.fillStyle = grad;
  g.fillRect(0, 0, size, size);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.NoColorSpace;
  return texture;
})();

const geometry = new THREE.PlaneGeometry(2, 2).rotateX(-Math.PI / 2);

/** How dark it gets, at its middle. */
const STRENGTH = 0.45;

/**
 * Something's shadow at Home, where the ground it fell on has faded away:
 * a soft dark patch under it, so it still stands on something rather than
 * floating in the background. Only on Home's layer (the world has real
 * shadows), and only as the world goes. `strength` scales it (a drop's
 * shadow comes and goes with it).
 */
export function HomeShadow({
  radius,
  strength,
  y = 0.02,
}: {
  radius: number;
  /** 0..1, read every frame (default: always full). */
  strength?: () => number;
  /** Height over the ground under its parent. */
  y?: number;
}) {
  const mesh = useRef<THREE.Mesh>(null);
  const material = useMemo(
    () =>
      new THREE.MeshBasicMaterial({
        color: 0x000000,
        alphaMap: blob,
        transparent: true,
        depthWrite: false,
        opacity: 0,
        fog: false,
        toneMapped: false,
      }),
    [],
  );
  useLayoutEffect(() => {
    mesh.current?.layers.set(HOME_LAYER);
    return () => material.dispose();
  }, [material]);
  useFrame(() => {
    const m = mesh.current;
    if (!m) return;
    const o = STRENGTH * homeMode.worldFade * (strength ? strength() : 1);
    material.opacity = o;
    m.visible = o > 0.002;
  });
  return (
    <mesh
      ref={mesh}
      geometry={geometry}
      material={material}
      position-y={y}
      scale={[radius, 1, radius]}
      renderOrder={-1}
      visible={false}
    />
  );
}
