import { Html } from "@react-three/drei";
import { useFrame } from "@react-three/fiber";
import { CylinderCollider, RigidBody } from "@react-three/rapier";
import { useEffect, useMemo } from "react";
import { cn } from "../../lib/utils";
import { lookOf } from "../TownScene";
import { ROW_TEXT_SHADOW, VISITOR_THEMES } from "../VisitorRowTheme";
import { turnToward } from "./animation";
import { HerzieModel } from "./HerzieModel";
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
  onOpen,
}: {
  spot: TownSpot;
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
    const s = new HerzieModel(lookOf(card), at.x * 7 + at.z * 3);
    s.heading = plaza;
    s.root.position.set(at.x, 0, at.z);
    s.root.scale.setScalar(size);
    return s;
  }, [standing, card.type, card.eventId]);
  useEffect(() => () => herzie?.dispose(), [herzie]);

  useFrame((_, dt) => {
    if (!herzie) return;
    const dx = townSave.x - at.x;
    const dz = townSave.z - at.z;
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
  return (
    <>
      {herzie && (
        <>
          <primitive object={herzie.root} />
          <RigidBody type="fixed" colliders={false} position={[at.x, 0, at.z]}>
            <CylinderCollider args={[1, 0.9 * size]} position={[0, 1, 0]} />
          </RigidBody>
        </>
      )}
      {herzie && (
        <mesh rotation-x={-Math.PI / 2} position={[at.x, 0.03, at.z]}>
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
          position={[at.x, herzie.height * size + 0.5, at.z]}
          center
          // Under the app's own overlays (chat, menus), not drei's default
          // of nearly the top of the stack.
          zIndexRange={[20, 0]}
        >
          <Tag
            {...(open
              ? { type: "button" as const, onClick: () => onOpen(open) }
              : {})}
            aria-label={`${card.title}: ${status}`}
            className={cn(
              "whitespace-nowrap rounded border-none bg-black/55 px-1.5 py-0.5 text-[10px] leading-tight text-white",
              open && "cursor-pointer hover:bg-black/75",
            )}
            style={{ textShadow: ROW_TEXT_SHADOW }}
          >
            {card.title}
          </Tag>
        </Html>
      )}
    </>
  );
}
