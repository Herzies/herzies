import {
  basicAttack,
  blankState,
  TOWN_FLAG_AFK,
  TOWN_FLAG_COMBAT,
  TOWN_FLAG_DANCING,
  TOWN_FLAG_JUMP,
  TOWN_FLAG_SITTING,
} from "@herzies/shared";
import {
  BOSS_STAND,
  HEAL_LOCK_ANGLE,
  HERZIE_BODY,
  healTarget,
  meleeReaches,
} from "@herzies/shared/combat";
import { HerzieModel, ICE_SPEED } from "@herzies/shared/gl";
import { Html } from "@react-three/drei";
import { useFrame, useThree } from "@react-three/fiber";
import { type RefObject, useEffect, useMemo, useRef } from "react";
import {
  type Group,
  type Object3D,
  Raycaster,
  Sphere,
  Vector2,
  Vector3,
} from "three";
import { GmMark } from "../GmMark";
import { standY } from "./airship/boarding";
import { onDeck } from "./airship/deck";
import { ambient, seasonNow } from "./ambient";
import { SEAT_Y } from "./Benches";
import { BUBBLE_RANGE, type ChatBubble, type ChatBubbles } from "./chatBubbles";
import { clothDetailAt } from "./clothDetail";
import { bleedStacks } from "./combat/bleeds";
import { liveDummies } from "./combat/Dummies";
import {
  DISC_ARM,
  type DiscHand,
  discField,
  nextHand as nextFreeHand,
} from "./combat/discs";
import { DUMMY, type DummyState, hitDummy, newTarget } from "./combat/dummy";
import { bossFight, bossNow } from "./combat/fight";
import {
  attackSpeedOf,
  entityAt,
  setEntityAt,
  shuffleOf,
  skills,
} from "./combat/skills";
import { landSlam, pendingSlam } from "./combat/slams";
import { slashField } from "./combat/slashes";
import { stance } from "./combat/stance";
import { shake } from "./combat/state";
import { cymbalOut, trapBy } from "./combat/traps";
import { assistTarget, type Vec3, waveField } from "./combat/waves";
import { applyDowned, entityDown } from "./downed";
import { fighterPace, poseFighter } from "./duel/fx";
import { PlayerMenu } from "./duel/PlayerMenu";
import {
  duel,
  duelFighting,
  duelOf,
  myOpponent,
  openPlayerMenu,
  ringOf,
  useDuelValue,
} from "./duel/store";
import { footprints, Trail } from "./footprints";
import { HeadBubble } from "./HeadBubble";
import { groundY, type TownMap, worldRadius } from "./map";
import { onIce, petFooting } from "./movement";
import { NAME_SHADOW, nearestIds, REMOTE_LABEL, remoteLabel } from "./nameFade";
import type { RemotePlayer, TownConnection } from "./net/TownConnection";
import { useTownNetVersion } from "./net/townNet";
import { townSave, useTownRuntime } from "./runtime";
import { sfxRimshotSlam, sfxSilencio } from "./sfx";
import { titleName } from "./TitleLine";
import { wildsBarOf, wildsDown, wildsFoe } from "./wilds/store";

/** What every label reads: the herzie the pointer's on, and the nearest
 * few, who are named (REMOTE_LABEL.nearest). */
const labels = {
  hovered: null as number | null,
  ranked: new Set<number>(),
};
/** How often the nearest are worked out again (ms). */
const RANK_MS = 250;

/** Each herzie's name tag, by entity id: where E opens its menu. */
const tags = new Map<number, RefObject<HTMLButtonElement | null>>();

/** E by herzie `id`: its menu, as a click on its name would open it, just
 * under the name (or mid-screen, with no name drawn to put it by). */
export function openPlayerMenuByName(id: number): void {
  const r = tags.get(id)?.current?.getBoundingClientRect();
  if (r && r.width > 0) openPlayerMenu(id, r.left, r.bottom + 2);
  else openPlayerMenu(id, window.innerWidth / 2, window.innerHeight / 2);
}

