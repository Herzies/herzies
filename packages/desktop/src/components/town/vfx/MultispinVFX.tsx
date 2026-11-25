import { MULTISPIN, multispinOffset, SKILL_DEFS } from "@herzies/shared";
import { useFrame } from "@react-three/fiber";
import { useEffect, useMemo } from "react";
import * as THREE from "three";
import { buffOn, entityAt } from "../combat/skills";
import { groundY, type TownMap } from "../map";

/** Herzies whose records are drawn at once at most, and records each (a
 * Multispin's most). */
const MAX_SPINNERS = 6;
const MAX_RECORDS = 10;
/** How long the records take to fly out at the start, and to fold away
 * at the end. */
const EDGE_MS = 250;
/** How fast each record spins on itself (radians a ms). */
const SPIN_RATE = 0.02;
/** Where round its herzie they circle, as a share of its height: the
 * chest. */
const CHEST = 0.55;

/** A record's face: fine grooves, the run-out near the label, and two
 * faint sheens across it that turn with it, so its spin shows. */
function grooveTexture(): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = c.height = 128;
  const ctx = c.getContext("2d");
  if (ctx) {
    ctx.translate(64, 64);
    ctx.fillStyle = "#0d0d10";
    ctx.beginPath();
    ctx.arc(0, 0, 64, 0, Math.PI * 2);
    ctx.fill();
    for (let r = 24; r < 62; r += 2.2) {
      ctx.strokeStyle = r % 6.6 < 2.2 ? "#22222a" : "#16161b";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(0, 0, r, 0, Math.PI * 2);
      ctx.stroke();
    }
    for (const a of [0, Math.PI]) {
      const g = ctx.createRadialGradient(0, 0, 22, 0, 0, 64);
      g.addColorStop(0, "rgba(160,170,190,0)");
      g.addColorStop(0.5, "rgba(160,170,190,0.28)");
      g.addColorStop(1, "rgba(160,170,190,0)");
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.arc(0, 0, 64, a - 0.22, a + 0.22);
      ctx.closePath();
      ctx.fill();
    }
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** Scratch for the instances' matrices and colours: nothing made each
 * frame. */
const dummy = new THREE.Object3D();
const tint = new THREE.Color();

/**
 * Multispin, for everyone in the room: each herzie under one has its
 * records (black vinyl, a label in a colour of its own) spinning flat
 * round its chest where it's drawn now, each where multispinOffset puts
 * it, as the server judges their touches. They fly out at the start and
 * fold away at the end. Two instanced meshes (the records and their
 * labels); nothing is made while fighting.
 */
export function MultispinVFX({ map }: { map: TownMap }) {
  const fx = useMemo(() => {
    const count = MAX_SPINNERS * MAX_RECORDS;
    const r = MULTISPIN.recordRadius;
    const vinylGeo = new THREE.CylinderGeometry(r, r, 0.02, 36);
    const grooves = grooveTexture();
    const edgeMat = new THREE.MeshStandardMaterial({
      color: 0x0b0b0e,
      roughness: 0.4,
      metalness: 0.2,
    });
    const faceMat = new THREE.MeshStandardMaterial({
      map: grooves,
      roughness: 0.32,
      metalness: 0.25,
    });
    // The cylinder's groups: its side, then its two faces.
    const vinyl = new THREE.InstancedMesh(
      vinylGeo,
      [edgeMat, faceMat, faceMat],
      count,
    );
    const labelGeo = new THREE.CylinderGeometry(r * 0.34, r * 0.34, 0.026, 20);
    const labelMat = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      roughness: 0.6,
      emissive: 0x222222,
    });
    const labels = new THREE.InstancedMesh(labelGeo, labelMat, count);
    for (const m of [vinyl, labels]) {
      m.count = 0;
      m.frustumCulled = false;
      m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    }
    // Every label's colour written once, so instanceColor exists.
    for (let i = 0; i < count; i++) labels.setColorAt(i, tint.set(0xffffff));
    const group = new THREE.Group();
    group.add(vinyl, labels);
    return {
      group,
      vinyl,
      labels,
      vinylGeo,
      labelGeo,
      grooves,
      edgeMat,
      faceMat,
      labelMat,
    };
  }, []);

  useEffect(
    () => () => {
      fx.vinylGeo.dispose();
      fx.labelGeo.dispose();
      fx.grooves.dispose();
      fx.edgeMat.dispose();
      fx.faceMat.dispose();
      fx.labelMat.dispose();
      fx.vinyl.dispose();
      fx.labels.dispose();
    },
    [fx],
  );

  useFrame(() => {
    const now = performance.now();
    const length = SKILL_DEFS.multispin.durationMs ?? 0;
    let n = 0;
    let spinners = 0;
    for (const [id, at] of entityAt) {
      if (spinners >= MAX_SPINNERS) break;
      const spin = buffOn(id, "multispin", now);
      if (!spin) continue;
      spinners++;
      const records = Math.min(MAX_RECORDS, Math.round(spin.value));
      const elapsed = now - (spin.until - length);
      // Flung out, folded away: grown and spread with this.
      const k = Math.max(
        0,
        Math.min(1, elapsed / EDGE_MS, (spin.until - now) / EDGE_MS),
      );
      const ease = 1 - (1 - k) * (1 - k);
      const ground = groundY(map, at.x, at.z);
      const y = ground + Math.max(0.4, at.top - ground) * CHEST;
      // A label colour each herzie keeps (from its id).
      tint.setHSL((((id * 0.618034) % 1) + 1) % 1, 0.75, 0.55);
      // The first record where multispinOffset has it (the server's rule);
      // the rest evenly round from it, turned rather than asked again.
      const first = multispinOffset(0, records, elapsed);
      const spread = 0.35 + 0.65 * ease;
      for (let i = 0; i < records; i++) {
        const turn = (2 * Math.PI * i) / records;
        const c = Math.cos(turn);
        const s = Math.sin(turn);
        dummy.position.set(
          at.x + (first.x * c - first.z * s) * spread,
          y + Math.sin(now / 260 + i) * 0.04,
          at.z + (first.x * s + first.z * c) * spread,
        );
        dummy.rotation.set(
          0.1 * Math.sin(now / 300 + i * 1.3),
          now * SPIN_RATE + i,
          0.1 * Math.cos(now / 340 + i),
        );
        dummy.scale.setScalar(Math.max(0.001, ease));
        dummy.updateMatrix();
        fx.vinyl.setMatrixAt(n, dummy.matrix);
        fx.labels.setMatrixAt(n, dummy.matrix);
        fx.labels.setColorAt(n, tint);
        n++;
      }
    }
    fx.vinyl.count = n;
    fx.labels.count = n;
    if (n > 0) {
      fx.vinyl.instanceMatrix.needsUpdate = true;
      fx.labels.instanceMatrix.needsUpdate = true;
      if (fx.labels.instanceColor) fx.labels.instanceColor.needsUpdate = true;
    }
  });

  return <primitive object={fx.group} />;
}
