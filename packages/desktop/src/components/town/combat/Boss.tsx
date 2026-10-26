import { BOSS_STAND } from "@herzies/shared/combat";
import { HerzieModel, turnToward } from "@herzies/shared/gl";
import { Html } from "@react-three/drei";
import { useFrame } from "@react-three/fiber";
import {
  CylinderCollider,
  type RapierRigidBody,
  RigidBody,
} from "@react-three/rapier";
import { memo, useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { lookOf } from "../../TownScene";
import { ambient } from "../ambient";
import { HeadBubble } from "../HeadBubble";
import { townSave } from "../runtime";
import { bossFight, bossNow, useBossFight } from "./fight";
import { beats, resetMoments, stepMoments } from "./moments";
import { CRUMBLE, STONE_HOLD } from "./results";
import { entityAt } from "./skills";
import { combat } from "./state";

/** The boss looms: drawn this much bigger than it's built, like the one
 * in town. */
const SCALE = 2.2;
const TURN_RATE = 4;
const MAX_TURN_SPEED = 3;
/** The boss rears this much while an attack fills, and drops on the slam. */
const REAR = 0.08;
const SLAM_MS = 260;
/** How long it takes to wake (rise and roar), ms. */
const WAKE_MS = 1_100;
/** Over its head, for what it says. */
const SAY_HEIGHT = BOSS_STAND.top * 1.25;
// The body's props, made once: rapier rebuilds a collider whenever its
// `args` array is a new one, which a fresh literal every render would be.
const BODY_AT: [number, number, number] = [BOSS_STAND.x, 0, BOSS_STAND.z];
const COLLIDER_ARGS: [number, number] = [2.4, BOSS_STAND.radius * 0.92];
const COLLIDER_AT: [number, number, number] = [0, 2.4, 0];
const SAY_AT: [number, number, number] = [
  BOSS_STAND.x,
  SAY_HEIGHT,
  BOSS_STAND.z,
];

/**
 * The boss in its cave: the same body as the one in town. Asleep in the
 * lobby, it turns to watch you; in the fight it walks where the server says
 * (a moment behind, like everyone else) and faces whoever it's after,
 * marked with a line from it to them. It rears as an attack builds on
 * the floor, drops heavily as it lands, says what it hates over
 * its head, and turns to stone when it falls, then crumbles away. It's
 * solid, so waves burst on it and nobody walks through it — until it's
 * gone.
 */
export function Boss() {
  useBossFight();
  const event = bossFight.event;
  const herzie = useMemo(() => {
    if (!event) return null;
    const m = new HerzieModel(
      lookOf({
        type: "boss_fight",
        title: "",
        description: null,
        status: "live",
        at: null,
        openKey: null,
        eventId: event,
      }),
      { seed: 7, lighting: ambient },
    );
    m.root.position.set(BOSS_STAND.x, 0, BOSS_STAND.z);
    m.heading = Math.PI;
    return m;
  }, [event]);
  useEffect(() => () => herzie?.dispose(), [herzie]);
  // The body that fell, once it's crumbled away (a new fight builds a new
  // one, even under the same event, as local fights all are).
  const [fallen, setFallen] = useState<HerzieModel | null>(null);
  const gone = fallen !== null && fallen === herzie;
  const body = useRef<RapierRigidBody>(null);
  const sayAnchor = useRef<THREE.Group>(null);
  const tether = useMemo(() => new Tether(), []);
  useEffect(() => () => tether.dispose(), [tether]);

  const stoned = useRef(false);
  useEffect(() => {
    if (herzie) stoned.current = false;
  }, [herzie]);
  // Out of the room: the raid's beats start over next time.
  useEffect(() => resetMoments, []);
  useFrame((_, dt) => {
    const now = performance.now();
    stepMoments(now);
    if (!herzie || gone) {
      tether.hide();
      return;
    }
    const at = bossNow();
    herzie.root.position.x = at.x;
    herzie.root.position.z = at.z;
    body.current?.setNextKinematicTranslation({ x: at.x, y: 0, z: at.z });
    sayAnchor.current?.position.set(at.x, SAY_HEIGHT, at.z);
    // Who it's after: in the fight, the server's word (and a line to
    // them); asleep, you.
    const raid = bossFight.raid;
    const focus =
      raid?.stage === "fight" && raid.focus !== null
        ? entityAt.get(raid.focus)
        : undefined;
    const look = focus ?? (bossFight.bossPath.length ? null : townSave);
    herzie.heading = look
      ? turnToward(
          herzie.heading,
          Math.atan2(look.x - at.x, look.z - at.z),
          TURN_RATE,
          MAX_TURN_SPEED,
          dt,
        )
      : turnToward(herzie.heading, at.yaw, TURN_RATE, MAX_TURN_SPEED, dt);
    if (focus && !bossFight.victory)
      tether.show(at, focus, !!raid?.taunted, now);
    else tether.hide();
    // Rear as its own attack fills (the fullest one), drop as it lands:
    // the body tells the attack as well as the floor does.
    let fill = 0;
    for (const sh of bossFight.shapes) {
      if (sh.resolvedAt !== null || sh.mob !== undefined) continue;
      const span = Math.max(1, sh.lands - sh.from);
      fill = Math.max(fill, Math.min(1, (now - sh.from) / span));
    }
    const slam = Math.max(0, 1 - (now - bossFight.slammedAt) / SLAM_MS);
    const rear = REAR * fill * fill * (3 - 2 * fill);
    // Asleep in the lobby: it breathes slowly, sunk a little. Waking, it
    // rises out of that and swells for a moment (a roar).
    const asleep = raid?.stage === "lobby";
    const woke = Math.min(1, Math.max(0, (now - beats.wokeAt) / WAKE_MS));
    const sunk = asleep ? 1 : 1 - woke;
    const breath = sunk * (0.03 * Math.sin(now / 900) - 0.04);
    const roar = woke < 1 ? 0.14 * Math.sin(Math.PI * woke) : 0;
    const y = 1 + rear - slam * 0.1 + breath + roar;
    const xz = 1 - rear * 0.4 + slam * 0.06 - breath * 0.3 + roar * 0.5;
    herzie.root.scale.set(SCALE * xz, SCALE * y, SCALE * xz);
    // Its skin: white on a hit (more on yours), a bright flash on a new
    // phase, a red glow once it's enraged.
    if (!bossFight.victory) {
      const hit = Math.max(
        0.1 * (1 - (now - bossFight.bossHitAt) / 110),
        0.3 * (1 - (now - combat.hitAt) / 140),
        0.75 * (1 - (now - beats.phaseAt) / 450),
        0,
      );
      const hard = raid?.hardAt != null && now >= raid.hardAt;
      const enraged = raid?.enrageAt != null && now >= raid.enrageAt;
      const red = hard
        ? 0.32 + 0.14 * Math.sin(now / 90)
        : enraged
          ? 0.16 + 0.08 * Math.sin(now / 160)
          : 0;
      if (hit >= red) herzie.setFlash(1, 1, 1, hit);
      else herzie.setFlash(1, 0.12, 0.06, red);
    } else herzie.setFlash(1, 1, 1, 0);
    if (bossFight.victory) {
      if (!stoned.current) {
        stoned.current = true;
        herzie.petrify();
      }
      // Stone a beat, then it sinks and shrinks into the floor.
      const t = (now - bossFight.victory.at) / 1000 - STONE_HOLD;
      const u = Math.min(1, Math.max(0, t / CRUMBLE));
      const k = 1 - u * u;
      herzie.root.scale.multiplyScalar(Math.max(0.001, k));
      herzie.root.position.y = -u * 1.5;
      if (u >= 1) {
        setFallen(herzie);
        return;
      }
    }
    herzie.update(dt, 0);
  });

  if (!herzie || gone) return null;
  return (
    <>
      <primitive object={herzie.root} />
      <primitive object={tether.object} />
      <RigidBody
        ref={body}
        type="kinematicPosition"
        colliders={false}
        position={BODY_AT}
      >
        <CylinderCollider args={COLLIDER_ARGS} position={COLLIDER_AT} />
      </RigidBody>
      <group ref={sayAnchor} position={SAY_AT}>
        <BossSay />
      </group>
    </>
  );
}

/**
 * What the boss says, over its head until the line's time is up. The
 * overlay stays mounted for the whole fight and only its contents change:
 * mounting and unmounting an `<Html>` root as lines come and go races
 * React's own render.
 */
function BossSay() {
  useBossFight();
  const say = bossFight.say;
  const [, setTick] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new line (bossFight.say is replaced, not mutated) restarts its timer
  useEffect(() => {
    if (!say) return;
    const left = say.until - performance.now();
    if (left <= 0) return;
    const t = setTimeout(() => setTick((n) => n + 1), left + 20);
    return () => clearTimeout(t);
  }, [say]);
  const line = say && performance.now() < say.until ? say : null;
  return <SayBubble line={line} />;
}

const SAY_STYLE = { pointerEvents: "none" } as const;
const SAY_Z: [number, number] = [20, 0];

/** The overlay itself, re-rendered only when the line changes: drei's
 * `<Html>` renders a second React root on every render of its own. */
const SayBubble = memo(function SayBubble({
  line,
}: {
  line: { text: string; until: number } | null;
}) {
  return (
    <Html zIndexRange={SAY_Z} style={SAY_STYLE}>
      <div
        role="status"
        aria-live="polite"
        className="-translate-x-1/2 -translate-y-full"
      >
        {line ? (
          <HeadBubble bubble={{ key: `${line.until}`, text: line.text }} />
        ) : null}
      </div>
    </Html>
  );
});

/**
 * The boss's eye on someone: a line on the floor from it to them, and a
 * ring under them. Red and steady while a taunt holds it; amber and
 * flickering when it's only who it hates most.
 */
class Tether {
  readonly object = new THREE.Group();
  private readonly line: THREE.Mesh;
  private readonly ring: THREE.Mesh;
  private readonly material = new THREE.MeshBasicMaterial({
    color: 0xff5a3c,
    transparent: true,
    opacity: 0.5,
    depthWrite: false,
    fog: false,
    // Over the floor, as the floor shapes are: far off, the two would
    // otherwise fight for the same depth.
    polygonOffset: true,
    polygonOffsetFactor: -4,
    polygonOffsetUnits: -4,
  });

  constructor() {
    this.line = new THREE.Mesh(new THREE.PlaneGeometry(1, 0.16), this.material);
    this.line.rotation.x = -Math.PI / 2;
    this.ring = new THREE.Mesh(
      new THREE.RingGeometry(0.85, 1.05, 32),
      this.material,
    );
    this.ring.rotation.x = -Math.PI / 2;
    this.object.add(this.line, this.ring);
    this.object.renderOrder = 4;
    this.object.visible = false;
  }

  show(
    from: { x: number; z: number },
    to: { x: number; z: number },
    taunted: boolean,
    now: number,
  ) {
    const dx = to.x - from.x;
    const dz = to.z - from.z;
    const d = Math.hypot(dx, dz);
    this.object.visible = d > 0.1;
    if (!this.object.visible) return;
    this.line.position.set(from.x + dx / 2, 0.09, from.z + dz / 2);
    this.line.scale.x = d;
    // A plane's length is along its x: turn it to point from boss to them.
    this.line.rotation.z = Math.atan2(dz, dx) * -1;
    this.ring.position.set(to.x, 0.09, to.z);
    this.material.color.set(taunted ? 0xff3b30 : 0xffb340);
    this.material.opacity = taunted ? 0.8 : 0.5 + 0.15 * Math.sin(now / 120);
  }

  hide() {
    this.object.visible = false;
  }

  dispose() {
    this.line.geometry.dispose();
    this.ring.geometry.dispose();
    this.material.dispose();
  }
}
