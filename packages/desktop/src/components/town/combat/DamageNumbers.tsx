import { useFrame, useThree } from "@react-three/fiber";
import { useLayoutEffect, useMemo } from "react";
import * as THREE from "three";
import { useTownRuntime } from "../runtime";
import { liveDummies } from "./Dummies";
import { DUMMY, meterDps, meterIdle } from "./dummy";
import { combat } from "./state";
import type { Vec3 } from "./waves";

/**
 * What a fight shows over the world, as plain DOM laid over the canvas
 * (crisp text at any resolution, where the Town itself is pixelated):
 *
 * - Damage numbers popping off each hit: up and to one side, overshooting
 *   as they appear, fading as they go; a crit's gold. What you take pops
 *   off your own herzie, in red.
 * - A meter over each dummy you're hitting: damage per second, total,
 *   hits and crits, clearing once you stop.
 * - The crosshair in combat mode: it opens on each cast and closes again,
 *   lights up over a dummy, and flashes a hit marker on a hit. Up close
 *   (melee), a gold ring snaps round it while a blow would land.
 *
 * All pooled, and moved with transforms each frame: no React renders.
 */

type Floater = {
  el: HTMLDivElement;
  alive: boolean;
  pos: Vec3;
  age: number;
  /** Sideways drift (screen px over its life) and how high it rises. */
  drift: number;
  rise: number;
  crit: boolean;
};

const FLOATERS = 32;
const FLOAT_SECONDS = 0.95;

/** `at` null: over your own herzie (damage you took). */
const queue: { at: Vec3 | null; amount: number; crit: boolean }[] = [];

/** A damage number, popping off `at`. */
export function pushDamageNumber(
  at: Readonly<Vec3>,
  amount: number,
  crit: boolean,
): void {
  if (queue.length < 16)
    queue.push({ at: [at[0], at[1], at[2]], amount, crit });
}

/** Damage you took, popping off your herzie's head. */
export function pushHurtNumber(amount: number): void {
  if (amount > 0 && queue.length < 16)
    queue.push({ at: null, amount, crit: false });
}

const STYLE = `
.town-fx { position: absolute; inset: 0; pointer-events: none; overflow: hidden; z-index: 15; font-family: ui-monospace, monospace; }
.town-fx .dmg { position: absolute; left: 0; top: 0; will-change: transform, opacity; white-space: nowrap;
  font-weight: 800; font-size: 15px; color: #e9fbff; letter-spacing: -0.5px;
  text-shadow: 0 0 6px rgba(80, 200, 255, 0.55), 0 2px 0 #0b2233, 1px 0 0 #0b2233, -1px 0 0 #0b2233, 0 -1px 0 #0b2233; }
.town-fx .dmg.crit { color: #ffe08a;
  text-shadow: 0 0 10px rgba(255, 190, 60, 0.75), 0 2px 0 #3a2200, 1px 0 0 #3a2200, -1px 0 0 #3a2200, 0 -1px 0 #3a2200; }
.town-fx .dmg.crit::after { content: "!"; margin-left: 1px; }
.town-fx .dmg.hurt { color: #ff6b6b;
  text-shadow: 0 0 8px rgba(255, 60, 60, 0.6), 0 2px 0 #3a0808, 1px 0 0 #3a0808, -1px 0 0 #3a0808, 0 -1px 0 #3a0808; }
.town-fx .meter { position: absolute; left: 0; top: 0; will-change: transform, opacity; transition: opacity 0.25s;
  background: rgba(6, 10, 20, 0.72); border: 1px solid rgba(159, 232, 255, 0.35); border-radius: 4px;
  padding: 3px 6px; color: #cfe9f5; font-size: 10px; line-height: 1.25; white-space: nowrap; }
.town-fx .meter b { color: #fff; font-size: 13px; }
.town-fx .meter .dim { color: #7f97a6; }
.town-fx .cross { position: absolute; left: 50%; top: 50%; width: 0; height: 0; opacity: 0; transition: opacity 0.15s; }
.town-fx .cross.on { opacity: 1; }
.town-fx .cross i { position: absolute; background: #fff; box-shadow: 0 0 0 1px rgba(0,0,0,0.6); transition: background 0.1s; }
.town-fx .cross.target i { background: #9fe8ff; }
.town-fx .cross.reach i { background: #ffd36b; }
.town-fx .cross i.ring { position: absolute; width: 22px; height: 22px; left: -11px; top: -11px; border-radius: 50%;
  border: 2px solid #ffd36b; box-shadow: 0 0 0 1px rgba(0,0,0,0.5), inset 0 0 0 1px rgba(0,0,0,0.35), 0 0 8px rgba(255, 190, 60, 0.6);
  background: none; opacity: 0; transform: scale(1.6); transition: opacity 0.12s, transform 0.16s cubic-bezier(0.2, 1.6, 0.4, 1); }
.town-fx .cross.reach i.ring { opacity: 1; transform: scale(1); }
.town-fx .cross .dot { width: 2px; height: 2px; left: -1px; top: -1px; }
.town-fx .cross .t { width: 2px; height: 7px; left: -1px; }
.town-fx .cross .l { width: 7px; height: 2px; top: -1px; }
.town-fx .discs { position: absolute; left: 50%; top: 50%; width: 0; height: 0; opacity: 0; transition: opacity 0.15s; }
.town-fx .discs.on { opacity: 1; }
.town-fx .discs b { position: absolute; top: 20px; width: 6px; height: 6px; margin: -3px; border-radius: 50%;
  border: 1px solid #fff; box-shadow: 0 0 0 1px rgba(0,0,0,0.55); background: #fff; transition: background 0.08s; }
.town-fx .discs b.out { background: transparent; }
.town-fx .hit { position: absolute; left: 50%; top: 50%; width: 0; height: 0; opacity: 0; }
.town-fx .hit i { position: absolute; width: 10px; height: 2px; left: -5px; top: -1px; background: #fff; box-shadow: 0 0 0 1px rgba(0,0,0,0.5); }
.town-fx .hit.crit i { background: #ffd36b; }
`;

