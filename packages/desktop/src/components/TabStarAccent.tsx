import { STAR_TWINKLE_VARIANTS } from "@herzies/shared";
import { useEffect, useState } from "react";

/** Scattered pixel stars around the tab edges (Sky scene glyphs). */
const STAR_SLOTS = [
  { left: "6%", top: "8%" },
  { right: "6%", top: "12%" },
  { left: "10%", bottom: "6%" },
  { right: "8%", bottom: "10%" },
  { left: "42%", top: "4%" },
  { right: "38%", bottom: "4%" },
] as const;

export function TabStarAccent() {
  const [frame, setFrame] = useState(0);

  useEffect(() => {
    const id = setInterval(() => setFrame((f) => f + 1), 200);
    return () => clearInterval(id);
  }, []);

  return (
    <>
      {STAR_SLOTS.map((pos, i) => {
        const idx =
          Math.floor((frame + i * 2) / 3) % STAR_TWINKLE_VARIANTS.length;
        return (
          <span
            key={i}
            className="pointer-events-none absolute font-mono text-[10px] leading-none text-[#ccddee] opacity-80"
            style={pos}
            aria-hidden
          >
            {STAR_TWINKLE_VARIANTS[idx]}
          </span>
        );
      })}
    </>
  );
}
