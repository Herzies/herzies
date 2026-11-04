import { BOSS_STAND } from "@herzies/shared/combat";
import { MOB } from "@herzies/shared/tower";
import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useMemo } from "react";
import * as THREE from "three";
import { liveDummies } from "../combat/Dummies";
import { DUMMY } from "../combat/dummy";
import { bossFight, bossNow } from "../combat/fight";
import { stuns } from "../combat/stuns";

/** Stunned things drawn at once at most, and the stars round each. */
const MAX = 12;
const STARS = 3;
/** How long the stars take to spin in and out at a stun's ends (ms). */
const EDGE_MS = 140;

/** A five-pointed star, drawn once: gold with a hot middle and a dark
 * edge, so it reads on snow and on grass. */
function starTexture(): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = c.height = 64;
  const ctx = c.getContext("2d");
  if (ctx) {
    ctx.translate(32, 33);
    ctx.beginPath();
    for (let i = 0; i < 10; i++) {
      const r = i % 2 ? 11 : 26;
      const a = (i / 10) * Math.PI * 2 - Math.PI / 2;
      ctx.lineTo(Math.cos(a) * r, Math.sin(a) * r);
    }
    ctx.closePath();
    ctx.lineJoin = "round";
    ctx.lineWidth = 6;
    ctx.strokeStyle = "rgba(58, 34, 0, 0.9)";
    ctx.stroke();
    const g = ctx.createRadialGradient(0, 0, 2, 0, 0, 26);
    g.addColorStop(0, "#fffbe6");
    g.addColorStop(0.45, "#ffe27a");
    g.addColorStop(1, "#ffb52e");
    ctx.fillStyle = g;
    ctx.fill();
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** Something stunned: where its head is, how wide it is, and its stun. */
type Stunned = {
  x: number;
  y: number;
  z: number;
  size: number;
  from: number;
  until: number;
  seed: number;
};

/**
 * Stars circling the head of whatever's stunned, for as long as the stun
 * lasts: a Tower mob, one of the boss's minions, the boss (bigger, wider),
 * a practice dummy. Everyone in the room sees them (the server says who's
 * stunned with the mobs' and the boss's word). Pooled sprites.
 */
export function StunVFX() {
  const scene = useThree((s) => s.scene);
  const fx = useMemo(() => {
    const tex = starTexture();
    const mat = new THREE.SpriteMaterial({
      map: tex,
      transparent: true,
      depthWrite: false,
      fog: false,
    });
    const stars = Array.from({ length: MAX * STARS }, () => {
      const s = new THREE.Sprite(mat);
      s.visible = false;
      s.renderOrder = 9;
      return s;
    });
    const group = new THREE.Group();
    for (const s of stars) group.add(s);
    return { tex, mat, stars, group };
  }, []);

  useEffect(() => {
    scene.add(fx.group);
    return () => {
      scene.remove(fx.group);
      fx.mat.dispose();
      fx.tex.dispose();
    };
  }, [scene, fx]);

  const found = useMemo<Stunned[]>(() => [], []);
  /** When each stun was first seen, for the spin-in. */
  const seen = useMemo(() => new Map<string, number>(), []);

  useFrame(() => {
    const now = performance.now();
    found.length = 0;
    for (const d of liveDummies) {
      const until =
        d.mob !== undefined ? stuns.mobs.get(d.mob) : stuns.dummies.get(d.key);
      if (until === undefined || until + EDGE_MS <= now) continue;
      const size = d.size ?? 1;
      const top = d.mob !== undefined ? MOB.top * size : DUMMY.top;
      const key = `${d.key}:${until}`;
      const from = seen.get(key) ?? now;
      seen.set(key, from);
      found.push({
        x: d.x,
        y: (d.y ?? 0) + top + 0.32,
        z: d.z,
        size,
        from,
        until,
        seed: d.key.length * 1.7,
      });
    }
    if (bossFight.on && !bossFight.tower && stuns.boss + EDGE_MS > now) {
      const b = bossNow();
      const key = `boss:${stuns.boss}`;
      const from = seen.get(key) ?? now;
      seen.set(key, from);
      found.push({
        x: b.x,
        y: BOSS_STAND.top + 0.5,
        z: b.z,
        size: 2.4,
        from,
        until: stuns.boss,
        seed: 3.1,
      });
    }
    if (seen.size > 64) seen.clear();

    let n = 0;
    for (const s of found) {
      if (n + STARS > fx.stars.length) break;
      // Spun in at the start, out at the end.
      const inK = Math.min(1, (now - s.from) / EDGE_MS);
      const outK = Math.min(1, Math.max(0, (s.until - now) / EDGE_MS));
      const k = Math.min(inK, outK);
      const radius = 0.42 * s.size * (0.6 + 0.4 * k);
      for (let i = 0; i < STARS; i++) {
        const star = fx.stars[n++];
        const a = now / 230 + (i / STARS) * Math.PI * 2 + s.seed;
        star.visible = k > 0;
        star.position.set(
          s.x + Math.sin(a) * radius,
          s.y + Math.sin(a * 2 + i) * 0.06 * s.size,
          s.z + Math.cos(a) * radius,
        );
        star.scale.setScalar(0.4 * Math.sqrt(s.size) * k);
      }
    }
    for (; n < fx.stars.length; n++) fx.stars[n].visible = false;
    // One material: they all twinkle round together.
    fx.mat.rotation = now / 260;
  });

  return null;
}
