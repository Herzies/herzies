import {
  BACKSPIN_DISCS,
  BACKSPIN_SPREAD,
  CAST_INTERVAL_MS,
  type HerzieStats,
  hitDamage,
  SKILL_DEFS,
  skillValue,
} from "@herzies/shared";
import {
  BOSS_STAND,
  DISC_DAMAGE,
  DISC_RANGE,
  meleeDamage,
  meleeReaches,
  WAVE_HAND_HEIGHT,
} from "@herzies/shared/combat";
import type { HerzieModel } from "@herzies/shared/gl";
import { useFrame, useThree } from "@react-three/fiber";
import { useRapier } from "@react-three/rapier";
import { useEffect, useRef } from "react";
import * as THREE from "three";
import { groundY, type TownMap } from "../map";
import { townNet } from "../net/townNet";
import { townSave, useTownRuntime } from "../runtime";
import {
  sfxCast,
  sfxCharge,
  sfxDiscCatch,
  sfxDiscClink,
  sfxDiscThrow,
  sfxDiscTurn,
  sfxImpact,
  sfxMeleeHit,
  sfxSwing,
} from "../sfx";
import { pushDamageNumber } from "./DamageNumbers";
import { liveDummies } from "./Dummies";
import {
  DISC_ARM,
  type DiscHand,
  type DiscHooks,
  discField,
  nextHand,
} from "./discs";
import { DUMMY, type DummyState, hitDummy, meterDps } from "./dummy";
import { bossFight } from "./fight";
import { enterMouseLook, exitMouseLook } from "./mouseLook";
import {
  entityAt,
  mySkillReady,
  noteSkillCast,
  setBuff,
  skills,
  startMyCooldown,
} from "./skills";
import { slashField } from "./slashes";
import { CAST_BUFFER_MS, combat, setCombat, shake } from "./state";
import { assistTarget, type Vec3, WAVE, waveField } from "./waves";

/** How soon after one cast the next may start, in seconds: the hand is
 * on its way home by then, so a held button rolls into the next. */
