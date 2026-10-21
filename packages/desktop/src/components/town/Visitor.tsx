import { HerzieModel, turnToward } from "@herzies/shared/gl";
import { Html } from "@react-three/drei";
import { useFrame } from "@react-three/fiber";
import { CylinderCollider, RigidBody } from "@react-three/rapier";
import { useEffect, useMemo, useRef } from "react";
import { cn } from "../../lib/utils";
import { lookOf } from "../TownScene";
import { VISITOR_THEMES } from "../VisitorRowTheme";
import { ambient } from "./ambient";
import { markMet, RESIDENTS, useMet } from "./met";
import { NAME_SHADOW, nameOpacity } from "./nameFade";
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
 * over their head (which opens them). Away, there's nothing.
 */
export function Visitor({
  spot,
  ground = 0,
  onOpen,
}: {
  spot: TownSpot;
  /** How high the ground is where they stand. */
  ground?: number;
  onOpen: (openKey: string) => void;
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

  // The name fades in as you come near.
  const name = useRef<HTMLDivElement>(null);
  useFrame((_, dt) => {
    if (!herzie) return;
    const dx = townSave.x - at.x;
    const dz = townSave.z - at.z;
    if (name.current) {
      const o = nameOpacity(Math.hypot(dx, dz));
      name.current.style.opacity = String(o);
      // Not there, so not clickable either.
      name.current.style.pointerEvents = o < 0.1 ? "none" : "";
    }
    const target =
      Math.hypot(dx, dz) < NOTICE_RANGE ? Math.atan2(dx, dz) : plaza;
    herzie.heading = turnToward(
      herzie.heading,
      target,
      TURN_RATE,
      MAX_TURN_SPEED,
      dt,
    );
    herzie.update(dt, 0);
  });

  const open = card.openKey;
  const Tag = open ? "button" : "div";
  // A visitor who's arrived and you haven't talked to yet: a "!" over their
  // head. The residents live here, so they never arrive.
  const met = useMet(card);
  const fresh = !!herzie && live && !!open && !met && !RESIDENTS.has(card.type);
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
            type="fixed"
            colliders={false}
            position={[at.x, ground, at.z]}
          >
            <CylinderCollider args={[1, 0.9 * size]} position={[0, 1, 0]} />
          </RigidBody>
        </>
      )}
      {herzie && (
        <mesh rotation-x={-Math.PI / 2} position={[at.x, ground + 0.03, at.z]}>
          <ringGeometry args={[1.05 * size, 1.05 * size + 0.2, 40]} />
          <meshBasicMaterial
            color={theme?.accent ?? "#ffffff"}
            transparent
            opacity={0.85}
            depthWrite={false}
          />
        </mesh>
      )}
      {herzie && (
        <Html
          position={[at.x, ground + herzie.height * size + 0.5, at.z]}
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
      {herzie && fresh && (
        <Html
          position={[at.x, ground + herzie.height * size + 1.4, at.z]}
          center
          zIndexRange={[20, 0]}
        >
          <button
            type="button"
            onClick={talk}
            aria-label={`${card.title} is new in town`}
            className="town-new-marker cursor-pointer border-none bg-transparent p-0 font-bold leading-none"
          >
            !
          </button>
        </Html>
      )}
    </>
  );
}
