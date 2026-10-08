import { Html } from "@react-three/drei";
import { useFrame } from "@react-three/fiber";
import { CylinderCollider, RigidBody } from "@react-three/rapier";
import { useEffect, useMemo } from "react";
import { cn } from "../../lib/utils";
import { lookOf } from "../TownScene";
import { ROW_TEXT_SHADOW, VISITOR_THEMES } from "../VisitorRowTheme";
import { turnToward } from "./animation";
import { HerzieSprite } from "./HerzieSprite";
import { NOTICE_RANGE, type TownSpot, townSave } from "./runtime";

/** How quickly a visitor turns to look at you, and back. */
const TURN_RATE = 6;
const MAX_TURN_SPEED = 5;

/**
 * A visitor's spot: a ring on the ground in their colour, and — while
 * they're in town — the visitor themselves, breathing, turning to look at
 * you as you come near, and solid enough to bump into. Their name tag opens
 * them.
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

  // Keyed on who, not on the card object, which is rebuilt every render.
  // biome-ignore lint/correctness/useExhaustiveDependencies: see above
  const sprite = useMemo(() => {
    if (!standing) return null;
    const s = new HerzieSprite(lookOf(card), at.x * 7 + at.z * 3);
    s.heading = plaza;
    s.root.position.set(at.x, 0, at.z);
    return s;
  }, [standing, card.type, card.eventId]);
  useEffect(() => () => sprite?.dispose(), [sprite]);

  useFrame(({ camera }, dt) => {
    if (!sprite) return;
    const dx = townSave.x - at.x;
    const dz = townSave.z - at.z;
    const target =
      Math.hypot(dx, dz) < NOTICE_RANGE ? Math.atan2(dx, dz) : plaza;
    sprite.heading = turnToward(
      sprite.heading,
      target,
      TURN_RATE,
      MAX_TURN_SPEED,
      dt,
    );
    sprite.update(dt, 0, camera);
  });

  const open = card.openKey;
  const Tag = open ? "button" : "div";
  return (
    <>
      {sprite && (
        <>
          <primitive object={sprite.root} />
          <RigidBody type="fixed" colliders={false} position={[at.x, 0, at.z]}>
            <CylinderCollider args={[1, 0.9]} position={[0, 1, 0]} />
          </RigidBody>
        </>
      )}
      <mesh rotation-x={-Math.PI / 2} position={[at.x, 0.03, at.z]}>
        <ringGeometry args={[1.05, 1.25, 40]} />
        <meshBasicMaterial
          color={theme?.accent ?? "#ffffff"}
          transparent
          opacity={live ? 0.85 : 0.25}
          depthWrite={false}
        />
      </mesh>
      <Html
        position={[at.x, (sprite?.height ?? 0) + 0.5, at.z]}
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
            "flex flex-col items-center whitespace-nowrap rounded border-none bg-black/55 px-1.5 py-0.5 text-center",
            open && "cursor-pointer hover:bg-black/75",
          )}
          style={{ textShadow: ROW_TEXT_SHADOW }}
        >
          <span
            className={cn(
              "text-[10px] leading-tight",
              live ? "text-white" : "text-text-dim",
            )}
          >
            {card.title}
          </span>
          <span
            className="text-[9px] leading-tight text-text-dim"
            style={theme ? { color: theme.accent } : undefined}
          >
            {status}
          </span>
        </Tag>
      </Html>
    </>
  );
}
