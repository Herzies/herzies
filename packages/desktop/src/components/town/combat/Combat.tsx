import { type HerzieStats, hitDamage } from "@herzies/shared";
import { useFrame, useThree } from "@react-three/fiber";
import { useRapier } from "@react-three/rapier";
import { useEffect, useRef } from "react";
import * as THREE from "three";
import type { TownMap } from "../map";
import { useTownRuntime } from "../runtime";
import { sfxCast, sfxCharge, sfxImpact } from "../sfx";
import { pushDamageNumber } from "./DamageNumbers";
import { liveDummies } from "./Dummies";
import { DUMMY, hitDummy, meterDps } from "./dummy";
import { enterMouseLook, exitMouseLook } from "./mouseLook";
import { CAST_BUFFER_MS, combat, setCombat, shake } from "./state";
import { assistTarget, type Vec3, WAVE, waveField } from "./waves";

/** How soon after one cast the next may start, in seconds: the hand is
 * on its way home by then, so a held button rolls into the next. */
const CAST_INTERVAL = 0.34;
/** How far the aim looks for something to land on. */
const AIM_RANGE = 60;
/** How slow waves and dummies go during a crit's hit-stop. */
const HIT_STOP_SCALE = 0.12;
const HIT_STOP_MS = 65;

const typing = (t: EventTarget | null) => {
  const el = t as HTMLElement | null;
  return (
    !!el &&
    (el.tagName === "INPUT" ||
      el.tagName === "TEXTAREA" ||
      el.tagName === "SELECT" ||
      el.isContentEditable)
  );
};

/**
 * Fighting on the testing ground: combat mode's controls, your aim, your
 * casts, and every wave in flight — where it lands and what that does.
 *
 * - Tab: into combat mode (the mouse aims, the camera comes in over the
 *   shoulder); Esc, or Tab again: out.
 * - Left click or F: cast. Holding it keeps casting; a press mid-cast is
 *   kept for the next.
 *
 * Aiming is the usual third-person way: a ray from the camera through the
 * crosshair finds what you're pointing at, and the wave flies from the
 * herzie's hand to that point — so it lands where the crosshair is, though
 * the hand is off to one side. A dummy just off the line of aim draws it
 * in a little (aim assist).
 */