const CAST_INTERVAL = CAST_INTERVAL_MS / 1000;
/** How far the aim looks for something to land on. */
const AIM_RANGE = 60;
/** How slow waves and dummies go during a crit's hit-stop. */
const HIT_STOP_SCALE = 0.12;
const HIT_STOP_MS = 65;
const HANDS: readonly DiscHand[] = ["held-l", "held-r"];

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
 * Fighting on the training grounds: combat mode's controls, your aim, your
 * casts, and every wave in flight — where it lands and what that does.
 *
 * - Tab: into combat mode (the mouse aims; the camera stays as it is);
 *   Esc, or Tab again: out.
 * - Left click or F: cast. Holding it keeps casting; a press mid-cast is
 *   kept for the next.
 * - Q or 1: your class skill, if you have one. In the boss room the server
 *   runs it; on the training grounds it's practice (no XP).
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
      } else if (
        (e.code === "KeyQ" || e.code === "Digit1") &&
        !e.repeat &&
        skills.mine
      ) {
        e.preventDefault();
        skillQueuedAt = performance.now();
      }
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.code === "KeyF") combat.fireHeld = false;
    };
    // Anywhere in the window: with the cursor held still or hidden (not
    // pointer-locked), it may be over the chat or the HUD rather than the
    // world. A click there casts, and mustn't focus the chat (which would
    // end combat).
    const onPointerDown = (e: PointerEvent) => {
      if (!combat.on || e.button !== 0) return;
      // Not preventDefault: that would silence mouse moves until the button
      // is let go (the mousedown below keeps the chat from taking focus).
      e.stopPropagation();
      combat.queuedAt = performance.now();
      combat.fireHeld = true;
    };
    const onMouseDown = (e: MouseEvent) => {
      if (combat.on && e.button === 0) e.preventDefault();
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
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("mousedown", onMouseDown, true);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("blur", leave);
      document.removeEventListener("focusin", onFocusIn);
      document.removeEventListener("visibilitychange", onHidden);
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("mousedown", onMouseDown, true);
      leave();
    };
  }, [canFight, surface]);

  // A new island (Combat comes and goes with its physics): discs still
  // out are home in the hand, not flying across the portal after it.
  useEffect(
    () => () => {
      const herzie = rt.playerHerzie;
      if (herzie) discField.recall(herzie);
    },
    [rt],
  );

  const aim = useRef({
    point: new THREE.Vector3(),
    /** The aim stopped on something solid that isn't a dummy. */
    blocked: false,
    castAt: Number.NEGATIVE_INFINITY,
    /** The hand the disc under way is thrown from (a Record Slinger). */
    throwing: "held-l" as DiscHand,
    /** The dummy the crosshair's on, if any. */
    dummy: null as DummyState | null,
  });
  const ray = useRef(
    new rapier.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: -1 }),
  );
  const v = useRef({
    origin: new THREE.Vector3(),
    dir: new THREE.Vector3(),
    hand: new THREE.Vector3(),
    chest: new THREE.Vector3(),
    held: new THREE.Vector3(),
  });

  /** A hit of yours on a dummy, at `scale` of a wave's: the number, the
   * meter, the shake (and a crit's hit-stop). */
  const myHit = (
    dummy: DummyState,
    dir: Readonly<Vec3>,
    point: Vec3,
    scale: number,
    now: number,
  ): "crit" | "hit" => {
    // A Tower mob: the server rolls it and says (the number, the sound).
    if (dummy.mob !== undefined) {
      hitDummy(dummy, dir[0], dir[2], 0, false, now, false);
      return "hit";
    }
    const rolled = hitDamage(statsRef.current);
    const amount = Math.max(1, Math.round(rolled.amount * scale));
    const { crit } = rolled;
    hitDummy(dummy, dir[0], dir[2], amount, crit, now);
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
  };

  /** What the discs in flight do, whoever threw them. */
  const discHooks = useRef<DiscHooks>({
    handAt: (d, out) => {
      const owner = d.owner as HerzieModel;
      const p = owner.heldWorldPosition(d.hand, v.current.held);
      out[0] = p.x;
      out[1] = p.y;
      out[2] = p.z;
      return out;
    },
    onHit: ({ disc, dummy, point }) => {
      const now = performance.now();
      if (!disc.mine) {
        hitDummy(dummy, disc.dir[0], disc.dir[2], 100, false, now, false);
        waveField.burst(point, disc.dir, "hit");
        sfxImpact("hit");
        return "hit";
      }
      const kind = myHit(dummy, disc.dir, point, DISC_DAMAGE, now);
      waveField.burst(point, disc.dir, kind);
      return kind;
    },
    // The boss: the server says what it did (the number, the sound).
    onStrike: (disc) => waveField.burst(disc.pos, disc.dir, "hit"),
    onCatch: (disc) => {
      const owner = disc.owner as HerzieModel;
      owner.catchPulse(DISC_ARM[disc.hand]);
      if (!disc.mine) return;
      const main = disc.hand === "held-l";
      sfxDiscCatch(main);
      shake(0.03);
      combat.discs.caughtAt[disc.hand] = performance.now();
    },
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
      // The ground has no collider: meet it as a plane, level with where
      // you stand.
      if (dir.y < -1e-4) {
        const floor = groundY(map, townSave.x, townSave.z);
        const ground = (floor - origin.y) / dir.y;
        if (ground < reach) {
          reach = ground;
          blocked = true;
        }
      }
      a.point.copy(origin).addScaledVector(dir, reach);
      // On a dummy, it's a target, not a wall.
      let onDummy: DummyState | null = null;
      for (const d of liveDummies) {
        const near = Math.hypot(a.point.x - d.x, a.point.z - d.z);
        if (
          near < DUMMY.radius + 0.3 &&
          a.point.y < (d.y ?? 0) + DUMMY.top + 0.6
        ) {
          onDummy = d;
          break;
        }
      }
      a.blocked = blocked && !onDummy;
      a.dummy = onDummy;
      combat.onTarget = !!onDummy;
    } else {
      a.dummy = null;
      combat.onTarget = false;
    }

    // In a blow's reach: struck now, turned to the aim as a cast turns it,
    // would it land? Judged as the blow itself is.
    combat.inReach = false;
    if (combat.on && combat.attack === "melee" && herzie) {
      herzie.root.getWorldPosition(chest);
      const dx = a.point.x - chest.x;
      const dz = a.point.z - chest.z;
      const yaw =
        Math.hypot(dx, dz) > 0.5 ? Math.atan2(dx, dz) : herzie.heading;
      const from = { x: chest.x, z: chest.z };
      combat.inReach =
        liveDummies.some((d) =>
          meleeReaches(from, yaw, { ...d, radius: DUMMY.radius }),
        ) ||
        (inBossRoom() && meleeReaches(from, yaw, BOSS_STAND));
    }

    // Where you are, for effects that follow you (a Cymbrella overhead).
    if (herzie) {
      herzie.root.getWorldPosition(chest);
      entityAt.set(bossFight.you ?? -1, {
        x: chest.x,
        z: chest.z,
        top: chest.y + herzie.height,
      });
    }

    // --- Your class skill: pressed (or pressed just before it was ready).
    const mine = skills.mine;
    if (
      herzie &&
      mine &&
      now - skillQueuedAt < CAST_BUFFER_MS &&
      mySkillReady(now)
    ) {
      skillQueuedAt = Number.NEGATIVE_INFINITY;
      const seq = startMyCooldown(now);
      herzie.root.getWorldPosition(chest);
      chest.y += herzie.height * 0.55;
      // Aimed like a cast in combat mode; otherwise the way you face.
      let yaw = herzie.heading;
      let pitch = 0;
      if (combat.on) {
        const dx = a.point.x - chest.x;
        const dz = a.point.z - chest.z;
        const flat = Math.max(Math.hypot(dx, dz), 0.5);
        yaw = Math.atan2(dx, dz);
        pitch = Math.atan2(a.point.y - chest.y, flat);
        if (flat > 0.5) herzie.heading = yaw;
      }
      noteSkillCast({
        by: bossFight.you ?? -1,
        skill: mine.id,
        level: mine.level,
        x: chest.x,
        z: chest.z,
        yaw,
        at: now,
      });
      // A Cymbrella's on you at once, for as long as it lasts: in a fight
      // the server's word replaces this (or a refusal takes it off); in
      // practice there's no server to say so.
      if (mine.id === "cymbrella") {
        setBuff(bossFight.you ?? -1, {
          buff: mine.id,
          value: skillValue(mine.id, mine.level),
          until: now + (SKILL_DEFS[mine.id].durationMs ?? 0),
        });
      }
      if (bossFight.on) {
        townNet().sendSkill(mine.id, seq, yaw, pitch);
      } else if (mine.id === "backspin") {
        // Practice: the discs hit the dummies, for their share of a wave.
        const half = (BACKSPIN_DISCS - 1) / 2;
        for (let i = 0; i < BACKSPIN_DISCS; i++) {
          const y = yaw + (i - half) * BACKSPIN_SPREAD;
          const toward: Vec3 = [
            Math.sin(y) * Math.cos(pitch),
            Math.sin(pitch),
            Math.cos(y) * Math.cos(pitch),
          ];
          const from: Vec3 = [chest.x, chest.y, chest.z];
          waveField.cast(from, toward, {
            mine: true,
            target: assistTarget(from, toward, liveDummies),
            scale: skillValue("backspin", mine.level),
          });
        }
      }
      sfxCast();
      shake(0.15);
    }

    // --- Casting: a wave from the hand; a Record Slinger's disc thrown
    // from whichever hand has one; or a blow up close — a Percussionist's
    // stick, or (without a class) the herzie itself, bumped into it.
    const discs = combat.attack === "disc";
    const melee = combat.attack === "melee";
    const blow = herzie?.holdsGear ? "strike" : "bump";
    if (herzie) {
      const queued = now - combat.queuedAt < CAST_BUFFER_MS;
      const free = discs ? nextHand(discField, herzie) : null;
      const ready =
        (now - a.castAt) / 1000 >= CAST_INTERVAL && (!discs || free !== null);
      if (combat.on && (queued || combat.fireHeld) && ready && discs && free) {
        a.castAt = now;
        a.throwing = free;
        combat.queuedAt = Number.NEGATIVE_INFINITY;
        herzie.root.getWorldPosition(chest);
        chest.y += herzie.height * 0.55;
        const dx = a.point.x - chest.x;
        const dz = a.point.z - chest.z;
        const flat = Math.hypot(dx, dz);
        if (flat > 0.5) herzie.heading = Math.atan2(dx, dz);
        herzie.cast(Math.atan2(a.point.y - chest.y, Math.max(flat, 0.5)), {
          arm: DISC_ARM[free],
          style: "throw",
        });
        combat.casts = (combat.casts + 1) & 0xffff;
        combat.spread = 0.6;
        sfxDiscThrow(free === "held-l");
      } else if (combat.on && (queued || combat.fireHeld) && ready) {
        a.castAt = now;
        combat.queuedAt = Number.NEGATIVE_INFINITY;
        herzie.root.getWorldPosition(chest);
        chest.y += herzie.height * 0.55;
        const dx = a.point.x - chest.x;
        const dz = a.point.z - chest.z;
        const flat = Math.hypot(dx, dz);
        // Face the aim, and raise the hand to it.
        if (flat > 0.5) herzie.heading = Math.atan2(dx, dz);
        if (melee) {
          herzie.cast(0, { style: blow });
          if (blow === "strike") slashField.strike(herzie, true);
          combat.spread = 0.4;
          sfxSwing(blow);
        } else {
          herzie.cast(Math.atan2(a.point.y - chest.y, Math.max(flat, 0.5)));
          combat.spread = 1;
          sfxCharge();
        }
        combat.casts = (combat.casts + 1) & 0xffff;
      }
      // The blow lands: whatever's in front of it, in reach, is hit.
      if (herzie.released && combat.on && melee) {
        herzie.root.getWorldPosition(chest);
        const yaw = herzie.heading;
        const from = { x: chest.x, z: chest.z };
        const height = herzie.height * (blow === "strike" ? 0.6 : 0.4);
        let landed = false;
        for (const d of liveDummies) {
          if (!meleeReaches(from, yaw, { ...d, radius: DUMMY.radius }))
            continue;
          const toward = flatToward(from, d);
          const point: Vec3 = [
            d.x - toward[0] * DUMMY.radius,
            Math.min(DUMMY.chest, height),
            d.z - toward[2] * DUMMY.radius,
          ];
          const kind = myHit(
            d,
            toward,
            point,
            meleeDamage(blow === "strike"),
            now,
          );
          waveField.burst(point, toward, kind);
          landed = true;
        }
        if (bossFight.on) {
          // The server judges it, and says what it did (the number, the
          // sound); the burst is what you see land.
          townNet().sendCast(yaw, 0);
          const boss = { ...BOSS_STAND };
          if (inBossRoom() && meleeReaches(from, yaw, boss)) {
            const toward = flatToward(from, boss);
            waveField.burst(
              [
                boss.x - toward[0] * boss.radius,
                height,
                boss.z - toward[2] * boss.radius,
              ],
              toward,
              "hit",
            );
            landed = true;
          }
        }
        if (landed) {
          sfxMeleeHit(blow);
          // Held still on the contact, a beat, so it lands.
          herzie.hitstop();
        }
        shake(landed ? 0.1 : 0.03);
      }
      // The hand is out: the disc leaves it.
      if (herzie.released && combat.on && discs) {
        const h = a.throwing;
        herzie.heldWorldPosition(h, hand);
        // With the crosshair on a dummy, at its middle: the aim may be on
        // its foot, and a disc from a low hand would meet the ground first.
        const on = a.dummy;
        if (on) dir.set(on.x, DUMMY.chest, on.z).sub(hand);
        else dir.copy(a.point).sub(hand);
        const toAim = dir.length();
        dir.normalize();
        const from: Vec3 = [hand.x, hand.y, hand.z];
        const toward: Vec3 = [dir.x, dir.y, dir.z];
        const target = on ?? assistTarget(from, toward, liveDummies);
        // Short of a dummy and in reach, what the aim's on is where it
        // turns back: the boss (a hit), or a wall (a clink).
        const solid = a.blocked && !target && toAim < DISC_RANGE;
        const onBoss =
          inBossRoom() &&
          Math.hypot(a.point.x - BOSS_STAND.x, a.point.z - BOSS_STAND.z) <
            BOSS_STAND.radius + 0.8;
        discField.throw(from, toward, {
          mine: true,
          owner: herzie,
          hand: h,
          reach: solid ? toAim : DISC_RANGE,
          strike: solid ? (onBoss ? "target" : "wall") : null,
          target,
        });
        if (bossFight.on) sendBossCast(herzie, a.point);
        shake(0.04);
      }
      // The hand is out: the wave leaves it (Player's update, last frame).
      if (herzie.released && combat.on && combat.attack === "wave") {
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
        // In the boss room, the server does the hitting: tell it the aim.
        if (bossFight.on) sendBossCast(herzie, a.point);
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
      return myHit(dummy, wave.dir, point, wave.scale, now);
    });
    // Discs in flight, anyone's; and the sounds of yours turning and
    // glancing off walls.
    discField.step(dt * slow, liveDummies, discHooks.current);
    for (const sp of discField.sparks) {
      if (!sp.alive || sp.heard) continue;
      sp.heard = true;
      if (sp.kind === "throw" || sp.kind === "catch") continue;
      const near =
        !herzie ||
        Math.hypot(
          sp.pos[0] - herzie.root.position.x,
          sp.pos[2] - herzie.root.position.z,
        ) <
          DISC_RANGE + 4;
      if (!near) continue;
      if (sp.kind === "turn") sfxDiscTurn();
      else sfxDiscClink();
    }
    // Your discs: out of the hand while they fly (the crosshair says
    // which).
    if (herzie) {
      for (const h of HANDS) {
        const out = discField.isOut(herzie, h);
        herzie.setHeldHidden(h, out);
        combat.discs.in[h] = !out;
      }
    }
    combat.spread = Math.max(0, combat.spread - dt * 4);
  }, -2.5);

  return null;
}