/** Out of the dummies' list. */
function dropTarget(t: DummyState) {
  const i = liveDummies.indexOf(t);
  if (i >= 0) liveDummies.splice(i, 1);
}

/** Everyone else in the Town. */
export function RemotePlayers({
  map,
  net,
  bubbles,
  onOpenProfile,
  frame = null,
}: {
  /** The island they're on with you: its ground's ups and downs. */
  map: TownMap;
  net: TownConnection;
  /** Their menu's "Profile" opens it (by friend code). */
  onOpenProfile?: (friendCode: string) => void;
  /** What people are saying, by friend code. */
  bubbles?: ChatBubbles;
  /** On a sky ship's deck: the deck's group (they're drawn inside it, in
   * its coordinates), the space their cats and companions live in. */
  frame?: Object3D | null;
}) {
  useTownNetVersion(net);
  return (
    <>
      <LabelTracker net={net} />
      {[...net.remotes.values()].map((r) => (
        <RemoteHerzie
          key={r.id}
          map={map}
          remote={r}
          net={net}
          bubble={bubbles?.get(r.look.seed)}
          onOpenProfile={onOpenProfile}
          frame={frame}
        />
      ))}
    </>
  );
}

/**
 * Keeps {@link labels} up: which herzies are nearest (every RANK_MS), and
 * which one the pointer's over (its body, roughly a ball round its middle;
 * the name tag says so itself).
 */
function LabelTracker({ net }: { net: TownConnection }) {
  const camera = useThree((s) => s.camera);
  const surface = useThree((s) => s.gl.domElement);
  const rankedAt = useRef(0);
  const spots = useMemo<[number, { x: number; z: number }][]>(() => [], []);
  useFrame(() => {
    const now = performance.now();
    if (now - rankedAt.current < RANK_MS) return;
    rankedAt.current = now;
    spots.length = 0;
    for (const id of net.remotes.keys()) {
      const at = entityAt.get(id);
      if (at) spots.push([id, at]);
    }
    nearestIds(
      spots,
      townSave.x,
      townSave.z,
      REMOTE_LABEL.nearest,
      labels.ranked,
    );
  });
  useEffect(() => {
    const host = surface.parentElement;
    if (!host) return;
    const ray = new Raycaster();
    const ndc = new Vector2();
    const ball = new Sphere();
    const onMove = (e: PointerEvent) => {
      // Over a name tag: that one says (see its pointerenter).
      if (e.target !== surface) return;
      const r = surface.getBoundingClientRect();
      ndc.set(
        ((e.clientX - r.left) / r.width) * 2 - 1,
        -((e.clientY - r.top) / r.height) * 2 + 1,
      );
      ray.setFromCamera(ndc, camera);
      let best: number | null = null;
      let bestAlong = Number.POSITIVE_INFINITY;
      for (const id of net.remotes.keys()) {
        const at = entityAt.get(id);
        if (!at) continue;
        ball.center.set(at.x, at.top - 0.6, at.z);
        ball.radius = 0.75;
        if (!ray.ray.intersectsSphere(ball)) continue;
        const along = ray.ray.origin.distanceTo(ball.center);
        if (along < bestAlong) {
          bestAlong = along;
          best = id;
        }
      }
      labels.hovered = best;
    };
    const onLeave = () => {
      labels.hovered = null;
    };
    host.addEventListener("pointermove", onMove);
    surface.addEventListener("pointerleave", onLeave);
    return () => {
      host.removeEventListener("pointermove", onMove);
      surface.removeEventListener("pointerleave", onLeave);
    };
  }, [camera, surface, net]);
  return null;
}

/** The labels' styles, written only when they change: every remote's
 * are set every frame, and a style written is the page's to restyle. */
function setStyle(
  el: HTMLElement,
  prop: "display" | "visibility" | "pointerEvents",
  value: string,
) {
  if (el.style[prop] !== value) el.style[prop] = value;
}

