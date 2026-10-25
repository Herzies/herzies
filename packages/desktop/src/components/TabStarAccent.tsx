import { STAR_TWINKLE_VARIANTS } from "@herzies/shared";
import { useEffect, useState } from "react";
import { useWindowFocused } from "../tauri-bridge";

/** Pixel stars (Sky scene glyphs) on the button's edges: its corners and
 * its top and bottom borders, half in and half out, clear of the label. */
const STAR_SLOTS = [
  { left: "-1px", top: "-3px" },
  { right: "-1px", top: "-2px" },
  { left: "0px", bottom: "-3px" },
  { right: "-2px", bottom: "-2px" },
  { left: "40%", top: "-4px" },
  { right: "35%", bottom: "-4px" },
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
    // Over the whole button (which positions it), out of the layout, so the
    // sparkle never changes the button's size.
    <span className="pointer-events-none absolute inset-0" aria-hidden>
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
