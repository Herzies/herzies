import { BACKSPIN_DISCS, BACKSPIN_SPREAD, SKILL_DEFS } from "@herzies/shared";
import { useFrame } from "@react-three/fiber";
import { useEffect, useMemo } from "react";
import * as THREE from "three";
import { buffOn, entityAt, SKILL_FX_MS, skills } from "../combat/skills";

/** Rings a Soothing Drones sends out, one after another. */
const DRONE_RINGS = 3;
const DRONE_RING_GAP_MS = 220;
const DISC_SPEED = 22;
/** Cymbals drawn at once at most (one per buffed herzie). */
const MAX_CYMBALS = 8;
/** In-tune auras, and the notes over each. */
const MAX_AURAS = 12;
const NOTES = 3;
/** The aura's pulse: about a beat at 120 bpm. */
const BEAT_MS = 500;
/** Resurrect beams at once. */
const MAX_BEAMS = 4;
/** How far a Taunt's shout spreads. */
const TAUNT_REACH = 6;

const PINK = new THREE.Color(0xff7eb6);
const RED = new THREE.Color(0xff3b30);
const GOLD = new THREE.Color(0xffd84a);

/** A note glyph, drawn once, for the in-tune sprites. */
function noteTexture(): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = c.height = 64;
  const ctx = c.getContext("2d");
  if (ctx) {
    ctx.font = "bold 52px system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.shadowColor = "rgba(0,0,0,0.6)";
    ctx.shadowBlur = 6;
    ctx.fillStyle = "#ffe27a";
    ctx.fillText("♪", 32, 34);
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/**
 * Class skills as they happen, for everyone in the room: Soothing Drones
 * pulses out over the ground as far as it reaches, Backspin's discs spin
 * away along the aim, a giant cymbal hangs over whoever is under a
 * Cymbrella, a Taunt's shout spreads red from its caster, a Resurrect is a
 * gold beam from its Bard to the fallen while it plays, and whoever is in
 * tune with what the boss hates glows gold on the beat with notes rising
 * over them. Pooled meshes, moved each frame; nothing is created while
 * fighting.
 */
export function SkillVFX() {
  const fx = useMemo(() => {
    const group = new THREE.Group();

    const ringGeo = new THREE.RingGeometry(0.92, 1, 48);
    ringGeo.rotateX(-Math.PI / 2);
    const rings = Array.from({ length: 12 }, () => {
      const m = new THREE.Mesh(
        ringGeo,
        new THREE.MeshBasicMaterial({
          color: 0xff7eb6,
          transparent: true,
          depthWrite: false,
          fog: false,
        }),
      );
      m.visible = false;
      m.renderOrder = 6;
      group.add(m);
      return m;
    });

    const discGeo = new THREE.CylinderGeometry(0.28, 0.28, 0.04, 20);
    const discMat = new THREE.MeshStandardMaterial({
      color: 0xd9d9e8,
      metalness: 0.8,
      roughness: 0.25,
    });
    const discs = Array.from({ length: 12 }, () => {
      const m = new THREE.Mesh(discGeo, discMat);
      m.visible = false;
      group.add(m);
      return m;
    });

    const cymbalGeo = new THREE.CylinderGeometry(1.1, 1.1, 0.05, 32);
    const cymbalMat = new THREE.MeshStandardMaterial({
      color: 0xe8c860,
      metalness: 0.9,
      roughness: 0.3,
      emissive: 0x5a4410,
    });
    const cymbals = Array.from({ length: MAX_CYMBALS }, () => {
      const m = new THREE.Mesh(cymbalGeo, cymbalMat);
      m.visible = false;
      m.castShadow = true;
      group.add(m);
      return m;
    });

    const auraGeo = new THREE.CircleGeometry(0.95, 40);
    auraGeo.rotateX(-Math.PI / 2);
    const auras = Array.from({ length: MAX_AURAS }, () => {
      const m = new THREE.Mesh(
        auraGeo,
        new THREE.MeshBasicMaterial({
          color: GOLD,
          transparent: true,
          depthWrite: false,
          blending: THREE.AdditiveBlending,
          fog: false,
        }),
      );
      m.visible = false;
      m.renderOrder = 5;
      group.add(m);
      return m;
    });
    const noteTex = noteTexture();
    const noteMat = new THREE.SpriteMaterial({
      map: noteTex,
      transparent: true,
      depthWrite: false,
      fog: false,
    });
    const notes = Array.from({ length: MAX_AURAS * NOTES }, () => {
      const m = new THREE.Sprite(noteMat.clone());
      m.scale.setScalar(0.42);
      m.visible = false;
      m.renderOrder = 7;
      group.add(m);
      return m;
    });

    const beamGeo = new THREE.CylinderGeometry(0.07, 0.07, 1, 8, 1, true);
    beamGeo.rotateX(Math.PI / 2);
    const beamMat = new THREE.MeshBasicMaterial({
      color: GOLD,
      transparent: true,
      opacity: 0.75,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      fog: false,
    });
    const beams = Array.from({ length: MAX_BEAMS }, () => {
      const m = new THREE.Mesh(beamGeo, beamMat);
      m.visible = false;
      group.add(m);
      return m;
    });

    return {
      group,
      rings,
      discs,
      cymbals,
      auras,
      notes,
      beams,
      ringGeo,
      discGeo,
      cymbalGeo,
      auraGeo,
      beamGeo,
      discMat,
      cymbalMat,
      noteTex,
      noteMat,
      beamMat,
    };
  }, []);

  useEffect(
    () => () => {
      fx.ringGeo.dispose();
      fx.discGeo.dispose();
      fx.cymbalGeo.dispose();
      fx.discMat.dispose();
      fx.cymbalMat.dispose();
      fx.auraGeo.dispose();
      fx.beamGeo.dispose();
      fx.noteTex.dispose();
      fx.noteMat.dispose();
      fx.beamMat.dispose();
      for (const r of fx.rings) (r.material as THREE.Material).dispose();
      for (const a of fx.auras) (a.material as THREE.Material).dispose();
      for (const n of fx.notes) (n.material as THREE.Material).dispose();
    },
    [fx],
  );

  useFrame(() => {
    const now = performance.now();
    // Forget effects that have played out.
    skills.casts = skills.casts.filter((c) => now - c.at < SKILL_FX_MS);

    let ring = 0;
    let disc = 0;
    for (const c of skills.casts) {
      const age = now - c.at;
      if (c.skill === "soothing-drones") {
        const reach = SKILL_DEFS["soothing-drones"].radius ?? 8;
        for (let i = 0; i < DRONE_RINGS && ring < fx.rings.length; i++) {
          const t = (age - i * DRONE_RING_GAP_MS) / (SKILL_FX_MS * 0.6);
          if (t < 0 || t > 1) continue;
          const m = fx.rings[ring++];
          m.visible = true;
          m.position.set(c.x, 0.08 + i * 0.01, c.z);
          m.scale.setScalar(Math.max(0.05, reach * t));
          const mat = m.material as THREE.MeshBasicMaterial;
          mat.color.copy(PINK);
          mat.opacity = 0.85 * (1 - t);
        }
      } else if (c.skill === "taunt" || c.skill === "resurrect") {
        // A Taunt's shout: one fast red ring. A Resurrect's first note: a
        // small gold one at the Bard's feet.
        const t = age / (SKILL_FX_MS * (c.skill === "taunt" ? 0.45 : 0.7));
        if (t >= 0 && t <= 1 && ring < fx.rings.length) {
          const m = fx.rings[ring++];
          m.visible = true;
          m.position.set(c.x, 0.09, c.z);
          m.scale.setScalar(
            Math.max(0.05, (c.skill === "taunt" ? TAUNT_REACH : 2) * t),
          );
          const mat = m.material as THREE.MeshBasicMaterial;
          mat.color.copy(c.skill === "taunt" ? RED : GOLD);
          mat.opacity = 0.9 * (1 - t);
        }
      } else if (c.skill === "backspin") {
        const half = (BACKSPIN_DISCS - 1) / 2;
        const travelled = (age / 1000) * DISC_SPEED;
        for (let i = 0; i < BACKSPIN_DISCS && disc < fx.discs.length; i++) {
          const yaw = c.yaw + (i - half) * BACKSPIN_SPREAD;
          const m = fx.discs[disc++];
          m.visible = travelled < 30;
          m.position.set(
            c.x + Math.sin(yaw) * (0.6 + travelled),
            1.2,
            c.z + Math.cos(yaw) * (0.6 + travelled),
          );
          // Spinning flat, tipped a little toward the throw.
          m.rotation.set(0.25, age * 0.04, 0);
        }
      }
    }
    for (; ring < fx.rings.length; ring++) fx.rings[ring].visible = false;
    for (; disc < fx.discs.length; disc++) fx.discs[disc].visible = false;

    // A cymbal over everyone under a Cymbrella, for as long as it lasts
    // (yours from the moment you press it; see Combat).
    let cym = 0;
    for (const [id, at] of entityAt) {
      if (cym >= fx.cymbals.length) break;
      if (!buffOn(id, "cymbrella", now)) continue;
      const m = fx.cymbals[cym++];
      m.visible = true;
      m.position.set(at.x, at.top + 0.9 + Math.sin(now / 300) * 0.05, at.z);
      m.rotation.set(Math.sin(now / 500) * 0.06, now / 900, 0);
    }
    for (; cym < fx.cymbals.length; cym++) fx.cymbals[cym].visible = false;

    // In tune: a gold glow underfoot on the beat, and notes rising.
    let aura = 0;
    const beat =
      0.5 + 0.5 * Math.cos(((now % BEAT_MS) / BEAT_MS) * Math.PI * 2);
    for (const [id, at] of entityAt) {
      if (aura >= fx.auras.length) break;
      if (!buffOn(id, "in_tune", now)) continue;
      const i = aura++;
      const m = fx.auras[i];
      m.visible = true;
      m.position.set(at.x, 0.07, at.z);
      m.scale.setScalar(0.9 + 0.25 * beat);
      (m.material as THREE.MeshBasicMaterial).opacity = 0.18 + 0.22 * beat;
      for (let n = 0; n < NOTES; n++) {
        const note = fx.notes[i * NOTES + n];
        const u = (((now / 1600 + n / NOTES + id * 0.37) % 1) + 1) % 1;
        const a = id * 1.7 + n * 2.1 + u * 1.5;
        note.visible = true;
        note.position.set(
          at.x + Math.sin(a) * 0.55,
          at.top * 0.6 + u * 1.4,
          at.z + Math.cos(a) * 0.55,
        );
        (note.material as THREE.SpriteMaterial).opacity = Math.sin(u * Math.PI);
      }
    }
    for (let i = aura; i < fx.auras.length; i++) {
      fx.auras[i].visible = false;
      for (let n = 0; n < NOTES; n++) fx.notes[i * NOTES + n].visible = false;
    }

    // A Resurrect being played: a beam from the Bard to the fallen, pulsing
    // brighter as it nears the end.
    let beam = 0;
    for (const [by, ch] of skills.channels) {
      if (beam >= fx.beams.length) break;
      const from = entityAt.get(by);
      const to = entityAt.get(ch.target);
      if (!from || !to || now > ch.until) continue;
      const m = fx.beams[beam++];
      const ax = from.x;
      const ay = from.top * 0.7;
      const az = from.z;
      const bx = to.x;
      const by_ = 0.5;
      const bz = to.z;
      const len = Math.hypot(bx - ax, by_ - ay, bz - az);
      m.visible = len > 0.05;
      m.position.set((ax + bx) / 2, (ay + by_) / 2, (az + bz) / 2);
      m.lookAt(bx, by_, bz);
      m.scale.set(1, 1, len);
    }
    const k = (() => {
      let best = 0;
      for (const ch of skills.channels.values())
        best = Math.max(
          best,
          (now - ch.from) / Math.max(1, ch.until - ch.from),
        );
      return Math.min(1, best);
    })();
    fx.beamMat.opacity = 0.35 + 0.5 * k * (0.75 + 0.25 * Math.sin(now / 60));
    for (; beam < fx.beams.length; beam++) fx.beams[beam].visible = false;
  });

  return <primitive object={fx.group} />;
}
