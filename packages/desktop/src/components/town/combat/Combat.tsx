import {
  BACKSPIN_DISCS,
  BACKSPIN_SPREAD,
  bleedEveryMs,
  CAST_INTERVAL_MS,
  CYMBAL_TRAP,
  cymbalLandsAfterMs,
  type HerzieStats,
  hitDamage,
  MULTISPIN,
  multispinOffset,
  multispinRecords,
  RIMSHOT,
  SKILL_DEFS,
  type SkillId,
  shuffleBounces,
  shuffleScale,
  skillDurationMs,
  skillValue,
  timingAttackSpeed,
  timingCritChance,
} from "@herzies/shared";
import {
  aimDirection,
  BOSS_STAND,
  bodyHitAt,
  bossReaches,
  DISC_DAMAGE,
  DISC_RANGE,
  discLandsAfterMs,
  HEAL_TARGET_HEIGHT,
  healTarget,
  MELEE_CLEAVE,
  meleeDamage,
  meleeReaches,
  STRIKE_DAMAGE,
  WAVE_HAND_HEIGHT,
} from "@herzies/shared/combat";
import type { HerzieModel } from "@herzies/shared/gl";
import { towerBoonTotals } from "@herzies/shared/tower";
import { useFrame, useThree } from "@react-three/fiber";
import { useRapier } from "@react-three/rapier";
import { useEffect, useRef } from "react";
import * as THREE from "three";
import { notify } from "../../../lib/notices";
import { entityDown, youDown } from "../downed";
import { duelFighting, duelHeld, inDuel, myDuelHp } from "../duel/store";
import { groundY, type TownMap } from "../map";
import { townNet } from "../net/townNet";
import { townSave, useTownRuntime } from "../runtime";
import {
  sfxBleedStack,
  sfxCast,
  sfxCharge,
  sfxCymbalClang,
  sfxCymbalThrow,
  sfxDiscCatch,
  sfxDiscClink,
  sfxDiscThrow,
  sfxDiscTurn,
  sfxDomeUp,
  sfxFocus,
  sfxForbiddenThrow,
  sfxHaste,
  sfxHealBolt,
  sfxImpact,
  sfxMeleeHit,
  sfxMultispin,
  sfxRage,
  sfxRimshotSlam,
  sfxRimshotWindup,
  sfxSilencio,
  sfxSilencioWindup,
  sfxStun,
  sfxSwing,
  sfxTaunt,
} from "../sfx";
import { getVitals, useVitals } from "../vitals";
import { myWildsHp, wildsHeld, wildsOn } from "../wilds/store";
import { type BleedSkill, bleedDummy, bleeds } from "./bleeds";
import {
  pushBleedNumber,
  pushDamageNumber,
  pushStunLabel,
} from "./DamageNumbers";
import { liveDummies } from "./Dummies";
import {
  DISC_ARM,
  type DiscHand,
  type DiscHooks,
  discField,
  nextHand,
} from "./discs";
import { DUMMY, type DummyState, hitDummy, meterDps } from "./dummy";
import { bossFight, bossNow, useBossFight } from "./fight";
import { enterMouseLook, exitMouseLook } from "./mouseLook";
import {
  attackSpeedOf,
  buffOn,
  entityAt,
  focusOf,
  instrumentNeeded,
  noteSkillCast,
  setBuff,
  setSelfAt,
  shuffleOf,
  skillReady,
  skills,
  startCooldown,
} from "./skills";
import {
  beginSlam,
  cancelSlam,
  inSlamReach,
  landSlam,
  pendingSlam,
  type SlamSkill,
} from "./slams";
import { slashField } from "./slashes";
import { healing, stance, toggleStance, useStanceSender } from "./stance";
import { CAST_BUFFER_MS, combat, kick, setCombat, shake } from "./state";
import { stuns } from "./stuns";
import { catchCymbal, cymbalOut, throwCymbal } from "./traps";
import { assistTarget, type Vec3, WAVE, waveField } from "./waves";

/** How soon after one cast the next may start, in seconds: the hand is
 * on its way home by then, so a held button rolls into the next. */
const CAST_INTERVAL = CAST_INTERVAL_MS / 1000;
/** How far the aim looks for something to land on. */
const AIM_RANGE = 60;
/** How slow waves and dummies go during a crit's hit-stop. */
const HIT_STOP_SCALE = 0.12;
/** Scratch for the frame's reach check: nothing allocated each frame. */
const reachFrom = { x: 0, z: 0 };
const reachBody = { x: 0, z: 0, radius: 0 };
const bossScratch = { x: 0, z: 0, yaw: 0 };
/** The heal stance's allies each frame, and the entries they're written
 * into: kept, so aiming a heal makes nothing new. */
const allies: { id: number; x: number; z: number }[] = [];
const allyPool: { id: number; x: number; z: number }[] = [];
const HIT_STOP_MS = 65;
const HANDS: readonly DiscHand[] = ["held-l", "held-r"];
/** A Rimshot's hold on the slam (a plain strike holds 70 ms): the
 * heaviest blow there is, so it holds the longest. */
const SLAM_HITSTOP_S = 0.12;
/** How long a skill with a motion of its own pressed mid-swing is kept
 * for, waiting out that swing (any other press: CAST_BUFFER_MS). */
const SWING_QUEUE_MS = 1_000;
/** Skills whose cast is a motion of their own (a slam, a throw, a
 * flourish): they wait out a swing under way rather than cut it short. */
