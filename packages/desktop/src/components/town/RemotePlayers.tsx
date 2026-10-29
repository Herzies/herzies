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
  healTarget,
  meleeReaches,
} from "@herzies/shared/combat";
import { HerzieModel } from "@herzies/shared/gl";
import { Html } from "@react-three/drei";
import { useFrame } from "@react-three/fiber";
import { useEffect, useMemo, useRef } from "react";
import { type Group, Vector3 } from "three";
import { ambient } from "./ambient";
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
import { DUMMY, hitDummy } from "./combat/dummy";
import { bossFight, bossNow } from "./combat/fight";
import { attackSpeedOf, entityAt, setEntityAt } from "./combat/skills";
import { slashField } from "./combat/slashes";
import { stance } from "./combat/stance";
import { assistTarget, type Vec3, waveField } from "./combat/waves";
import { applyDowned, entityDown } from "./downed";
import { HeadBubble } from "./HeadBubble";
import { groundY, type TownMap } from "./map";
import { NAME_SHADOW, nameOpacity } from "./nameFade";
import type { RemotePlayer, TownConnection } from "./net/TownConnection";
import { useTownNetVersion } from "./net/townNet";
import { townSave } from "./runtime";

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
  /** Clicking a name opens that player's profile (by friend code). */
  onOpenProfile?: (friendCode: string) => void;
  /** What people are saying, by friend code. */
  bubbles?: ChatBubbles;
}) {
  useTownNetVersion(net);
  return (
    <>
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
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed on the look's content
  const herzie = useMemo(
    () => new HerzieModel(look, { seed: remote.id * 7, lighting: ambient }),
    [lookKey, remote.id],
  );
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

  useFrame(({ camera }, dt) => {
    const s = remote.buffer.sample(net.clock.renderTime(performance.now()));
    if (!s) return;
    herzie.root.visible = true;
    if (tag.current) tag.current.style.visibility = "visible";
    // Sitting on a bench: on its seat, not the ground.
    const seated = (s.flags & TOWN_FLAG_SITTING) !== 0;
    const ground = groundY(map, s.x, s.z);
    herzie.root.position.set(s.x, ground + (seated ? SEAT_Y : 0), s.z);
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
    // They cast: the same thrust, and a wave from the hand the way they
    // face (only the cast count travels, not where they aimed).
    if (remote.pendingCasts > 0 && !herzie.casting) {
      remote.pendingCasts--;
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
    herzie.update(dt, s.speed);
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
        target: assistTarget(from, dir, liveDummies),
        quick: attackSpeedOf(remote.id, performance.now()),
      });
    } else if (herzie.released && attack === "melee") {
      // Only for show: what's in front of them rocks (the server counts
      // their hits on the boss).
      const from = { x: s.x, z: s.z };
      const height = ground + herzie.height * 0.5;
      const targets = [
        ...liveDummies.map((d) => ({ d, radius: DUMMY.radius })),
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
      if (stance.healers.has(remote.id)) {
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
          target: assistTarget(from, dir, liveDummies),
        });
    }
    // Knocked out (in the cave, or anywhere outside a fight): lying where
    // it fell, with a mark a Bard can spot from across the room.
    const down = entityDown(remote.id) || remote.down;
    downed.current = applyDowned(herzie, down, downed.current, dt);
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
    // In a fight, a small health bar under the name.
    if (hpBox.current && hpFill.current) {
      const h = bossFight.on ? bossFight.health.get(remote.id) : undefined;
      hpBox.current.style.display = h ? "" : "none";
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
    // Names (and health bars) fade in as you come near; away dims them.
    const away = (s.flags & TOWN_FLAG_AFK) !== 0;
    const fade = nameOpacity(Math.hypot(s.x - townSave.x, s.z - townSave.z));
    if (tag.current) {
      tag.current.style.opacity = String(fade * (away ? 0.45 : 1));
      // Faded out, so not clickable either.
      tag.current.style.pointerEvents = fade < 0.1 ? "none" : "";
      if (away !== afk.current) {
        afk.current = away;
        tag.current.dataset.afk = away ? "1" : "";
      }
    }
    if (hpBox.current) hpBox.current.style.opacity = String(fade);
  });

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
            <button
              type="button"
              ref={tag}
              onClick={() => onOpenProfile?.(look.seed)}
              className="cursor-pointer whitespace-nowrap border-0 bg-transparent p-0 text-[11px] font-medium leading-tight text-white hover:underline"
              // Hidden until the first state arrives, rather than at the origin.
              style={{ textShadow: NAME_SHADOW, visibility: "hidden" }}
            >
              {remote.name}
            </button>
            <div
              ref={hpBox}
              className="pointer-events-none mt-px h-[3px] w-10 overflow-hidden rounded-sm bg-black/60 data-[low=1]:animate-pulse data-[low=1]:outline data-[low=1]:outline-1 data-[low=1]:outline-red-400/70 motion-reduce:animate-none"
              style={{ display: "none" }}
            >
              <div ref={hpFill} className="h-full" />
            </div>
          </div>
        </Html>
      </group>
    </>
  );
}