/** The overlay. Mount once inside the Town's canvas. */
export function CombatOverlay() {
  const gl = useThree((s) => s.gl);
  const camera = useThree((s) => s.camera);
  const rt = useTownRuntime();
  const ui = useMemo(() => {
    const root = document.createElement("div");
    root.className = "town-fx";
    const style = document.createElement("style");
    style.textContent = STYLE;
    root.append(style);

    const floaters: Floater[] = Array.from({ length: FLOATERS }, () => {
      const el = document.createElement("div");
      el.className = "dmg";
      el.style.opacity = "0";
      root.append(el);
      return {
        el,
        alive: false,
        pos: [0, 0, 0],
        age: 0,
        drift: 0,
        rise: 0,
        crit: false,
      };
    });

    const cross = document.createElement("div");
    cross.className = "cross";
    const arms = ["t", "t", "l", "l"].map((k) => {
      const i = document.createElement("i");
      i.className = k;
      cross.append(i);
      return i;
    });
    const dot = document.createElement("i");
    dot.className = "dot";
    cross.append(dot);
    const ring = document.createElement("i");
    ring.className = "ring";
    cross.append(ring);
    root.append(cross);

    // A Record Slinger's discs, under the crosshair: filled while in hand,
    // hollow while flying — the right one's the main hand's.
    const discs = document.createElement("div");
    discs.className = "discs";
    const pips = {
      "held-r": document.createElement("b"),
      "held-l": document.createElement("b"),
    };
    pips["held-r"].style.left = "-6px";
    pips["held-l"].style.left = "6px";
    discs.append(pips["held-r"], pips["held-l"]);
    root.append(discs);

    const hit = document.createElement("div");
    hit.className = "hit";
    const ticks = [45, 135, 225, 315].map((deg) => {
      const i = document.createElement("i");
      hit.append(i);
      return { i, deg };
    });
    root.append(hit);

    const meters = new Map<string, HTMLDivElement>();
    return { root, floaters, cross, arms, discs, pips, hit, ticks, meters };
  }, []);

  useLayoutEffect(() => {
    const parent = gl.domElement.parentElement;
    parent?.append(ui.root);
    return () => {
      ui.root.remove();
      queue.length = 0;
    };
  }, [gl, ui]);

  const v = useMemo(() => new THREE.Vector3(), []);
  const head = useMemo(() => new THREE.Vector3(), []);
  /** Where a world point lands on the overlay, in CSS px (null: behind). */
  const project = (x: number, y: number, z: number) => {
    v.set(x, y, z).project(camera);
    if (v.z > 1) return null;
    const w = ui.root.clientWidth;
    const h = ui.root.clientHeight;
    return [(v.x * 0.5 + 0.5) * w, (-v.y * 0.5 + 0.5) * h] as const;
  };
  const lastMeter = useMemo(() => ({ at: 0 }), []);

  useFrame((_, dt) => {
    const now = performance.now();

    // New numbers, stacked off one another when they come close together.
    while (queue.length) {
      const n = queue.shift() as (typeof queue)[number];
      let at = n.at;
      if (!at) {
        const body = rt.playerBody;
        if (!body) continue;
        body.getWorldPosition(head);
        at = [head.x, head.y + (rt.playerHerzie?.height ?? 1.2), head.z];
      }
      let f = ui.floaters[0];
      for (const x of ui.floaters) {
        if (!x.alive) {
          f = x;
          break;
        }
        if (x.age > f.age) f = x;
      }
      const busy = ui.floaters.filter((x) => x.alive && x.age < 0.3).length;
      f.alive = true;
      f.age = 0;
      f.pos = [at[0], at[1] + 0.25 + busy * 0.18, at[2]];
      f.drift = (Math.random() * 2 - 1) * 26;
      f.rise = 38 + Math.random() * 14 + (n.crit ? 12 : 0);
      f.crit = n.crit;
      const hurt = !n.at;
      f.el.textContent = `${hurt ? "-" : ""}${Math.round(n.amount).toLocaleString()}`;
      f.el.className = hurt ? "dmg hurt" : n.crit ? "dmg crit" : "dmg";
    }

    for (const f of ui.floaters) {
      if (!f.alive) continue;
      f.age += dt;
      const t = f.age / FLOAT_SECONDS;
      const p = t < 1 ? project(...f.pos) : null;
      if (!p) {
        f.alive = false;
        f.el.style.opacity = "0";
        continue;
      }
      // Pop: overshoot and settle in the first tenth of a second.
      const pop =
        f.age < 0.1
          ? 1.7 - 0.7 * (f.age / 0.1)
          : f.age < 0.18
            ? 1 - 0.08 * Math.sin(((f.age - 0.1) / 0.08) * Math.PI)
            : 1;
      const ease = 1 - (1 - t) ** 2;
      const x = p[0] + f.drift * ease;
      const y = p[1] - f.rise * ease;
      f.el.style.transform = `translate(${x}px, ${y}px) translate(-50%, -50%) scale(${pop})`;
      f.el.style.opacity = String(t < 0.65 ? 1 : 1 - (t - 0.65) / 0.35);
    }

    // The crosshair.
    const on = combat.on;
    ui.cross.classList.toggle("on", on);
    const throwing = on && combat.attack === "disc";
    ui.discs.classList.toggle("on", throwing);
    if (throwing) {
      for (const h of ["held-l", "held-r"] as const) {
        const pip = ui.pips[h];
        pip.classList.toggle("out", !combat.discs.in[h]);
        // A pop as it's caught.
        const since = (now - combat.discs.caughtAt[h]) / 1000;
        const pop = since < 0.18 ? 1 + 0.8 * (1 - since / 0.18) ** 2 : 1;
        pip.style.transform = `scale(${pop})`;
      }
    }
    if (on) {
      ui.cross.classList.toggle("target", combat.onTarget);
      ui.cross.classList.toggle("reach", combat.inReach);
      const gap = 5 + combat.spread * 7;
      const [top, bottom, left, right] = ui.arms;
      top.style.top = `${-gap - 7}px`;
      bottom.style.top = `${gap}px`;
      left.style.left = `${-gap - 7}px`;
      right.style.left = `${gap}px`;
      const since = (now - combat.hitAt) / 1000;
      const show = since < 0.22;
      ui.hit.style.opacity = show ? String(1 - since / 0.22) : "0";
      if (show) {
        ui.hit.classList.toggle("crit", combat.hitCrit);
        const r = 8 + since * 22 + (combat.hitCrit ? 3 : 0);
        for (const { i, deg } of ui.ticks) {
          const rad = (deg * Math.PI) / 180;
          i.style.transform = `translate(${Math.cos(rad) * r}px, ${Math.sin(rad) * r}px) rotate(${deg}deg)`;
        }
      }
    } else {
      ui.hit.style.opacity = "0";
    }

    // Meters over the dummies: the numbers a few times a second, the
    // position every frame.
    const refresh = now - lastMeter.at > 120;
    if (refresh) lastMeter.at = now;
    const seen = new Set<string>();
    for (const d of liveDummies) {
      seen.add(d.key);
      let el = ui.meters.get(d.key);
      const idle = meterIdle(d.meter, now);
      if (!el) {
        if (idle) continue;
        el = document.createElement("div");
        el.className = "meter";
        el.style.opacity = "0";
        ui.root.append(el);
        ui.meters.set(d.key, el);
      }
      const p = project(d.x, (d.y ?? 0) + DUMMY.top + 0.9, d.z);
      if (!p || idle) {
        el.style.opacity = "0";
        continue;
      }
      el.style.opacity = "1";
      el.style.transform = `translate(${p[0]}px, ${p[1]}px) translate(-50%, -100%)`;
      if (refresh) {
        const m = d.meter;
        const crit = m.hits ? Math.round((m.crits / m.hits) * 100) : 0;
        el.innerHTML = `<b>${Math.round(meterDps(m, now)).toLocaleString()}</b> <span class="dim">DPS</span><br>${Math.round(m.total).toLocaleString()} <span class="dim">total · ${m.hits} hits${m.crits ? ` · ${crit}% crit` : ""}</span>`;
      }
    }
    for (const [key, el] of ui.meters) {
      if (!seen.has(key)) {
        el.remove();
        ui.meters.delete(key);
      }
    }
  });

  return null;
}
