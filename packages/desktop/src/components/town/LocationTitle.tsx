import { useEffect, useState } from "react";
import { useTownMap } from "./runtime";

/** How long a place's name stays up (ms): the animation's length. */
const SHOWN_MS = 3600;

/** The island whose name was last put up, across remounts (the Town tab
 * coming back isn't arriving anywhere). A ship's deck isn't a place:
 * stepping on and off one at the same dock says nothing; sailing to the
 * other says where you've come. */
let lastShown: string | null = null;

/**
 * The name of where you've just arrived, big over the middle of the view:
 * "Town" as you step off a ship (or through a portal) into it, "The
 * Wilds", "Tower" and so on — each island's own `name`.
 */
export function LocationTitle() {
  const map = useTownMap();
  const [shown, setShown] = useState<{ name: string; key: number } | null>(
    null,
  );
  useEffect(() => {
    if (map.ship || map.id === lastShown) return;
    lastShown = map.id;
    setShown((s) => ({ name: map.name, key: (s?.key ?? 0) + 1 }));
  }, [map]);
  useEffect(() => {
    if (!shown) return;
    const t = setTimeout(() => setShown(null), SHOWN_MS);
    return () => clearTimeout(t);
  }, [shown]);
  if (!shown) return null;
  return (
    <div
      key={shown.key}
      role="status"
      className="pointer-events-none absolute top-[24%] left-1/2 z-30 flex -translate-x-1/2 items-center gap-3 whitespace-nowrap font-bold text-4xl text-white opacity-0 motion-safe:animate-[location-title_3.6s_ease-out_forwards] motion-reduce:opacity-100"
      style={{ textShadow: "0 2px 10px rgba(0,0,0,0.6)" }}
    >
      <span aria-hidden className="h-px w-10 bg-white/60" />
      {shown.name}
      <span aria-hidden className="h-px w-10 bg-white/60" />
    </div>
  );
}