export function Combat({
  map,
  stats,
  active,
}: {
  map: TownMap;
  stats: HerzieStats;
  /** The Town is on screen and taking input. */
  active: boolean;
}) {
  const rt = useTownRuntime();
  const { world, rapier } = useRapier();
  const camera = useThree((s) => s.camera);
  const surface = useThree((s) => s.gl.domElement);
  const statsRef = useRef(stats);
  statsRef.current = stats;
  const canFight = !!map.combat && active;

  // Combat mode's keys and buttons.
  useEffect(() => {
    if (!canFight) {
      leave();
      return;
    }
    const enter = async () => {
      setCombat(true, null);
      const mode = await enterMouseLook(
        surface,
        (dx, dy) => {
          combat.lookX += dx;
          combat.lookY += dy;
        },
        () => setCombat(false),
      );
      // Left again while the mouse was being taken.
      if (!combat.on) exitMouseLook();
      else setCombat(true, mode);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || typing(e.target)) return;
      if (e.code === "Tab") {
        // Not the browser's: it would move focus to the chat.
        e.preventDefault();
        if (e.repeat) return;
        if (combat.on) leave();
        else void enter();
      } else if (e.code === "Escape" && combat.on) {
        leave();
      } else if (e.code === "KeyF" && combat.on) {
        e.preventDefault();
        if (!e.repeat) combat.queuedAt = performance.now();
        combat.fireHeld = true;
      }
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.code === "KeyF") combat.fireHeld = false;
    };
    const onPointerDown = (e: PointerEvent) => {
      if (!combat.on || e.button !== 0) return;
      combat.queuedAt = performance.now();
      combat.fireHeld = true;
    };
    const onPointerUp = (e: PointerEvent) => {
      if (e.button === 0) combat.fireHeld = false;
    };
    // Typing in the chat, or the app going to the background, ends it.
    const onFocusIn = (e: FocusEvent) => {
      if (combat.on && typing(e.target)) leave();
    };
    const onHidden = () => {
      if (document.hidden) leave();
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("pointerup", onPointerUp);
    window.addEventListener("blur", leave);
    document.addEventListener("focusin", onFocusIn);
    document.addEventListener("visibilitychange", onHidden);
    surface.addEventListener("pointerdown", onPointerDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("blur", leave);
      document.removeEventListener("focusin", onFocusIn);
      document.removeEventListener("visibilitychange", onHidden);
      surface.removeEventListener("pointerdown", onPointerDown);
      leave();
    };
  }, [canFight, surface]);

  const aim = useRef({
    point: new THREE.Vector3(),
    /** The aim stopped on something solid that isn't a dummy. */
    blocked: false,
    castAt: Number.NEGATIVE_INFINITY,
  });
  const ray = useRef(
    new rapier.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: -1 }),
  );
  const v = useRef({
    origin: new THREE.Vector3(),
    dir: new THREE.Vector3(),
    hand: new THREE.Vector3(),
    chest: new THREE.Vector3(),
  });

  // After physics (-3), before the camera follows (-2): last frame's camera
  // is the one the crosshair was drawn with.
  useFrame((_, frameDt) => {
    const now = performance.now();
    const dt = Math.min(frameDt, 0.1);
    const herzie = rt.playerHerzie;
    const { origin, dir, hand, chest } = v.current;
    const a = aim.current;

    // --- Aim: what's under the crosshair.
    if (combat.on) {
      camera.getWorldPosition(origin);
      camera.getWorldDirection(dir);
      let reach = AIM_RANGE;
      let blocked = false;
      const r = ray.current;
      r.origin = origin;
      r.dir = dir;
      const hit = world.castRay(
        r,
        AIM_RANGE,
        true,
        undefined,
        undefined,
        undefined,
        rt.playerRigidBody ?? undefined,
      );
      if (hit) {
        reach = hit.timeOfImpact;
        blocked = true;
      }
      // The ground has no collider: meet it as a plane.
      if (dir.y < -1e-4) {
        const ground = -origin.y / dir.y;
        if (ground < reach) {
          reach = ground;
          blocked = true;
        }
      }
      a.point.copy(origin).addScaledVector(dir, reach);
      // On a dummy, it's a target, not a wall.
      let onDummy = false;
      for (const d of liveDummies) {
        const near = Math.hypot(a.point.x - d.x, a.point.z - d.z);
        if (near < DUMMY.radius + 0.3 && a.point.y < DUMMY.top + 0.6) {
          onDummy = true;
          break;
        }
      }
      a.blocked = blocked && !onDummy;
      combat.onTarget = onDummy;
    } else {
      combat.onTarget = false;
    }

    // --- Casting.
    if (herzie) {
      const queued = now - combat.queuedAt < CAST_BUFFER_MS;
      const ready = (now - a.castAt) / 1000 >= CAST_INTERVAL;
      if (combat.on && (queued || combat.fireHeld) && ready) {
        a.castAt = now;
        combat.queuedAt = Number.NEGATIVE_INFINITY;
        herzie.root.getWorldPosition(chest);
        chest.y += herzie.height * 0.55;
        const dx = a.point.x - chest.x;
        const dz = a.point.z - chest.z;
        const flat = Math.hypot(dx, dz);
        // Face the aim, and raise the hand to it.
        if (flat > 0.5) herzie.heading = Math.atan2(dx, dz);
        herzie.cast(Math.atan2(a.point.y - chest.y, Math.max(flat, 0.5)));
        combat.casts = (combat.casts + 1) & 0xffff;
        combat.spread = 1;
        sfxCharge();
      }
      // The hand is out: the wave leaves it (Player's update, last frame).
      if (herzie.released && combat.on) {
        herzie.handWorldPosition(hand);
        dir.copy(a.point).sub(hand);
        const toAim = dir.length();
        dir.normalize();
        const from: Vec3 = [hand.x, hand.y, hand.z];
        const toward: Vec3 = [dir.x, dir.y, dir.z];
        const target = assistTarget(from, toward, liveDummies);
        waveField.cast(from, toward, {
          mine: true,
          // Short of a dummy, a wall in the way is where it bursts.
          reach: a.blocked && !target ? toAim + 0.2 : WAVE.range,
          target,
        });
        sfxCast();
        shake(0.05);
      }
    }

    // --- Waves in flight, and what they hit. A crit's hit-stop holds them
    // near-still for a beat.
    const slow = now < combat.slowUntil ? HIT_STOP_SCALE : 1;
    waveField.step(dt * slow, liveDummies, ({ wave, dummy, point }) => {
      if (!wave.mine) {
        hitDummy(dummy, wave.dir[0], wave.dir[2], 100, false, now, false);
        sfxImpact("hit");
        return "hit";
      }
      const { amount, crit } = hitDamage(statsRef.current);
      hitDummy(dummy, wave.dir[0], wave.dir[2], amount, crit, now);
      pushDamageNumber(point, amount, crit);
      combat.hitAt = now;
      combat.hitCrit = crit;
      combat.bestDps = Math.max(
        combat.bestDps,
        dummy.meter.hits >= 3 ? meterDps(dummy.meter, now) : 0,
      );
      shake(crit ? 0.32 : 0.12);
      if (crit) combat.slowUntil = now + HIT_STOP_MS;
      sfxImpact(crit ? "crit" : "hit");
      return crit ? "crit" : "hit";
    });
    combat.spread = Math.max(0, combat.spread - dt * 4);
  }, -2.5);

  return null;
}

/** Out of combat mode, letting the mouse go. */
function leave() {
  exitMouseLook();
  setCombat(false);
}
