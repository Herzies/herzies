import {
  basicAttack,
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
import { HerzieModel } from "@herzies/shared/gl";
import { Html } from "@react-three/drei";
import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useMemo, useRef } from "react";
import { type Group, Raycaster, Sphere, Vector2, Vector3 } from "three";
import { GmMark } from "../GmMark";
import { ambient, seasonNow } from "./ambient";
import { SEAT_Y } from "./Benches";
import { BUBBLE_RANGE, type ChatBubble, type ChatBubbles } from "./chatBubbles";
import { clothDetailAt } from "./clothDetail";
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
} from "./combat/skills";
import { landSlam, pendingSlam } from "./combat/slams";
import { slashField } from "./combat/slashes";
import { stance } from "./combat/stance";
import { shake } from "./combat/state";
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
import { groundY, petWalkable, type TownMap, worldRadius } from "./map";
import { ICE_SPEED, onIce } from "./movement";
import { NAME_SHADOW, nearestIds, REMOTE_LABEL, remoteLabel } from "./nameFade";
import type { RemotePlayer, TownConnection } from "./net/TownConnection";
import { useTownNetVersion } from "./net/townNet";
import { townSave, useTownRuntime } from "./runtime";
import { sfxRimshotSlam } from "./sfx";
import { titleLook } from "./TitleLine";

/** What every label reads: the herzie the pointer's on, and the nearest
 * few, who are named (REMOTE_LABEL.nearest). */