const OWN_MOTION: Partial<Record<SkillId, true>> = {
  rimshot: true,
  silencio: true,
  "cymbal-trap": true,
  multispin: true,
  "forbidden-frequency": true,
};
/** The skills whose bleeds a practice dummy may take, each ticking. */
const BLEED_SKILLS: readonly BleedSkill[] = ["forbidden-frequency", "silencio"];
/** How each wind-up skill moves its caster (see HerzieModel's cast). */
const WINDUP_STYLE = { rimshot: "slam", silencio: "hush" } as const;
/** Practice: when each of your Multispin's records last touched each
 * dummy, by record (the server keeps the same in a fight). */
const spinTouches = new WeakMap<DummyState, Float64Array>();

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
 * Fighting in the Town: combat mode's controls, your aim, your
 * casts, and every wave in flight — where it lands and what that does.
 *
 * - Tab: into combat mode (the mouse aims; the camera stays as it is);
 *   Esc, or Tab again: out.
 * - Left click or F: cast. Holding it keeps casting; a press mid-cast is
 *   kept for the next.
 * - A hotbar key holding a class skill (1/Q to begin with: hotbarKeys.ts).
 *   In a fight the server runs it; anywhere else it's practice on the
 *   dummies (no XP).
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
  useStanceSender();
  const { world, rapier } = useRapier();
  const camera = useThree((s) => s.camera);
  const surface = useThree((s) => s.gl.domElement);
  const statsRef = useRef(stats);
  statsRef.current = stats;
  // Aim mode works anywhere in the Town, not just where there's something
  // to fight (map.combat).
  const canFight = active;

  // The Tower is a fight from the first step: aim mode starts on (Tab still
  // leaves it).
  useBossFight();
  const inTower = !!bossFight.tower;

  // Knocked out: back to roaming, the mouse let go.
  const down = !!useVitals()?.down;
  useEffect(() => {
    if (down) leave();
  }, [down]);

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
        // Knocked out: nothing to aim with until you're back up.
        else if (!getVitals()?.down) void enter();
      } else if (e.code === "Escape" && combat.on) {
        leave();
      } else if (e.code === "KeyF" && combat.on) {
        e.preventDefault();
        if (!e.repeat) combat.queuedAt = performance.now();
        combat.fireHeld = true;
      } else if (
        e.code === "KeyR" &&
        !e.repeat &&
        skills.instrument === "lute"
      ) {
        // A Bard's lute: attack ⇄ heal.
        e.preventDefault();
        toggleStance();
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
    // Let go outside the window (or the system took the pointer): no
    // pointerup ever comes, so the next move or a cancel says it's up.
    const onPointerMove = (e: PointerEvent) => {
      if (combat.fireHeld && e.pointerType === "mouse" && !(e.buttons & 1))
        combat.fireHeld = false;
    };
    const onPointerCancel = () => {
      combat.fireHeld = false;
    };
    // Typing in the chat, or the app going to the background, ends it.
    const onFocusIn = (e: FocusEvent) => {
      if (combat.on && typing(e.target)) leave();
    };
    const onHidden = () => {
      if (document.hidden) leave();
    };
    if (inTower && !getVitals()?.down) void enter();
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("pointerup", onPointerUp);
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointercancel", onPointerCancel);
    window.addEventListener("blur", leave);
    document.addEventListener("focusin", onFocusIn);
    document.addEventListener("visibilitychange", onHidden);
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("mousedown", onMouseDown, true);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointercancel", onPointerCancel);
      window.removeEventListener("blur", leave);
      document.removeEventListener("focusin", onFocusIn);
      document.removeEventListener("visibilitychange", onHidden);
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("mousedown", onMouseDown, true);
      leave();
    };
  }, [canFight, surface, inTower]);

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
    /** A cast under way that began in combat: it releases (and the server
     * hears of it) even if combat is left mid-swing, as others already
     * saw it start. */
    live: false,
    /** The hand the disc under way is thrown from (a Record Slinger). */
    throwing: "held-l" as DiscHand,
    /** The dummy the crosshair's on, if any. */
    dummy: null as DummyState | null,
    /** The ally the heal bolt under way goes to (an entity id). */
    bolt: null as number | null,
    /** A Rimshot or a Silencio winding up: which, at what level, when it
     * was pressed, and its wind-up sound (cut if the wind-up is). */
    windup: null as null | {
      skill: SlamSkill;
      level: number;
      at: number;
      roll: { stop(): void };
    },
    /** A heal bolt under way with nobody locked: it flies down the aim,
     * for show (it heals no one). */
    freeHeal: false,
    /** Practice: your Cymbal Trap on its way to the dummy it'll catch,
     * which takes its blow as it lands, from `dir`. */
    trap: null as null | {
      dummy: DummyState;
      landsAt: number;
      dir: Vec3;
    },
    /** Practice: your Forbidden Frequency disc on its way to the dummy it
     * will bleed, at `value` of a wave a stack each tick. */
    bleed: null as null | {
      dummy: DummyState;
      landsAt: number;
      value: number;
    },
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
   * meter, the shake (and a crit's hit-stop). A bleed's `tick` never
   * crits, and lands quietly: no shake, no thud. */
  const myHit = (
    dummy: DummyState,
    dir: Readonly<Vec3>,
    point: Vec3,
    scale: number,
    now: number,
    tick = false,
  ): "crit" | "hit" => {
    // A Tower mob, or a duel's opponent: the server rolls it and says (the
    // number, the sound).
    if (dummy.mob !== undefined || dummy.herzie !== undefined) {
      hitDummy(dummy, dir[0], dir[2], 0, false, now, false);
      return "hit";
    }
    // With a Focus your Timing's higher (crits likelier); with a Rage you
    // hit harder: as the server rolls them.
    const me = bossFight.you ?? -1;
    const stats = statsRef.current;
    const focus = focusOf(me, now);
    const timing = stats.timing ?? 0;
    const rolled = hitDamage(
      tick
        ? { ...stats, critChance: 0 }
        : focus > 0
          ? {
              ...stats,
              critChance:
                stats.critChance +
                timingCritChance(timing + focus) -
                timingCritChance(timing),
            }
          : stats,
    );
    const rage = buffOn(me, "rage", now)?.value ?? 0;
    const amount = Math.max(1, Math.round(rolled.amount * scale * (1 + rage)));
    const { crit } = rolled;
    hitDummy(dummy, dir[0], dir[2], amount, crit, now);
    if (tick) pushBleedNumber(point, amount, dummy.key);
    else pushDamageNumber(point, amount, crit);
    combat.bestDps = Math.max(
      combat.bestDps,
      dummy.meter.hits >= 3 ? meterDps(dummy.meter, now) : 0,
    );
    if (tick) return "hit";
    combat.hitAt = now;
    combat.hitCrit = crit;
    shake(crit ? 0.32 : 0.12);
    if (crit) combat.slowUntil = now + HIT_STOP_MS;
    sfxImpact(crit ? "crit" : "hit");
    return crit ? "crit" : "hit";
  };

  /**
   * A Rimshot's slam, as the stick strikes the ground: the shockwave and the
   * rest of the show (SlamVFX), a heavy hold on the contact, the camera's
   * jolt and the boom. Out of a fight every dummy within reach
   * takes twice a strike, rocked back from the middle, and rolls its own
   * stun; in a fight the server judges it all (the room hears of hits and
   * stuns with its next word).
   */
  const slamLands = (herzie: HerzieModel, chance: number, now: number) => {
    const { chest, held } = v.current;
    herzie.root.getWorldPosition(chest);
    const centre = { skill: "rimshot" as const, x: chest.x, z: chest.z };
    const hand = herzie.handWorldPosition(held);
    landSlam(bossFight.you ?? -1, [hand.x, hand.y, hand.z], now);
    let stunned = false;
    let struck = false;
    for (const d of liveDummies) {
      const radius = DUMMY.radius * (d.size ?? 1);
      if (!inSlamReach(centre, d.x, d.z, radius)) continue;
      struck = true;
      const toward = flatToward(centre, d);
      const point: Vec3 = [
        d.x - toward[0] * radius,
        Math.min(DUMMY.chest, 0.6),
        d.z - toward[2] * radius,
      ];
      myHit(d, toward, point, RIMSHOT.damage * STRIKE_DAMAGE, now);
      waveField.burst(point, toward, "hit");
      // Practice: each rolls its own stun. A mob's is the server's.
      if (
        d.mob === undefined &&
        d.herzie === undefined &&
        !bossFight.on &&
        Math.random() < chance
      ) {
        stuns.dummies.set(d.key, now + RIMSHOT.stunMs);
        d.frozenUntil = Math.max(d.frozenUntil, now + 120);
        pushStunLabel([d.x, (d.y ?? 0) + DUMMY.chest + 0.2, d.z]);
        stunned = true;
      }
    }
    if (stunned) sfxStun();
    sfxRimshotSlam();
    herzie.hitstop(SLAM_HITSTOP_S);
    kick(stunned || struck ? 0.34 : 0.26);
    shake(stunned ? 0.32 : 0.22);
  };

  /**
   * A Silencio's burst, as the lute sweeps out: the wave of silence and
   * the rest of its show (SilencioVFX), its whoosh and a soft jolt. Out of
   * a fight every dummy within reach starts bleeding (Silencio's own bleed,
   * beside any Forbidden Frequency's); in a fight the server judges it all
   * (the bleeds come as `bleed`, the shoves as the mobs' moves).
   */
  const silencioLands = (herzie: HerzieModel, level: number, now: number) => {
    const { chest, held } = v.current;
    herzie.root.getWorldPosition(chest);
    const hand = herzie.handWorldPosition(held);
    const me = bossFight.you ?? -1;
    landSlam(me, [hand.x, hand.y, hand.z], now);
    let caught = false;
    const centre = { skill: "silencio" as const, x: chest.x, z: chest.z };
    if (!bossFight.on)
      for (const d of liveDummies) {
        if (d.mob !== undefined || d.herzie !== undefined) continue;
        const radius = DUMMY.radius * (d.size ?? 1);
        if (!inSlamReach(centre, d.x, d.z, radius)) continue;
        bleedDummy(
          "silencio",
          d.key,
          skillValue("silencio", level),
          SKILL_DEFS.silencio.durationMs ?? 0,
          me,
          now,
        );
        caught = true;
      }
    sfxSilencio();
    kick(caught ? 0.14 : 0.1);
    shake(0.16);
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
    onHit: ({ disc, dummy, point, bounce }) => {
      const now = performance.now();
      if (!disc.mine) {
        hitDummy(dummy, disc.dir[0], disc.dir[2], 100, false, now, false);
        waveField.burst(point, disc.dir, "hit");
        sfxImpact("hit");
        return "hit";
      }
      // A Shuffle's bounces hit for less each time (in a fight the server
      // rolls them; this is practice, and the show).
      const scale = DISC_DAMAGE * shuffleScale(bounce);
      const kind = myHit(dummy, disc.dir, point, scale, now);
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
      const from = reachFrom;
      from.x = chest.x;
      from.z = chest.z;
      const body = reachBody;
      let reach = false;
      for (const d of liveDummies) {
        body.x = d.x;
        body.z = d.z;
        body.radius = DUMMY.radius * (d.size ?? 1);
        if (meleeReaches(from, yaw, body)) {
          reach = true;
          break;
        }
      }
      if (!reach && inBossRoom()) {
        bossNow(undefined, bossScratch);
        body.x = bossScratch.x;
        body.z = bossScratch.z;
        body.radius = BOSS_STAND.radius;
        reach = meleeReaches(from, yaw, body);
      }
      combat.inReach = reach;
    }

    // Where you are, for effects that follow you (a Cymbrella overhead).
    if (herzie) {
      herzie.root.getWorldPosition(chest);
      setSelfAt(bossFight.you ?? -1, chest.x, chest.z, chest.y + herzie.height);
    }

    // --- A class skill: pressed (or pressed just before it was ready).
    const queued = skills.queued;
    const mine = queued
      ? skills.list.find((s) => s.id === queued.id)
      : undefined;
    // A press of a skill with a motion of its own is kept a while, so one
    // pressed mid-swing can wait that swing out; any other press only a
    // moment.
    const keptFor =
      mine && OWN_MOTION[mine.id] ? SWING_QUEUE_MS : CAST_BUFFER_MS;
    if (queued && now - queued.at >= keptFor) skills.queued = null;
    // In a fight, the server judges what you do: the boss room, a duel
    // once "FIGHT!" is called, or the Wilds' free-for-all. A duel's
    // countdown (and a stun) holds you, and being knocked out (out of
    // health anywhere, or down in the Wilds) until you're back up; so does
    // the Tower's boon window while it's up.
    const brawl = wildsOn();
    const judged = bossFight.on || duelFighting(now) || brawl;
    const held = duelHeld(now) || wildsHeld(now) || youDown() || combat.picking;
    // A taunt does nothing outside a fight, nor a resurrect in a fight
    // that isn't on (the lobby, the Tower): say so rather than spend the
    // press. Outside a fight, a resurrect brings back anyone knocked out.
    const raidOn = inBossRoom() && bossFight.raid?.stage === "fight";
    const raidOnly =
      !!mine &&
      ((mine.id === "taunt" && !raidOn) ||
        (mine.id === "resurrect" && bossFight.on && !raidOn));
    const unarmed = !!mine && !skills.armed;
    // Taunt and Resurrect have no place in a duel or the Wilds; Soothing
    // Drones heal only you there, so at full health they'd be spent on
    // nothing.
    const versus = inDuel() || brawl;
    const notInDuel =
      !!mine && (mine.id === "taunt" || mine.id === "resurrect") && versus;
    const duelHp =
      mine?.id === "soothing-drones"
        ? inDuel()
          ? myDuelHp()
          : brawl
            ? myWildsHp()
            : null
        : null;
    const nothingToHeal = !!duelHp && duelHp.hp >= duelHp.maxHp;
    if (queued && mine && unarmed) {
      skills.queued = null;
      notify(instrumentNeeded(mine.id), { kind: "info" });
    } else if (queued && mine && notInDuel) {
      skills.queued = null;
      notify(
        `"${SKILL_DEFS[mine.id].name}" doesn't work ${brawl ? "on other herzies" : "in a duel"}.`,
        { kind: "info" },
      );
    } else if (queued && mine && nothingToHeal) {
      skills.queued = null;
      notify("You're at full health.", { kind: "info" });
    } else if (queued && mine && raidOnly) {
      skills.queued = null;
      notify(
        mine.id === "taunt"
          ? `"${SKILL_DEFS[mine.id].name}" only works in a boss fight.`
          : `"${SKILL_DEFS[mine.id].name}" only works once the fight is on.`,
        {
          kind: "info",
        },
      );
    } else if (
      herzie &&
      queued &&
      mine &&
      !held &&
      now - queued.at < keptFor &&
      skillReady(mine.id, now) &&
      // A skill with a motion of its own waits out a swing already going:
      // its stick's landing (its throw, its flourish) must be its own, not
      // that swing's.
      !(OWN_MOTION[mine.id] && herzie.casting)
    ) {
      skills.queued = null;
      const seq = startCooldown(mine.id, now);
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
      if (
        mine.id === "cymbrella" ||
        mine.id === "taunt" ||
        mine.id === "haste" ||
        mine.id === "shuffle" ||
        mine.id === "multispin" ||
        mine.id === "rage" ||
        mine.id === "focus"
      ) {
        setBuff(bossFight.you ?? -1, {
          buff: mine.id,
          value:
            mine.id === "taunt" || mine.id === "cymbrella"
              ? 1
              : mine.id === "shuffle"
                ? shuffleBounces(mine.level)
                : mine.id === "multispin"
                  ? multispinRecords(mine.level)
                  : skillValue(mine.id, mine.level),
          // A Cymbrella's dome stands for its value in seconds.
          until:
            now +
            (mine.id === "cymbrella"
              ? skillValue("cymbrella", mine.level) * 1000
              : skillDurationMs(mine.id, mine.level)),
        });
      }
      // A Multispin's flourish: the records flung out to circle you (the
      // buff draws them; in practice they hit the dummies, below).
      if (mine.id === "multispin") {
        a.castAt = now;
        a.live = false;
        herzie.cast(pitch, { style: "throw" });
      }
      if (mine.id === "rimshot" || mine.id === "silencio") {
        // The wind-up: planted, the stick going up and the snare rolling
        // (a Rimshot), or the lute drawn in on a held breath (a Silencio).
        // It lands as the stick strikes the ground or the lute sweeps out
        // (below), on the server's clock as on ours: sent now, landed there
        // at the wind-up's end.
        const castMs = SKILL_DEFS[mine.id].castMs ?? 0;
        a.windup = {
          skill: mine.id,
          level: mine.level,
          at: now,
          roll: (mine.id === "rimshot" ? sfxRimshotWindup : sfxSilencioWindup)(
            castMs / 1000,
          ),
        };
        a.castAt = now;
        combat.rootedUntil = now + castMs;
        herzie.cast(0, { style: WINDUP_STYLE[mine.id] });
        beginSlam(
          bossFight.you ?? -1,
          mine.id,
          chest.x,
          chest.z,
          now,
          (out) => {
            const p = herzie.handWorldPosition(v.current.held);
            out[0] = p.x;
            out[1] = p.y;
            out[2] = p.z;
            return out;
          },
        );
        if (judged) townNet().sendSkill(mine.id, seq, yaw, pitch);
      } else if (mine.id === "cymbal-trap") {
        // The throw: the cymbal off the off hand, along the aim. In a fight
        // the server finds what it meets and says (`trap`); in practice it
        // catches the first dummy in its way within its reach, rolling
        // nothing.
        const me = bossFight.you ?? -1;
        a.castAt = now;
        a.live = false;
        herzie.cast(pitch, { arm: "arm-r", style: "throw" });
        throwCymbal(me, chest.x, chest.z, yaw, now, (out) => {
          const p = herzie.heldWorldPosition("held-r", v.current.held);
          out[0] = p.x;
          out[1] = p.y;
          out[2] = p.z;
          return out;
        });
        if (judged) townNet().sendSkill(mine.id, seq, yaw, pitch);
        else {
          const caught = firstDummyAlong(
            chest,
            chest.y - herzie.height * 0.55,
            aimDirection(yaw, pitch),
            CYMBAL_TRAP.range,
          );
          if (caught) {
            const landsAt = now + cymbalLandsAfterMs(caught.dist);
            catchCymbal(
              me,
              { kind: "dummy", key: caught.dummy.key },
              landsAt + skillValue("cymbal-trap", mine.level) * 1000,
              landsAt,
            );
            a.trap = {
              dummy: caught.dummy,
              landsAt,
              dir: [Math.sin(yaw), 0, Math.cos(yaw)],
            };
          }
        }
      } else if (mine.id === "forbidden-frequency") {
        // One disc off the main hand along the aim (BleedVFX draws it from
        // the cast). In a fight the server finds what it meets and says
        // (`bleed`); in practice it bleeds the first dummy in its way,
        // within a disc's reach, as it lands.
        a.castAt = now;
        a.live = false;
        herzie.cast(pitch, { arm: DISC_ARM["held-l"], style: "throw" });
        if (judged) townNet().sendSkill(mine.id, seq, yaw, pitch);
        else {
          const caught = firstDummyAlong(
            chest,
            chest.y - herzie.height * 0.55,
            aimDirection(yaw, pitch),
            DISC_RANGE,
          );
          if (caught)
            a.bleed = {
              dummy: caught.dummy,
              landsAt: now + discLandsAfterMs(caught.dist),
              value: skillValue("forbidden-frequency", mine.level),
            };
        }
      } else if (judged || mine.id === "resurrect") {
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
      if (mine.id === "taunt") sfxTaunt();
      else if (mine.id === "haste") sfxHaste();
      else if (mine.id === "rage") sfxRage();
      else if (mine.id === "focus") sfxFocus();
      else if (mine.id === "multispin") sfxMultispin();
      else if (mine.id === "cymbrella") sfxDomeUp();
      else if (mine.id === "cymbal-trap") sfxCymbalThrow();
      else if (mine.id === "forbidden-frequency") sfxForbiddenThrow();
      else if (mine.id !== "rimshot" && mine.id !== "silencio") sfxCast();
      if (mine.id !== "rimshot" && mine.id !== "silencio")
        shake(mine.id === "cymbrella" ? 0.22 : 0.15);
    }

    // Practice: your cymbal lands on its dummy, a stick's strike's blow.
    const trap = a.trap;
    if (trap && now >= trap.landsAt) {
      a.trap = null;
      const d = trap.dummy;
      if (liveDummies.includes(d)) {
        const radius = DUMMY.radius * (d.size ?? 1);
        const point: Vec3 = [
          d.x - trap.dir[0] * radius,
          (d.y ?? 0) + DUMMY.chest,
          d.z - trap.dir[2] * radius,
        ];
        const kind = myHit(
          d,
          trap.dir,
          point,
          CYMBAL_TRAP.damage * STRIKE_DAMAGE,
          now,
        );
        waveField.burst(point, trap.dir, kind);
        sfxCymbalClang();
      }
    }

    // Practice: your Forbidden Frequency disc lands on its dummy, a stack
    // of bleed more; and every dummy's bleeds (Forbidden Frequency's and
    // Silencio's) hit, their share of a wave each hit, quicker with each
    // stack (bleedEveryMs), never a crit.
    const bleed = a.bleed;
    if (bleed && now >= bleed.landsAt) {
      a.bleed = null;
      if (liveDummies.includes(bleed.dummy)) {
        bleedDummy(
          "forbidden-frequency",
          bleed.dummy.key,
          bleed.value,
          SKILL_DEFS["forbidden-frequency"].durationMs ?? 0,
          bossFight.you ?? -1,
          now,
        );
        sfxBleedStack();
      }
    }
    for (const skill of BLEED_SKILLS)
      for (const b of bleeds[skill].dummies.values()) {
        if (b.target.kind !== "dummy" || now < b.nextTick) continue;
        const key = b.target.key;
        const d = liveDummies.find((x) => x.key === key);
        if (!d || b.nextTick > b.until) continue;
        b.nextTick += bleedEveryMs(b.stacks);
        const point: Vec3 = [d.x, (d.y ?? 0) + DUMMY.chest + 0.3, d.z];
        myHit(d, [0, 0, 0], point, b.value, now, true);
      }

    // Practice: your Multispin's records hit the dummies they touch, each
    // a share of a wave, a record a dummy at most once every rehitMs: as
    // the server judges them in a fight. A record touches a dummy its disc
    // overlaps, or one standing inside its ring as it sweeps past that
    // dummy's bearing.
    const spin =
      herzie && !judged
        ? buffOn(bossFight.you ?? -1, "multispin", now)
        : undefined;
    if (herzie && spin) {
      herzie.root.getWorldPosition(chest);
      const n = Math.round(spin.value);
      const elapsed =
        now - (spin.until - (SKILL_DEFS.multispin.durationMs ?? 0));
      const y = chest.y + herzie.height * 0.55;
      for (let i = 0; i < n; i++) {
        const o = multispinOffset(i, n, elapsed);
        const rx = chest.x + o.x;
        const rz = chest.z + o.z;
        const angle = Math.atan2(o.z, o.x);
        for (const d of liveDummies) {
          if (d.mob !== undefined || d.herzie !== undefined) continue;
          const reach = MULTISPIN.recordRadius + DUMMY.radius * (d.size ?? 1);
          const fromMe = Math.hypot(d.x - chest.x, d.z - chest.z);
          const bearing = Math.atan2(d.z - chest.z, d.x - chest.x) - angle;
          const off = Math.abs(
            Math.atan2(Math.sin(bearing), Math.cos(bearing)),
          );
          const touches =
            Math.hypot(d.x - rx, d.z - rz) <= reach ||
            (fromMe < MULTISPIN.radius &&
              off <= Math.atan2(reach, MULTISPIN.radius));
          if (!touches) continue;
          let last = spinTouches.get(d);
          if (!last || last.length < n) {
            last = new Float64Array(Math.max(n, 10)).fill(
              Number.NEGATIVE_INFINITY,
            );
            spinTouches.set(d, last);
          }
          if (now - last[i] < MULTISPIN.rehitMs) continue;
          last[i] = now;
          const toward = flatToward(chest, d);
          const point: Vec3 = [rx, y, rz];
          const kind = myHit(d, toward, point, MULTISPIN.damage, now);
          waveField.burst(point, toward, kind);
        }
      }
    }

    // --- Casting: a wave from the hand; a Record Slinger's disc thrown
    // from whichever hand has one; or a blow up close — a Percussionist's
    // stick, or (without its instrument) a punch from stage 3, a body slam
    // before that.
    const discs = combat.attack === "disc";
    const melee = combat.attack === "melee";
    const blow = combat.blow;
    // A Bard's lute in its heal stance: locked onto the ally nearest the
    // aim (never yourself, never the knocked out: they need a Resurrect).
    // In a duel or the Wilds it only ever attacks.
    const heals = combat.on && combat.attack === "wave" && healing() && !versus;
    stance.lock = null;
    if (herzie && heals) {
      herzie.root.getWorldPosition(chest);
      chest.y += herzie.height * 0.55;
      dir.copy(a.point).sub(chest).normalize();
      const me = bossFight.you ?? -1;
      let n = 0;
      for (const [id, at] of entityAt) {
        if (id === me || id === -1) continue;
        if (entityDown(id)) continue;
        allyPool[n] ??= { id: 0, x: 0, z: 0 };
        const ally = allyPool[n];
        ally.id = id;
        ally.x = at.x;
        ally.z = at.z;
        allies[n++] = ally;
      }
      allies.length = n;
      stance.lock =
        healTarget([chest.x, chest.y, chest.z], [dir.x, dir.y, dir.z], allies)
          ?.ally.id ?? null;
    }
    // Hasted, or with Timing (a Focus adds to yours), or the Tower's speed
    // boons: the pace and the motion quicken together. They multiply, as
    // the server's cast budget does.
    const boons = bossFight.tower?.boons;
    const speed =
      attackSpeedOf(bossFight.you ?? -1, now) *
      (1 +
        timingAttackSpeed(
          (statsRef.current.timing ?? 0) + focusOf(bossFight.you ?? -1, now),
        )) *
      (boons?.length ? 1 + towerBoonTotals(boons).speed : 1);
    if (herzie) herzie.castRate = speed;
    if (herzie) {
      const queued = now - combat.queuedAt < CAST_BUFFER_MS;
      const free = discs ? nextHand(discField, herzie) : null;
      // Nothing else starts while a Rimshot or a Silencio winds up and
      // lands.
      const slamming =
        herzie.casting &&
        (herzie.castMotion === "slam" || herzie.castMotion === "hush");
      // Held for a duel's countdown, or stunned in one: nothing goes off.
      const ready =
        !slamming &&
        !held &&
        ((now - a.castAt) / 1000) * speed >= CAST_INTERVAL &&
        (!discs || free !== null);
      if (combat.on && (queued || combat.fireHeld) && ready && discs && free) {
        a.castAt = now;
        a.live = true;
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
        a.live = true;
        a.bolt = heals ? stance.lock : null;
        a.freeHeal = heals && stance.lock === null;
        combat.queuedAt = Number.NEGATIVE_INFINITY;
        herzie.root.getWorldPosition(chest);
        chest.y += herzie.height * 0.55;
        const dx = a.point.x - chest.x;
        const dz = a.point.z - chest.z;
        const flat = Math.hypot(dx, dz);
        // Face the aim, and raise the hand to it.
        if (flat > 0.5) herzie.heading = Math.atan2(dx, dz);
        if (melee) {
          // Punches alternate fists, a jab-cross rhythm.
          herzie.cast(0, {
            style: blow,
            ...(blow === "punch"
              ? { arm: combat.casts & 1 ? "arm-r" : "arm-l" }
              : {}),
          });
          if (blow === "strike") slashField.strike(herzie, true);
          combat.spread = 0.4;
          sfxSwing(blow);
        } else {
          herzie.cast(Math.atan2(a.point.y - chest.y, Math.max(flat, 0.5)));
          combat.spread = 1;
          if (!heals) sfxCharge();
        }
        combat.casts = (combat.casts + 1) & 0xffff;
      }
      // A Rimshot or a Silencio: the stick strikes the ground (the lute
      // sweeps out) and it lands; or the server cut the wind-up short
      // (knocked out, refused), and it never does.
      const w = a.windup;
      if (w && herzie.released && herzie.castMotion === WINDUP_STYLE[w.skill]) {
        if (w.skill === "rimshot")
          slamLands(herzie, skillValue("rimshot", w.level), now);
        else silencioLands(herzie, w.level, now);
        a.windup = null;
      } else if (
        w &&
        (!pendingSlam(bossFight.you ?? -1) ||
          now - w.at > (SKILL_DEFS[w.skill].castMs ?? 0) + 800)
      ) {
        herzie.cancelCast();
        combat.rootedUntil = Number.NEGATIVE_INFINITY;
        w.roll.stop();
        cancelSlam(bossFight.you ?? -1);
        a.windup = null;
      }
      // The blow lands: whatever's in front of it, in reach, is hit.
      else if (
        herzie.released &&
        a.live &&
        melee &&
        herzie.castMotion !== "slam"
      ) {
        herzie.root.getWorldPosition(chest);
        const yaw = herzie.heading;
        const from = { x: chest.x, z: chest.z };
        const height = herzie.height * (blow === "strike" ? 0.6 : 0.4);
        let landed = false;
        // Nearest first: it takes the blow in full, the rest the cleave's
        // share, as the server judges a blow through a pack.
        const struck = liveDummies
          .filter((d) =>
            meleeReaches(from, yaw, {
              ...d,
              radius: DUMMY.radius * (d.size ?? 1),
            }),
          )
          .sort(
            (p, q) =>
              Math.hypot(p.x - from.x, p.z - from.z) -
              Math.hypot(q.x - from.x, q.z - from.z),
          );
        for (const [i, d] of struck.entries()) {
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
            meleeDamage(blow) * (i === 0 ? 1 : MELEE_CLEAVE),
            now,
          );
          waveField.burst(point, toward, kind);
          landed = true;
        }
        if (judged) {
          // The server judges it, and says what it did (the number, the
          // sound); the burst is what you see land.
          townNet().sendCast(yaw, 0);
          const boss = { ...BOSS_STAND, ...bossNow() };
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
          combat.meleeFeltAt = now;
        }
        shake(landed ? 0.1 : 0.03);
      }
      // The hand is out: the disc leaves it.
      if (herzie.released && a.live && discs) {
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
        const bossAt = bossNow();
        const onBoss =
          inBossRoom() &&
          Math.hypot(a.point.x - bossAt.x, a.point.z - bossAt.z) <
            BOSS_STAND.radius + 0.8;
        // The boss by the server's own rule (aim assist and its whole body,
        // from where sendBossCast aims): a throw that grazes it hits it
        // here too, rather than flying past while the number comes in.
        let assisted: number | null = null;
        if (inBossRoom() && !target && !(solid && onBoss)) {
          herzie.root.getWorldPosition(chest);
          const ox = chest.x;
          const oz = chest.z;
          const ax = a.point.x - ox;
          const ay = a.point.y - WAVE_HAND_HEIGHT;
          const az = a.point.z - oz;
          const len = Math.hypot(ax, ay, az) || 1;
          assisted = bossReaches(
            [ox, WAVE_HAND_HEIGHT, oz],
            [ax / len, ay / len, az / len],
            DISC_RANGE,
            bossAt,
          );
          // A wall nearer than it is still where it turns.
          if (assisted !== null && solid && toAim < assisted) assisted = null;
        }
        discField.throw(from, toward, {
          mine: true,
          owner: herzie,
          hand: h,
          reach: assisted ?? (solid ? toAim : DISC_RANGE),
          strike:
            assisted !== null
              ? "target"
              : solid
                ? onBoss
                  ? "target"
                  : "wall"
                : null,
          target,
          quick: speed,
          bounces: shuffleOf(bossFight.you ?? -1, now),
        });
        if (judged) sendBossCast(herzie, a.point);
        shake(0.04);
      }
      // The hand is out: the wave leaves it (Player's update, last frame).
      const ally = a.bolt === null ? undefined : entityAt.get(a.bolt);
      if (herzie.released && a.live && combat.attack === "wave" && ally) {
        // A heal bolt: off to the ally it locked onto, homing on them.
        herzie.handWorldPosition(hand);
        dir
          .set(ally.x, ally.top * 0.55, ally.z)
          .sub(hand)
          .normalize();
        waveField.cast([hand.x, hand.y, hand.z], [dir.x, dir.y, dir.z], {
          mine: true,
          heal: true,
          ally: a.bolt,
        });
        // The server finds the same ally down the same line: aimed from
        // where it thinks the hand is at their chest.
        if (bossFight.on)
          sendBossCast(herzie, boltAim.set(ally.x, HEAL_TARGET_HEIGHT, ally.z));
        a.bolt = null;
        sfxHealBolt();
        shake(0.02);
      } else if (herzie.released && (a.freeHeal || a.bolt !== null)) {
        // A heal bolt with nobody to go to (none under the crosshair, or
        // its ally left before it went): it still flies, down the aim, but
        // heals no one, so the server isn't told.
        a.bolt = null;
        a.freeHeal = false;
        herzie.handWorldPosition(hand);
        dir.copy(a.point).sub(hand);
        const toAim = dir.length();
        dir.normalize();
        waveField.cast([hand.x, hand.y, hand.z], [dir.x, dir.y, dir.z], {
          mine: true,
          heal: true,
          ally: null,
          reach: a.blocked ? toAim + 0.2 : WAVE.range,
        });
        sfxHealBolt();
        shake(0.02);
      } else if (herzie.released && a.live && combat.attack === "wave") {
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
        // In a fight (the boss room, a duel), the server does the hitting:
        // tell it the aim.
        if (judged) sendBossCast(herzie, a.point);
        sfxCast();
        shake(0.05);
      }
      // Let go (or cut short, a Rimshot's or a knock-out's): done.
      if (herzie.released || !herzie.casting) a.live = false;
    }

    // --- Waves in flight, and what they hit. A crit's hit-stop holds them
    // near-still for a beat.
    const slow = now < combat.slowUntil ? HIT_STOP_SCALE : 1;
    waveField.step(
      dt,
      liveDummies,
      ({ wave, dummy, point }) => {
        if (!wave.mine) {
          hitDummy(dummy, wave.dir[0], wave.dir[2], 100, false, now, false);
          sfxImpact("hit");
          return "hit";
        }
        return myHit(dummy, wave.dir, point, wave.scale, now);
      },
      slow,
    );
    // Discs in flight, anyone's; and the sounds of yours turning and
    // glancing off walls.
    discField.step(dt, liveDummies, discHooks.current, slow);
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
        // A Cymbal Trap's cymbal is out of the off hand too.
        herzie.setHeldHidden(
          h,
          out || (h === "held-r" && cymbalOut(bossFight.you ?? -1, now)),
        );
        combat.discs.in[h] = !out;
      }
    }
    combat.spread = Math.max(0, combat.spread - dt * 4);
  }, -2.5);

  return null;
}

