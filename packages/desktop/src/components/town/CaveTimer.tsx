import { Html } from "@react-three/drei";
import { useFrame } from "@react-three/fiber";
import { useEffect, useMemo, useRef, useState } from "react";
import { clock, useCave } from "./cave";
import type { TownMap } from "./map";
import { nameOpacity } from "./nameFade";
import { isMouth } from "./Portals";
import { portalsOf } from "./portal";
import { townSave } from "./runtime";

/** Above the cave's mouth. */
const SIGN_HEIGHT = 3.6;

/**
 * A sign over the cave's mouth: when the boss comes, how long it stays,
 * or that it has fallen. Counts down live, from the same events that put
 * the boss in town.
 */
export function CaveTimer({ map }: { map: TownMap }) {
  const cave = useCave();
  const mouth = useMemo(
    () => portalsOf(map).find((p) => isMouth(p)) ?? null,
    [map],
  );
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (cave.kind !== "open" && cave.kind !== "soon") return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [cave.kind]);
  // The sign fades in as you come near.
  const sign = useRef<HTMLDivElement>(null);
  useFrame(() => {
    if (!mouth || !sign.current) return;
    sign.current.style.opacity = String(
      nameOpacity(Math.hypot(townSave.x - mouth.x, townSave.z - mouth.z)),
    );
  });
  if (!mouth) return null;

  const { text, tone } = (() => {
    switch (cave.kind) {
      case "open":
        return {
          text: `Open · ${clock(cave.endsAt - now)} left`,
          tone: "#ff7a66",
        };
      case "soon":
        return {
          text: `Opens in ${clock(cave.startsAt - now)}`,
          tone: "#ffd98a",
        };
      case "defeated":
        return { text: "Defeated", tone: "#9fe8b0" };
      default:
        return { text: "Sealed", tone: "#a8a2b8" };
    }
  })();

  return (
    <Html
      position={[mouth.x, mouth.y + SIGN_HEIGHT, mouth.z]}
      center
      zIndexRange={[19, 0]}
      style={{ pointerEvents: "none" }}
    >
      <div
        ref={sign}
        role="timer"
        aria-label={`Nohoot Henry's lair: ${text}`}
        className="whitespace-nowrap rounded bg-black/65 px-2 py-1 text-center text-[11px] leading-tight tabular-nums"
        style={{ color: tone, border: `1px solid ${tone}55`, opacity: 0 }}
      >
        <div className="text-[9px] opacity-70">Nohoot Henry's lair</div>
        {text}
      </div>
    </Html>
  );
}
