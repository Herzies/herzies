import { STAR_TWINKLE_VARIANTS } from "@herzies/shared";
import { useEffect, useState } from "react";
import { useWindowFocused } from "../tauri-bridge";

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
  // Frozen while nobody can see it, like VisitorSparkles — it shows whenever a
  // visitor is in town, which can be hours of a hidden window re-rendering at
  // 5fps.
  const focused = useWindowFocused();

  useEffect(() => {
    if (!focused) return;
    const id = setInterval(() => setFrame((f) => f + 1), 200);
    return () => clearInterval(id);
  }, [focused]);

  return (
    // Fixed-size positioning box, centered on the tab and independent of its
    // rendered width, so the sparkle never changes the tab's own layout size.
    <span
      className="pointer-events-none absolute left-1/2 top-0 h-full w-16 -translate-x-1/2"
      aria-hidden
    >
      {STAR_SLOTS.map((pos, i) => {
        const idx =
          Math.floor((frame + i * 2) / 3) % STAR_TWINKLE_VARIANTS.length;
        return (
          <span
            key={i}
            className="absolute font-mono text-[10px] leading-none text-[#ccddee] opacity-80"
            style={pos}
          >
            {STAR_TWINKLE_VARIANTS[idx]}
          </span>
        );
      })}
    </span>
  );
}