const castFrom = new THREE.Vector3();
const boltAim = new THREE.Vector3();

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

/** Practice: the first plain dummy a throw from over `from` (its herzie's
 * feet at `feet`) going `toward` meets within `range`, and how far along:
 * by the rule the server judges a thrown disc or cymbal by. */
function firstDummyAlong(
  from: { x: number; z: number },
  feet: number,
  toward: Readonly<Vec3>,
  range: number,
): { dummy: DummyState; dist: number } | null {
  let best: { dummy: DummyState; dist: number } | null = null;
  for (const d of liveDummies) {
    if (d.mob !== undefined || d.herzie !== undefined) continue;
    const dist = bodyHitAt(
      [from.x, feet - (d.y ?? 0) + WAVE_HAND_HEIGHT, from.z],
      toward,
      {
        x: d.x,
        z: d.z,
        radius: DUMMY.radius * (d.size ?? 1),
        chest: DUMMY.chest,
        top: DUMMY.top,
      },
      range,
    );
    if (dist !== null && (!best || dist < best.dist)) best = { dummy: d, dist };
  }
  return best;
}

/** Out of combat mode, letting the mouse go. */
function leave() {
  exitMouseLook();
  setCombat(false);
}

/** Out of combat mode, from outside it (the boss's end screen). */
export const leaveCombat = leave;