/** The opacity last written to each label (read back, it's a string). */
const opacities = new WeakMap<HTMLElement, number>();
function setOpacity(el: HTMLElement, value: number) {
  if (opacities.get(el) === value) return;
  opacities.set(el, value);
  el.style.opacity = String(value);
}

/**
 * Another player's herzie, drawn a moment in the past between the states
 * the server sent (see ServerClock/EntityBuffer), walking at the speed it
 * really went so its feet keep pace. No collider: players pass through each
 * other, as in most social spaces, rather than shoving each other about on
 * stale positions.
 */
function RemoteHerzie({
  map,
  remote,
  net,
  bubble,
  onOpenProfile,
  frame,
}: {
  map: TownMap;
  remote: RemotePlayer;
  net: TownConnection;
  bubble?: ChatBubble;
  onOpenProfile?: (friendCode: string) => void;
  frame: Object3D | null;
}) {
  const { look } = remote;
  const lookKey = JSON.stringify(look);
  const rt = useTownRuntime();
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed on the look's content
  const herzie = useMemo(
    () => new HerzieModel(look, { seed: remote.id * 7, lighting: ambient }),
    [lookKey, remote.id],
  );
  useEffect(() => {
    herzie.setFrame(frame);
  }, [herzie, frame]);
  useEffect(() => {
    // Its cat spirit (if it has one) walks the same ground, round water
    // (or out on it, frozen over, where its feet slip) — or, on a deck,
    // inside the rail.
    herzie.groundAt = (x, z) => groundY(map, x, z);
    const footing = map.ship
      ? null
      : petFooting(map, worldRadius(map), () => seasonNow.look.ice);
    herzie.walkable = footing?.walkable ?? onDeck;
    herzie.icy = footing?.icy ?? null;
  }, [herzie, map]);
  useEffect(() => {
    herzie.root.visible = false;
    return () => {
      discField.recall(herzie);
      slashField.forget(herzie);
      herzie.dispose();
    };
  }, [herzie]);
  // A Record Slinger throws its discs, a hand at a time; the server only
  // says how many casts, so which hand is guessed (as Combat picks). A
  // Percussionist strikes with its stick; without its instrument a herzie
  // punches (stage 3+) or slams into things. Their class isn't known here:
  // the instrument in hand tells.
  const { style: attack, blow } = basicAttack({
    cls: undefined,
    stage: look.stage,
    mainHand: look.equipped?.main_hand,
  });
  const throwsDiscs = attack === "disc";
  const nextHand = useRef<DiscHand>("held-r");
  /** Their punches so far: they alternate fists. */
  const punches = useRef(0);
  /** When their last Rimshot began (performance.now() ms), and whether
   * the one under way has landed (its wind-up's off the list then). */
  const rimshotAt = useRef(performance.now());
  const slammed = useRef(false);
  /** When their last Cymbal Trap was thrown and Multispin flung, and
   * whether the cast under way is one of those (its release lets go of a
   * cymbal or records, which their VFX draw: not a blow, nor a disc). */
  const trapAt = useRef(performance.now());
  const flourishAt = useRef(performance.now());
  const throwing = useRef(false);
  /** Their jump bit last frame; null until the first state, so a herzie
   * doesn't hop just for showing up. */
  const jumpBit = useRef<number | null>(null);
  useEffect(() => () => void entityAt.delete(remote.id), [remote.id]);

  const tag = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    tags.set(remote.id, tag);
    return () => void tags.delete(remote.id);
  }, [remote.id]);
  const tagAnchor = useRef<Group>(null);
  const afk = useRef(false);
  const bubbleBox = useRef<HTMLDivElement>(null);
  const hpBox = useRef<HTMLDivElement>(null);
  const hpFill = useRef<HTMLDivElement>(null);
  const hpShown = useRef(-1);
  const bleedBox = useRef<HTMLSpanElement>(null);
  const bleedCount = useRef<HTMLSpanElement>(null);
  const bleedShown = useRef(0);
  const downMark = useRef<HTMLDivElement>(null);
  const downed = useRef(0);
  const hand = useMemo(() => new Vector3(), []);
  const trail = useMemo(() => new Trail(herzie.footSpread), [herzie]);
  const labelBox = useRef<HTMLDivElement>(null);
  const labelScale = useRef(1);
  const titleLine = useRef<HTMLDivElement>(null);
  const duelMark = useRef<HTMLSpanElement>(null);
  /** Standing in the dummies' list while you duel it (see below). */
  const target = useRef<DummyState | null>(null);
  useEffect(
    () => () => {
      if (target.current) dropTarget(target.current);
    },
    [],
  );
  const menuOpen = useDuelValue(() => duel.menu?.id === remote.id);
  /** Where it's drawn this frame (filled, not made, each frame). */
  const drawn = useMemo(blankState, []);

  useFrame(({ camera }, dt) => {
    const drawnAt = net.clock.renderTime(performance.now());
    const s = remote.buffer.sample(drawnAt, drawn);
    if (!s) return;
    herzie.root.visible = true;
    if (tag.current) setStyle(tag.current, "visibility", "visible");
    // Sitting on a bench: on its seat, not the ground. On a gangplank: on
    // the plank.
    const seated = (s.flags & TOWN_FLAG_SITTING) !== 0;
    const ground = standY(map, s.x, s.z);
    herzie.root.position.set(s.x, ground + (seated ? SEAT_Y : 0), s.z);
    // Your duel's opponent, or anyone you may fight in the Wilds: aimed at
    // and struck like a dummy (the server judges it), while the fight's on.
    const now = performance.now();
    const facing =
      (myOpponent() === remote.id && duelFighting(now)) ||
      wildsFoe(remote.id, s, townSave, now);
    if (facing && !target.current) {
      const t = newTarget(`duel${remote.id}`, s.x, s.z, s.heading);
      t.herzie = remote.id;
      t.body = herzie;
      t.size = HERZIE_BODY.radius / DUMMY.radius;
      target.current = t;
      liveDummies.push(t);
    } else if (!facing && target.current) {
      dropTarget(target.current);
      target.current = null;
    }
    if (target.current) {
      target.current.x = s.x;
      target.current.y = ground;
      target.current.z = s.z;
      target.current.yaw = s.heading;
    }
    // Their prints in the snow, as ours (see footprints.ts).
    if (!seated) {
      trail.step(
        map,
        footprints,
        s.x,
        ground,
        s.z,
        seasonNow.look.snow,
        ambient.uTime.value,
      );
    }
    herzie.sitting = seated;
    herzie.dancing = (s.flags & TOWN_FLAG_DANCING) !== 0;
    // Aiming: their gear off their back and in hand (and kept there while
    // a disc of theirs is on its way back).
    const discsOut =
      discField.isOut(herzie, "held-l") || discField.isOut(herzie, "held-r");
    herzie.armed = (s.flags & TOWN_FLAG_COMBAT) !== 0 || discsOut;
    herzie.heading = s.heading;
    // They jumped: the bit flips with every hop, played here the same way.
    const bit = s.flags & TOWN_FLAG_JUMP;
    if (jumpBit.current !== null && bit !== jumpBit.current) herzie.jump();
    jumpBit.current = bit;
    // They played an emote (the Alt bar).
    if (remote.pendingEmote) {
      herzie.emote(remote.pendingEmote);
      remote.pendingEmote = null;
    }
    // Their Rimshot or Silencio: the wind-up as the server's word comes,
    // the landing when their stick strikes the ground or their lute sweeps
    // out (as ours: SlamVFX and SilencioVFX draw them), or cut short if
    // the server says so.
    const slam = pendingSlam(remote.id);
    const winding =
      herzie.casting &&
      (herzie.castMotion === "slam" || herzie.castMotion === "hush");
    if (slam && slam.castAt > rimshotAt.current) {
      rimshotAt.current = slam.castAt;
      herzie.cast(0, { style: slam.skill === "rimshot" ? "slam" : "hush" });
      slam.tip = (out) => {
        const p = herzie.handWorldPosition(hand);
        out[0] = p.x;
        out[1] = p.y;
        out[2] = p.z;
        return out;
      };
    } else if (!slam && winding) {
      if (!slammed.current) herzie.cancelCast();
    }
    if (herzie.released && winding && slam) {
      const p = herzie.handWorldPosition(hand);
      landSlam(remote.id, [p.x, p.y, p.z], performance.now());
      slammed.current = true;
      // Felt by everyone near it.
      const d = Math.hypot(townSave.x - s.x, townSave.z - s.z);
      const near = Math.max(0, 1 - d / 14);
      if (slam.skill === "rimshot") {
        herzie.hitstop(0.12);
        sfxRimshotSlam();
        shake(0.2 * near);
      } else {
        sfxSilencio();
        shake(0.12 * near);
      }
    }
    if (!herzie.casting) slammed.current = false;
    // Their Cymbal Trap: thrown as the server's word comes, the cymbal off
    // their off hand (CymbalTrapVFX draws it from there).
    const trap = trapBy(remote.id);
    if (trap && trap.at > trapAt.current && !trap.out) {
      trapAt.current = trap.at;
      herzie.cast(0, { arm: "arm-r", style: "throw" });
      throwing.current = true;
      trap.hand = (out) => {
        const p = herzie.heldWorldPosition("held-r", hand);
        out[0] = p.x;
        out[1] = p.y;
        out[2] = p.z;
        return out;
      };
    }
    // Their Multispin (the records flung out: MultispinVFX draws them) or
    // Forbidden Frequency (its disc: BleedVFX draws it).
    for (const c of skills.casts) {
      if (c.by !== remote.id || c.at <= flourishAt.current) continue;
      if (c.skill !== "multispin" && c.skill !== "forbidden-frequency")
        continue;
      flourishAt.current = c.at;
      herzie.cast(0, { style: "throw" });
      throwing.current = true;
    }
    if (!herzie.casting) throwing.current = false;
    // They cast: the same thrust, and a wave from the hand the way they
    // face (only the cast count travels, not where they aimed).
    // Once the body is drawn where it was when it cast.
    if (
      remote.pendingCasts > 0 &&
      !herzie.casting &&
      (remote.castTimes[0] ?? Number.NEGATIVE_INFINITY) <= drawnAt
    ) {
      remote.pendingCasts--;
      remote.castTimes.shift();
      if (throwsDiscs) {
        // The hand they'd throw from by the same rule as ours (the main
        // hand if its disc is back), by our idea of their catches; with
        // both out, the other one from last time.
        const last = nextHand.current;
        nextHand.current =
          nextFreeHand(discField, herzie) ??
          (last === "held-l" ? "held-r" : "held-l");
        herzie.cast(0, { arm: DISC_ARM[nextHand.current], style: "throw" });
      } else if (attack === "melee") {
        punches.current++;
        herzie.cast(0, {
          style: blow,
          ...(blow === "punch"
            ? { arm: punches.current & 1 ? "arm-r" : "arm-l" }
            : {}),
        });
        if (blow === "strike") slashField.strike(herzie, false);
      } else {
        herzie.cast(0);
      }
    }
    herzie.castRate = attackSpeedOf(remote.id, performance.now());
    herzie.clothDetail = clothDetailAt(
      camera.position.distanceTo(herzie.root.position),
    );
    // On ice their legs go as fast as their steps would take them on the
    // ground (see movement.ts). Whether they're pushing isn't sent, so a
    // glide still steps.
    // Its cat spirit (if it has one) sees walls as ours does, and sleeps
    // while they're away.
    herzie.pathClear = rt.petClear ?? null;
    herzie.afk = (s.flags & TOWN_FLAG_AFK) !== 0;
    // A duel's hit-stop and finishing slow-down hold its pose, not the room.
    herzie.update(
      dt * fighterPace(remote.id, now),
      onIce(map, s.x, s.z, seasonNow.look.ice) ? s.speed / ICE_SPEED : s.speed,
    );
    if (herzie.released && throwing.current) {
      // Their cymbal or records leaving the hand: the VFX's, not a blow.
      throwing.current = false;
    } else if (herzie.released && throwsDiscs) {
      // Never waiting on our idea of their catch: a disc of theirs still
      // out from that hand is let go (see DiscField.throw).
      const h = nextHand.current;
      herzie.heldWorldPosition(h, hand);
      const from: Vec3 = [hand.x, hand.y, hand.z];
      const dir: Vec3 = [Math.sin(s.heading), 0, Math.cos(s.heading)];
      discField.throw(from, dir, {
        mine: false,
        owner: herzie,
        hand: h,
        target: assistTarget(from, dir, liveDummies, herzie),
        quick: attackSpeedOf(remote.id, performance.now()),
        bounces: shuffleOf(remote.id, performance.now()),
      });
    } else if (
      herzie.released &&
      attack === "melee" &&
      // A Rimshot's slam is its own thing (vfx/SlamVFX), not a swing.
      herzie.castMotion !== "slam"
    ) {
      // Only for show: what's in front of them rocks (the server counts
      // their hits on the boss).
      const from = { x: s.x, z: s.z };
      const height = ground + herzie.height * 0.5;
      const targets = [
        ...liveDummies
          .filter((d) => d.body !== herzie)
          .map((d) => ({ d, radius: DUMMY.radius * (d.size ?? 1) })),
        ...(bossFight.on && !bossFight.tower
          ? [{ d: null, radius: BOSS_STAND.radius }]
          : []),
      ];
      const boss = bossNow();
      for (const { d, radius } of targets) {
        const at = d ?? boss;
        if (!meleeReaches(from, s.heading, { x: at.x, z: at.z, radius }))
          continue;
        const dx = at.x - s.x;
        const dz = at.z - s.z;
        const n = Math.hypot(dx, dz) || 1;
        const dir: Vec3 = [dx / n, 0, dz / n];
        if (d)
          hitDummy(d, dir[0], dir[2], 100, false, performance.now(), false);
        waveField.burst(
          [at.x - dir[0] * radius, height, at.z - dir[2] * radius],
          dir,
          "hit",
        );
      }
    } else if (herzie.released && herzie.castMotion !== "hush") {
      // (A Silencio's burst is its own thing: vfx/SilencioVFX.)
      herzie.handWorldPosition(hand);
      const from: Vec3 = [hand.x, hand.y, hand.z];
      const dir: Vec3 = [Math.sin(s.heading), 0, Math.cos(s.heading)];
      // A Bard's lute only attacks in a duel.
      if (stance.healers.has(remote.id) && !duelOf(remote.id)) {
        // A Bard healing: a green bolt, to whoever it most likely aimed at
        // (only its heading travels), homing on them.
        const allies: { id: number; x: number; z: number }[] = [];
        for (const [id, at] of entityAt)
          if (id !== remote.id && !entityDown(id))
            allies.push({ id, x: at.x, z: at.z });
        const to = healTarget(from, dir, allies, HEAL_LOCK_ANGLE * 2);
        waveField.cast(from, dir, {
          mine: false,
          heal: true,
          ally: to?.ally.id ?? null,
        });
      } else
        waveField.cast(from, dir, {
          mine: false,
          owner: herzie,
          target: assistTarget(from, dir, liveDummies, herzie),
        });
    }
    // Knocked out (in the cave, or anywhere outside a fight): lying where
    // it fell, with a mark a Bard can spot from across the room. Taken down
    // in the Wilds it lies there too, with no mark: it gets up by itself.
    const ko = entityDown(remote.id) || !!remote.down;
    const down = ko || wildsDown(remote.id);
    downed.current = applyDowned(herzie, down, downed.current, dt);
    // A duel's blows and its end, on this herzie (see duel/fx).
    poseFighter(herzie, remote.id, now, dt);
    if (downMark.current)
      setStyle(downMark.current, "display", ko ? "" : "none");
    // A thrown disc (or Cymbal Trap's cymbal) isn't in the hand.
    herzie.setHeldHidden("held-l", discField.isOut(herzie, "held-l"));
    herzie.setHeldHidden(
      "held-r",
      discField.isOut(herzie, "held-r") || cymbalOut(remote.id, now),
    );
    tagAnchor.current?.position.set(
      s.x,
      ground + herzie.height + 0.3 + (seated ? SEAT_Y : 0),
      s.z,
    );
    setEntityAt(
      remote.id,
      s.x,
      s.z,
      ground + herzie.height + (seated ? SEAT_Y : 0),
    );
    // Chat is one room for everyone; the Town only shows what's said near
    // you.
    if (bubbleBox.current) {
      const near =
        Math.hypot(s.x - townSave.x, s.z - townSave.z) <= BUBBLE_RANGE;
      setStyle(bubbleBox.current, "display", near ? "" : "none");
    }
    // In a fight, a small health bar under the name: a duel's for its two
    // (bigger over your opponent), the boss fight's for everyone, the
    // Wilds' once it's been hurt.
    const ring = ringOf(remote.id);
    const opponent = myOpponent() === remote.id;
    if (hpBox.current && hpFill.current) {
      const h = ring
        ? ring.health.get(remote.id)
        : bossFight.on
          ? bossFight.health.get(remote.id)
          : wildsBarOf(remote.id, now);
      setStyle(hpBox.current, "display", h ? "" : "none");
      const big = opponent ? "1" : "";
      if (hpBox.current.dataset.big !== big) hpBox.current.dataset.big = big;
      if (h) {
        // Written only when it moved a whole percent.
        const pct = Math.round(Math.max(0, Math.min(1, h.hp / h.maxHp)) * 100);
        if (pct !== hpShown.current) {
          hpShown.current = pct;
          hpFill.current.style.width = `${pct}%`;
          hpFill.current.style.background = pct < 50 ? "#f87171" : "#34d399";
          // Low isn't told by colour alone: the bar blinks too.
          hpBox.current.dataset.low = pct < 25 ? "1" : "";
        }
      }
      // Bleeding (Forbidden Frequency): a drop by the bar, its stacks past
      // one. Written only when they change.
      if (bleedBox.current && bleedCount.current) {
        const stacks = h ? bleedStacks("herzie", remote.id, now) : 0;
        if (stacks !== bleedShown.current) {
          bleedShown.current = stacks;
          setStyle(bleedBox.current, "display", stacks > 0 ? "" : "none");
          bleedCount.current.textContent = stacks > 1 ? String(stacks) : "";
        }
      }
    }
    // Names, titles (and health bars) fade in as you come near; away dims
    // them. Only the nearest few are named; a duel's two carry far.
    const away = (s.flags & TOWN_FLAG_AFK) !== 0;
    const label = remoteLabel(Math.hypot(s.x - townSave.x, s.z - townSave.z), {
      duelist: !!duelOf(remote.id),
      hovered: labels.hovered === remote.id,
      ranked: labels.ranked.size === 0 || labels.ranked.has(remote.id),
    });
    const dim = away ? 0.45 : 1;
    if (tag.current) {
      setOpacity(tag.current, label.name * dim);
      // Faded out, so not clickable either.
      setStyle(tag.current, "pointerEvents", label.name < 0.1 ? "none" : "");
      if (away !== afk.current) {
        afk.current = away;
        tag.current.dataset.afk = away ? "1" : "";
      }
    }
    if (titleLine.current) setOpacity(titleLine.current, label.title * dim);
    if (
      labelBox.current &&
      Math.abs(label.scale - labelScale.current) > 0.005
    ) {
      labelScale.current = label.scale;
      labelBox.current.style.transform = `scale(${label.scale})`;
    }
    if (hpBox.current) setOpacity(hpBox.current, label.hp);
    if (duelMark.current) {
      const shown = ring && ring.endedAt === null ? "" : "none";
      setStyle(duelMark.current, "display", shown);
    }
  });

  const title = titleName(remote.title);
  return (
    <>
      <primitive object={herzie.root} />
      <group ref={tagAnchor}>
        <Html zIndexRange={[19, 0]}>
          {/* Stacked up from the anchor: the bubble over the name, the
              title under it. */}
          <div className="flex -translate-x-1/2 -translate-y-full flex-col items-center">
            <div
              ref={downMark}
              role="img"
              aria-label="Knocked out"
              className="mb-0.5 rounded-full bg-black/55 px-1 text-[13px] leading-none text-[#ffd84a]"
              style={{ display: "none", textShadow: NAME_SHADOW }}
            >
              ✚
            </div>
            <div ref={bubbleBox}>
              {bubble ? <HeadBubble key={bubble.key} bubble={bubble} /> : null}
            </div>
            <div
              ref={labelBox}
              className="flex origin-bottom flex-col items-center"
            >
              <button
                type="button"
                ref={tag}
                onClick={(e) => openPlayerMenu(remote.id, e.clientX, e.clientY)}
                onPointerEnter={() => {
                  labels.hovered = remote.id;
                }}
                onPointerLeave={() => {
                  if (labels.hovered === remote.id) labels.hovered = null;
                }}
                className="cursor-pointer whitespace-nowrap border-0 bg-transparent p-0 text-[11px] font-medium leading-tight text-white hover:underline"
                // Hidden until the first state arrives, rather than at the origin.
                style={{ textShadow: NAME_SHADOW, visibility: "hidden" }}
              >
                <span
                  ref={duelMark}
                  role="img"
                  aria-label="In a duel"
                  className="mr-0.5 text-[#ffd84a]"
                  style={{ display: "none" }}
                >
                  ⚔
                </span>
                {remote.gm ? <GmMark className="[text-shadow:none]" /> : null}
                {remote.name}
              </button>
              {title ? (
                <div
                  ref={titleLine}
                  className="pointer-events-none whitespace-nowrap text-[9px] font-medium leading-tight text-white"
                  style={{ textShadow: NAME_SHADOW }}
                >
                  {title}
                </div>
              ) : null}
              <div className="pointer-events-none flex items-center gap-px">
                <div
                  ref={hpBox}
                  className="pointer-events-none mt-px h-[3px] w-10 overflow-hidden rounded-sm bg-black/60 data-[big=1]:mt-0.5 data-[big=1]:h-[5px] data-[big=1]:w-16 data-[low=1]:animate-pulse data-[low=1]:outline data-[low=1]:outline-1 data-[low=1]:outline-red-400/70 motion-reduce:animate-none"
                  style={{ display: "none" }}
                >
                  <div ref={hpFill} className="h-full" />
                </div>
                <span
                  ref={bleedBox}
                  className="flex items-center text-[8px] font-bold leading-none text-[#e86a6a] [text-shadow:0_1px_0_#000]"
                  style={{ display: "none" }}
                  title="Bleeding"
                >
                  <svg
                    viewBox="0 0 10 13"
                    className="h-2 w-1.5"
                    aria-hidden="true"
                  >
                    <path
                      d="M5 0.5C6 3 9.5 6 9.5 8.6A4.5 4.5 0 0 1 0.5 8.6C0.5 6 4 3 5 0.5Z"
                      fill="#8b0f18"
                      stroke="rgba(0,0,0,0.75)"
                    />
                  </svg>
                  <span ref={bleedCount} />
                </span>
              </div>
            </div>
          </div>
          {menuOpen ? (
            <PlayerMenu remote={remote} onOpenProfile={onOpenProfile} />
          ) : null}
        </Html>
      </group>
    </>
  );
}
