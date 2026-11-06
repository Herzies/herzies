import {
  BACKSPIN_DISCS,
  BACKSPIN_SPREAD,
  CAST_INTERVAL_MS,
  type HerzieStats,
  hitDamage,
  RIMSHOT,
  SKILL_DEFS,
  shuffleBounces,
  shuffleScale,
  skillValue,
  timingAttackSpeed,
} from "@herzies/shared";
import {
  BOSS_STAND,
  bossReaches,
  DISC_DAMAGE,
  DISC_RANGE,
  HEAL_TARGET_HEIGHT,
  healTarget,
  meleeDamage,
  meleeReaches,
  STRIKE_DAMAGE,
  WAVE_HAND_HEIGHT,
} from "@herzies/shared/combat";
import type { HerzieModel } from "@herzies/shared/gl";
import { useFrame, useThree } from "@react-three/fiber";
import { useRapier } from "@react-three/rapier";
import { useEffect, useRef } from "react";
import * as THREE from "three";
import { notify } from "../../../lib/notices";
import { entityDown } from "../downed";
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
  sfxDomeUp,
  sfxHaste,
  sfxHealBolt,
  sfxImpact,
  sfxMeleeHit,
  sfxRimshotSlam,
  sfxRimshotWindup,
  sfxStun,
  sfxSwing,
  sfxTaunt,
} from "../sfx";
import { getVitals, useVitals } from "../vitals";
import { pushDamageNumber, pushStunLabel } from "./DamageNumbers";
import { liveDummies } from "./Dummies";
import {
  DISC_ARM,
  type DiscHand,
  type DiscHooks,
  discField,
  nextHand,
} from "./discs";
import { DUMMY, type DummyState, hitDummy, meterDps } from "./dummy";
import { bossFight, bossNow } from "./fight";
import { enterMouseLook, exitMouseLook } from "./mouseLook";
import {
  attackSpeedOf,
  entityAt,
  instrumentNeeded,
  noteSkillCast,
  queueSkill,
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
} from "./slams";
import { slashField } from "./slashes";
import { healing, stance, toggleStance, useStanceSender } from "./stance";
import { CAST_BUFFER_MS, combat, kick, setCombat, shake } from "./state";
import { stuns } from "./stuns";
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
const HIT_STOP_MS = 65;
const HANDS: readonly DiscHand[] = ["held-l", "held-r"];
/** A Rimshot's hold on the slam (a plain strike holds 70 ms): the
 * heaviest blow there is, so it holds the longest. */
const SLAM_HITSTOP_S = 0.12;
/** How long a Rimshot pressed mid-swing is kept for, waiting out that
 * swing (any other press: CAST_BUFFER_MS). */
