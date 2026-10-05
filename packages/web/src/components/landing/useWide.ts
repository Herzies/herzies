"use client";

import { useEffect, useState } from "react";

/** Whether the viewport is at least Tailwind's `md` (768px). Herzie3D takes
 * its cell size in px rather than from CSS, so sections use this to draw
 * their herzies smaller on phones. False during server render and the first
 * client render, so the two match; it flips straight after. */
export function useWide() {
  const [wide, setWide] = useState(false);
  useEffect(() => {
    const query = window.matchMedia("(min-width: 768px)");
    const update = () => setWide(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  return wide;
}
