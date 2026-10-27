import { useFrame } from "@react-three/fiber";
import { useEffect, useMemo } from "react";
import * as THREE from "three";
import { entityAt } from "../combat/skills";
import { stance } from "../combat/stance";

const GREEN = new THREE.Color(0x7ee2a8);

/**
 * A Bard's heal lock: a green ring under the ally the next heal bolt goes
 * to, with four ticks closing in on it, so it's plain who'll be healed
 * before the click. Moves with them; gone when nobody's locked.
 */
export function HealVFX() {
  const fx = useMemo(() => {
    const group = new THREE.Group();
    const mat = new THREE.MeshBasicMaterial({
      color: GREEN,
      transparent: true,
      opacity: 0.9,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      fog: false,
    });
    const ringGeo = new THREE.RingGeometry(0.78, 0.9, 48);
    ringGeo.rotateX(-Math.PI / 2);
    const ring = new THREE.Mesh(ringGeo, mat);
    ring.renderOrder = 6;
    group.add(ring);
    const tickGeo = new THREE.PlaneGeometry(0.1, 0.32);
    tickGeo.rotateX(-Math.PI / 2);
    const ticks = Array.from({ length: 4 }, () => {
      const m = new THREE.Mesh(tickGeo, mat);
      m.renderOrder = 6;
      group.add(m);
      return m;
    });
    group.visible = false;
    return { group, ring, ticks, mat, ringGeo, tickGeo };
  }, []);

  useEffect(
    () => () => {
      fx.mat.dispose();
      fx.ringGeo.dispose();
      fx.tickGeo.dispose();
    },
    [fx],
  );

  /** When the lock last changed, for the ticks' close-in. */
  const locked = useMemo(() => ({ id: null as number | null, at: 0 }), []);

  useFrame(() => {
    const now = performance.now();
    const id = stance.lock;
    if (id !== locked.id) {
      locked.id = id;
      locked.at = now;
    }
    const at = id === null ? undefined : entityAt.get(id);
    fx.group.visible = !!at;
    if (!at) return;
    fx.group.position.set(at.x, 0.08, at.z);
    const t = Math.min(1, (now - locked.at) / 160);
    const pulse = 1 + 0.05 * Math.sin(now / 120);
    fx.ring.scale.setScalar(pulse);
    // The ticks start wide and snap in on a new lock.
    const r = 1.25 + 0.6 * (1 - t) ** 2;
    fx.ticks.forEach((m, i) => {
      const a = (i / 4) * Math.PI * 2 + now / 900;
      m.position.set(Math.sin(a) * r, 0, Math.cos(a) * r);
      m.rotation.y = a;
    });
  });

  return <primitive object={fx.group} />;
}
