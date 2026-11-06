import { HerzieModel, turnToward } from "@herzies/shared/gl";
import { Html } from "@react-three/drei";
import { useFrame } from "@react-three/fiber";
import {
  CylinderCollider,
  type RapierRigidBody,
  RigidBody,
} from "@react-three/rapier";
import { useEffect, useMemo, useRef } from "react";
import type { Group } from "three";
import { cn } from "../../lib/utils";
import { lookOf } from "../TownScene";
import { VISITOR_THEMES } from "../VisitorRowTheme";
import { ambient } from "./ambient";
import { homeMode } from "./homeMode";
import { groundY, type TownMap } from "./map";
import { markMet, RESIDENTS, useMet } from "./met";
import { NAME_SHADOW, nameOpacity } from "./nameFade";
import {
  ROAMERS,
  type RoamState,
  roamHeading,
  standable,
  startRoam,
  stepRoam,
} from "./roam";
import { NOTICE_RANGE, type TownSpot, townSave } from "./runtime";

/** The boss looms: drawn this much bigger than it's built (a stage-3
 * herzie is about its height otherwise). */
const BOSS_SCALE = 2.2;

/** How quickly a visitor turns to look at you, and back. */
const TURN_RATE = 6;
const MAX_TURN_SPEED = 5;

/**
 * A visitor's spot: while they're in town, a ring on the ground in their
 * colour and the visitor themselves, breathing, turning to look at
 * you as you come near, and solid enough to bump into, with their name
 * over their head (which opens them). Away, there's nothing. A few
 * residents (ROAMERS) wander round their spot and dance now and then, the
 * ring and name going with them. `bare` (the website's Town) leaves out
 * the ring, the name and the "!".
 */