const RIMSHOT_QUEUE_MS = 1_000;

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
  useStanceSender();
  const { world, rapier } = useRapier();
  const camera = useThree((s) => s.camera);
  const surface = useThree((s) => s.gl.domElement);
  const statsRef = useRef(stats);
  statsRef.current = stats;
  // Aim mode works anywhere in the Town, not just where there's something
  // to fight (map.combat).
  const canFight = active;

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
      } else if (e.code === "KeyQ" && !e.repeat && skills.list.length) {
        // Q stays a shortcut for your first class skill, wherever it sits
        // on the hotbar (its number key is the hotbar's: town/input.ts).
        e.preventDefault();
        queueSkill(1);
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
    /** A Rimshot winding up: its stun chance, when it was pressed, and its
     * snare roll (cut if the wind-up is). */
    rimshot: null as null | {
      chance: number;
      at: number;
      roll: { stop(): void };
    },
    /** A heal bolt under way with nobody locked: it flies down the aim,
     * for show (it heals no one). */
    freeHeal: false,
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

  /**
   * A Rimshot's slam, as the stick strikes the ground: the shockwave and the
   * rest of the show (SlamVFX), a heavy hold on the contact, the camera's
   * jolt and the boom. On the training grounds every dummy within reach
   * takes twice a strike, rocked back from the middle, and rolls its own
   * stun; in a fight the server judges it all (the room hears of hits and
   * stuns with its next word).
   */
  const slamLands = (herzie: HerzieModel, chance: number, now: number) => {
    const { chest, held } = v.current;
    herzie.root.getWorldPosition(chest);
    const centre = { x: chest.x, z: chest.z };
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
      if (d.mob === undefined && !bossFight.on && Math.random() < chance) {
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
    // A Rimshot's press is kept a while, so one pressed mid-swing can wait
    // that swing out; any other press only a moment.
    const keptFor = mine?.id === "rimshot" ? RIMSHOT_QUEUE_MS : CAST_BUFFER_MS;
    if (queued && now - queued.at >= keptFor) skills.queued = null;
    // A taunt does nothing outside a fight, nor a resurrect in a fight
    // that isn't on (the lobby, the Tower): say so rather than spend the
    // press. Outside a fight, a resurrect brings back anyone knocked out.
    const raidOn = inBossRoom() && bossFight.raid?.stage === "fight";
    const raidOnly =
      !!mine &&
      ((mine.id === "taunt" && !raidOn) ||
        (mine.id === "resurrect" && bossFight.on && !raidOn));
    const unarmed = !!mine && !skills.armed;
    if (queued && mine && unarmed) {
      skills.queued = null;
      notify(instrumentNeeded(mine.id), { kind: "info" });
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
      now - queued.at < keptFor &&
      skillReady(mine.id, now) &&
      // A Rimshot waits out a swing already going: its stick's landing
      // must be its own, not that swing's.
      !(mine.id === "rimshot" && herzie.casting)
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
        mine.id === "shuffle"
      ) {
        setBuff(bossFight.you ?? -1, {
          buff: mine.id,
          value:
            mine.id === "taunt" || mine.id === "cymbrella"
              ? 1
              : mine.id === "shuffle"
                ? shuffleBounces(mine.level)
                : skillValue(mine.id, mine.level),
          // A Cymbrella's dome stands for its value in seconds.
          until:
            now +
            (mine.id === "cymbrella"
              ? skillValue("cymbrella", mine.level) * 1000
              : (SKILL_DEFS[mine.id].durationMs ?? 0)),
        });
      }
      if (mine.id === "rimshot") {
        // The wind-up: planted, the stick going up, the snare rolling. It
        // lands when the stick strikes the ground (below), on the server's
        // clock as on ours: sent now, landed there at the wind-up's end.
        const castMs = SKILL_DEFS.rimshot.castMs ?? 0;
        a.rimshot = {
          chance: skillValue("rimshot", mine.level),
          at: now,
          roll: sfxRimshotWindup(castMs / 1000),
        };
        a.castAt = now;
        combat.rootedUntil = now + castMs;
        herzie.cast(0, { style: "slam" });
        beginSlam(bossFight.you ?? -1, chest.x, chest.z, now, (out) => {
          const p = herzie.handWorldPosition(v.current.held);
          out[0] = p.x;
          out[1] = p.y;
          out[2] = p.z;
          return out;
        });
        if (bossFight.on) townNet().sendSkill(mine.id, seq, yaw, pitch);
      } else if (bossFight.on || mine.id === "resurrect") {
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
      else if (mine.id === "cymbrella") sfxDomeUp();
      else if (mine.id !== "rimshot") sfxCast();
      if (mine.id !== "rimshot") shake(mine.id === "cymbrella" ? 0.22 : 0.15);
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
    const heals = combat.on && combat.attack === "wave" && healing();
    stance.lock = null;
    if (herzie && heals) {
      herzie.root.getWorldPosition(chest);
      chest.y += herzie.height * 0.55;
      dir.copy(a.point).sub(chest).normalize();
      const me = bossFight.you ?? -1;
      const allies: { id: number; x: number; z: number }[] = [];
      for (const [id, at] of entityAt) {
        if (id === me || id === -1) continue;
        if (entityDown(id)) continue;
        allies.push({ id, x: at.x, z: at.z });
      }
      stance.lock =
        healTarget([chest.x, chest.y, chest.z], [dir.x, dir.y, dir.z], allies)
          ?.ally.id ?? null;
    }
    // Hasted, or with Timing: the pace and the motion quicken together. The
    // two multiply, as the server's cast budget does.
    const speed =
      attackSpeedOf(bossFight.you ?? -1, now) *
      (1 + timingAttackSpeed(statsRef.current.timing));
    if (herzie) herzie.castRate = speed;
    if (herzie) {
      const queued = now - combat.queuedAt < CAST_BUFFER_MS;
      const free = discs ? nextHand(discField, herzie) : null;
      // Nothing else starts while a Rimshot winds up and lands.
      const slamming = herzie.casting && herzie.castMotion === "slam";
      const ready =
        !slamming &&
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
      // A Rimshot: the stick strikes the ground and it lands; or the server
      // cut the wind-up short (knocked out), and it never does.
      const r = a.rimshot;
      if (r && herzie.released && herzie.castMotion === "slam") {
        slamLands(herzie, r.chance, now);
        a.rimshot = null;
      } else if (
        r &&
        (!pendingSlam(bossFight.you ?? -1) ||
          now - r.at > (SKILL_DEFS.rimshot.castMs ?? 0) + 800)
      ) {
        herzie.cancelCast();
        combat.rootedUntil = Number.NEGATIVE_INFINITY;
        r.roll.stop();
        cancelSlam(bossFight.you ?? -1);
        a.rimshot = null;
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
        for (const d of liveDummies) {
          if (
            !meleeReaches(from, yaw, {
              ...d,
              radius: DUMMY.radius * (d.size ?? 1),
            })
          )
            continue;
          const toward = flatToward(from, d);
          const point: Vec3 = [
            d.x - toward[0] * DUMMY.radius,
            Math.min(DUMMY.chest, height),
            d.z - toward[2] * DUMMY.radius,
          ];
          const kind = myHit(d, toward, point, meleeDamage(blow), now);
          waveField.burst(point, toward, kind);
          landed = true;
        }
        if (bossFight.on) {
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
        if (bossFight.on) sendBossCast(herzie, a.point);
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
        // In the boss room, the server does the hitting: tell it the aim.
        if (bossFight.on) sendBossCast(herzie, a.point);
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
        herzie.setHeldHidden(h, out);
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

/** Out of combat mode, letting the mouse go. */
function leave() {
  exitMouseLook();
  setCombat(false);
}

/** Out of combat mode, from outside it (the boss's end screen). */
export const leaveCombat = leave;