const castFrom = new THREE.Vector3();

/** In the boss's cave (not the Tower, which fights the same way). */
function inBossRoom(): boolean {
  return bossFight.on && !bossFight.tower;
}

/**
 * Tells the server a cast at `point`, aimed as it judges it: from where it
 * thinks the hand is (over the herzie's middle, at WAVE_HAND_HEIGHT), not
 * the hand itself. Up close the two differ a lot — a hand can be nearly in
 * the boss — and the server would see the throw going off sideways.
 */
function sendBossCast(herzie: HerzieModel, point: THREE.Vector3) {
  herzie.root.getWorldPosition(castFrom);
  const dx = point.x - castFrom.x;
  const dy = point.y - WAVE_HAND_HEIGHT;
  const dz = point.z - castFrom.z;
  townNet().sendCast(Math.atan2(dx, dz), Math.atan2(dy, Math.hypot(dx, dz)));
}

/** The level way from `from` to `to`, as a unit direction. */
function flatToward(
  from: { x: number; z: number },
  to: { x: number; z: number },
): Vec3 {
  const dx = to.x - from.x;
  const dz = to.z - from.z;
  const n = Math.hypot(dx, dz) || 1;
  return [dx / n, 0, dz / n];
}

/** When the skill key was last pressed (performance.now() ms): kept for
 * CAST_BUFFER_MS, so a press just before it's ready still goes off. */
let skillQueuedAt = Number.NEGATIVE_INFINITY;

/** Out of combat mode, letting the mouse go. */
function leave() {
  exitMouseLook();
  setCombat(false);
}

/** Out of combat mode, from outside it (the boss's end screen). */
export const leaveCombat = leave;