export function Visitor({
  spot,
  ground = 0,
  map,
  onOpen,
  bare,
}: {
  spot: TownSpot;
  /** How high the ground is where they stand. */
  ground?: number;
  /** The island they're on: what a roamer walks over. */
  map?: TownMap;
  onOpen: (openKey: string) => void;
  /** Just the herzie: no ring, name or "!" (the website's Town). */
  bare?: boolean;
}) {
  const { card, at, standing, status } = spot;
  const live = card.status === "live";
  const theme = live ? VISITOR_THEMES[card.type] : undefined;
  const plaza = Math.atan2(-at.x, -at.z);
  const size = card.type === "boss_fight" ? BOSS_SCALE : 1;

  // Keyed on who, not on the card object, which is rebuilt every render.
  // biome-ignore lint/correctness/useExhaustiveDependencies: see above
  const herzie = useMemo(() => {
    if (!standing) return null;
    const s = new HerzieModel(lookOf(card), {
      seed: at.x * 7 + at.z * 3,
      lighting: ambient,
    });
    s.heading = plaza;
    s.root.position.set(at.x, ground, at.z);
    s.root.scale.setScalar(size);
    return s;
  }, [standing, card.type, card.eventId, ground]);
  useEffect(() => () => herzie?.dispose(), [herzie]);

  const roamer = map ? ROAMERS[card.type] : undefined;
  // biome-ignore lint/correctness/useExhaustiveDependencies: a fresh walk per herzie
  const roam = useMemo<RoamState | null>(
    () => (roamer && herzie ? startRoam(at) : null),
    [herzie, roamer, at.x, at.z],
  );
  const ok = useMemo(
    () => (map ? (x: number, z: number) => standable(map, x, z) : () => false),
    [map],
  );
  // What goes with them: the ring, the name, the "!".
  const follow = useRef<Group>(null);
  const body = useRef<RapierRigidBody>(null);

  // The name fades in as you come near.
  const name = useRef<HTMLDivElement>(null);
  // The "!" goes with the world on the way Home, as names do.
  const marker = useRef<HTMLButtonElement>(null);
  useFrame((_, dt) => {
    if (!herzie) return;
    let speed = 0;
    let y = ground;
    if (roam && roamer && map) {
      speed = stepRoam(roam, {
        home: at,
        radius: roamer.radius,
        player: townSave,
        ok,
        dt,
      });
      y = groundY(map, roam.at.x, roam.at.z);
      herzie.root.position.set(roam.at.x, y, roam.at.z);
      herzie.dancing = roam.dancing;
      body.current?.setNextKinematicTranslation({
        x: roam.at.x,
        y,
        z: roam.at.z,
      });
    }
    const here = roam?.at ?? at;
    follow.current?.position.set(here.x, y, here.z);
    const dx = townSave.x - here.x;
    const dz = townSave.z - here.z;
    if (name.current) {
      const o = nameOpacity(Math.hypot(dx, dz));
      name.current.style.opacity = String(o);
      // Not there, so not clickable either.
      name.current.style.pointerEvents = o < 0.1 ? "none" : "";
    }
    if (marker.current) {
      const o = 1 - homeMode.worldFade;
      marker.current.style.opacity = String(o);
      marker.current.style.pointerEvents = o < 0.1 ? "none" : "";
    }
    // Walking: where they're going. Otherwise you, when you're near; a
    // roamer left alone stays facing however they ended up.
    const walking = roam ? roamHeading(roam) : null;
    const target =
      walking ??
      (Math.hypot(dx, dz) < NOTICE_RANGE
        ? Math.atan2(dx, dz)
        : roam
          ? herzie.heading
          : plaza);
    herzie.heading = turnToward(
      herzie.heading,
      target,
      TURN_RATE,
      MAX_TURN_SPEED,
      dt,
    );
    herzie.update(dt, speed);
  });

  const open = card.openKey;
  const Tag = open ? "button" : "div";
  // A visitor who's arrived and you haven't talked to yet: a "!" over their
  // head. The residents live here, so they never arrive — unless they have
  // something for you (card.notice: the Tower Guard owes you a reward).
  const met = useMet(card);
  const fresh =
    !!herzie &&
    live &&
    !!open &&
    (card.notice ?? (!met && !RESIDENTS.has(card.type)));
  const talk = () => {
    if (!open) return;
    markMet(card);
    onOpen(open);
  };
  return (
    <>
      {herzie && (
        <>
          <primitive object={herzie.root} />
          <RigidBody
            ref={body}
            type={roam ? "kinematicPosition" : "fixed"}
            colliders={false}
            position={[at.x, ground, at.z]}
          >
            <CylinderCollider args={[1, 0.9 * size]} position={[0, 1, 0]} />
          </RigidBody>
        </>
      )}
      <group ref={follow} position={[at.x, ground, at.z]}>
        {herzie && !bare && (
          <mesh rotation-x={-Math.PI / 2} position={[0, 0.03, 0]}>
            <ringGeometry args={[1.05 * size, 1.05 * size + 0.2, 40]} />
            <meshBasicMaterial
              color={theme?.accent ?? "#ffffff"}
              transparent
              opacity={0.85}
              depthWrite={false}
            />
          </mesh>
        )}
        {herzie && !bare && (
          <Html
            position={[0, herzie.height * size + 0.5, 0]}
            center
            // Under the app's own overlays (chat, menus), not drei's default
            // of nearly the top of the stack.
            zIndexRange={[20, 0]}
          >
            <div ref={name} style={{ opacity: 0 }}>
              <Tag
                {...(open ? { type: "button" as const, onClick: talk } : {})}
                aria-label={`${card.title}: ${status}`}
                className={cn(
                  "whitespace-nowrap border-none bg-transparent p-0 text-[11px] font-medium leading-tight text-white",
                  open && "cursor-pointer hover:underline",
                )}
                style={{ textShadow: NAME_SHADOW }}
              >
                {card.title}
              </Tag>
            </div>
          </Html>
        )}
        {herzie && fresh && !bare && (
          <Html
            position={[0, herzie.height * size + 1.4, 0]}
            center
            zIndexRange={[20, 0]}
          >
            <button
              ref={marker}
              type="button"
              onClick={talk}
              aria-label={
                card.notice
                  ? `${card.title} has something for you`
                  : `${card.title} is new in town`
              }
              className="town-new-marker cursor-pointer border-none bg-transparent p-0 font-bold leading-none"
            >
              !
            </button>
          </Html>
        )}
      </group>
    </>
  );
}