const labels = {
  hovered: null as number | null,
  ranked: new Set<number>(),
};
/** How often the nearest are worked out again (ms). */
const RANK_MS = 250;

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
}: {
  /** The island they're on with you: its ground's ups and downs. */
  map: TownMap;
  net: TownConnection;
  /** Their menu's "Profile" opens it (by friend code). */
  onOpenProfile?: (friendCode: string) => void;
  /** What people are saying, by friend code. */
  bubbles?: ChatBubbles;
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
}: {
  map: TownMap;
  remote: RemotePlayer;
  net: TownConnection;
  bubble?: ChatBubble;
  onOpenProfile?: (friendCode: string) => void;
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
    // Its cat spirit (if it has one) walks the same ground, round water.
    herzie.groundAt = (x, z) => groundY(map, x, z);
    herzie.walkable = petWalkable(map, worldRadius(map));
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
  /** Their jump bit last frame; null until the first state, so a herzie
   * doesn't hop just for showing up. */
  const jumpBit = useRef<number | null>(null);
  useEffect(() => () => void entityAt.delete(remote.id), [remote.id]);

  const tag = useRef<HTMLButtonElement>(null);
  const tagAnchor = useRef<Group>(null);
  const afk = useRef(false);
  const bubbleBox = useRef<HTMLDivElement>(null);
  const hpBox = useRef<HTMLDivElement>(null);
  const hpFill = useRef<HTMLDivElement>(null);
  const hpShown = useRef(-1);
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

  useFrame(({ camera }, dt) => {
    const drawnAt = net.clock.renderTime(performance.now());
    const s = remote.buffer.sample(drawnAt);
    if (!s) return;
    herzie.root.visible = true;
    if (tag.current) tag.current.style.visibility = "visible";
    // Sitting on a bench: on its seat, not the ground.
    const seated = (s.flags & TOWN_FLAG_SITTING) !== 0;
    const ground = groundY(map, s.x, s.z);
    herzie.root.position.set(s.x, ground + (seated ? SEAT_Y : 0), s.z);
    // Your duel's opponent: aimed at and struck like a dummy (the server
    // judges it), while the fight's on.
    const now = performance.now();
    const facing = myOpponent() === remote.id && duelFighting(now);
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
    // Their Rimshot: the wind-up as the server's word comes, the slam when
    // their stick strikes the ground (as ours: SlamVFX draws both), or cut
    // short if the server says so.
    const slam = pendingSlam(remote.id);
    if (slam && slam.castAt > rimshotAt.current) {
      rimshotAt.current = slam.castAt;
      herzie.cast(0, { style: "slam" });
      slam.tip = (out) => {
        const p = herzie.handWorldPosition(hand);
        out[0] = p.x;
        out[1] = p.y;
        out[2] = p.z;
        return out;
      };
    } else if (!slam && herzie.casting && herzie.castMotion === "slam") {
      if (!slammed.current) herzie.cancelCast();
    }
    if (herzie.released && herzie.castMotion === "slam" && slam) {
      const p = herzie.handWorldPosition(hand);
      landSlam(remote.id, [p.x, p.y, p.z], performance.now());
      slammed.current = true;
      herzie.hitstop(0.12);
      // Felt by everyone near it.
      const d = Math.hypot(townSave.x - s.x, townSave.z - s.z);
      sfxRimshotSlam();
      shake(0.2 * Math.max(0, 1 - d / 14));
    }
    if (!herzie.casting) slammed.current = false;
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
    if (herzie.released && throwsDiscs) {
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
    } else if (herzie.released) {
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
    // it fell, with a mark a Bard can spot from across the room.
    const down = entityDown(remote.id) || remote.down;
    downed.current = applyDowned(herzie, down, downed.current, dt);
    // A duel's blows and its end, on this herzie (see duel/fx).
    poseFighter(herzie, remote.id, now, dt);
    if (downMark.current) downMark.current.style.display = down ? "" : "none";
    // A thrown disc isn't in the hand.
    herzie.setHeldHidden("held-l", discField.isOut(herzie, "held-l"));
    herzie.setHeldHidden("held-r", discField.isOut(herzie, "held-r"));
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
      bubbleBox.current.style.display = near ? "" : "none";
    }
    // In a fight, a small health bar under the name: a duel's for its two
    // (bigger over your opponent), the boss fight's for everyone.
    const ring = ringOf(remote.id);
    const opponent = myOpponent() === remote.id;
    if (hpBox.current && hpFill.current) {
      const h = ring
        ? ring.health.get(remote.id)
        : bossFight.on
          ? bossFight.health.get(remote.id)
          : undefined;
      hpBox.current.style.display = h ? "" : "none";
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
      tag.current.style.opacity = String(label.name * dim);
      // Faded out, so not clickable either.
      tag.current.style.pointerEvents = label.name < 0.1 ? "none" : "";
      if (away !== afk.current) {
        afk.current = away;
        tag.current.dataset.afk = away ? "1" : "";
      }
    }
    if (titleLine.current)
      titleLine.current.style.opacity = String(label.title * dim);
    if (
      labelBox.current &&
      Math.abs(label.scale - labelScale.current) > 0.005
    ) {
      labelScale.current = label.scale;
      labelBox.current.style.transform = `scale(${label.scale})`;
    }
    if (hpBox.current) hpBox.current.style.opacity = String(label.hp);
    if (duelMark.current) {
      const shown = ring && ring.endedAt === null ? "" : "none";
      if (duelMark.current.style.display !== shown)
        duelMark.current.style.display = shown;
    }
  });

  const title = titleLook(remote.title);
  return (
    <>
      <primitive object={herzie.root} />
      <group ref={tagAnchor}>
        <Html zIndexRange={[19, 0]}>
          {/* Stacked up from the anchor: the bubble over the name. */}
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
                  className="pointer-events-none whitespace-nowrap text-[9px] font-medium leading-tight"
                  style={{ color: title.color, textShadow: NAME_SHADOW }}
                >
                  {title.name}
                </div>
              ) : null}
              <div
                ref={hpBox}
                className="pointer-events-none mt-px h-[3px] w-10 overflow-hidden rounded-sm bg-black/60 data-[big=1]:mt-0.5 data-[big=1]:h-[5px] data-[big=1]:w-16 data-[low=1]:animate-pulse data-[low=1]:outline data-[low=1]:outline-1 data-[low=1]:outline-red-400/70 motion-reduce:animate-none"
                style={{ display: "none" }}
              >
                <div ref={hpFill} className="h-full" />
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
