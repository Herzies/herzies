"use client";

import { useEffect, useState } from "react";
import { MOTION_OK } from "./gsap";

/** Whether to run motion that changes the layout itself (a section that
 * pins, a herzie that travels), not just how things enter. False during
 * server render and the first client render, so the page first shows its
 * still, finished state — which is also all that reduced motion gets. */
export function useMotionOK() {
  const [ok, setOk] = useState(false);
  useEffect(() => {
    const query = window.matchMedia(MOTION_OK);
    const update = () => setOk(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  return ok;
}
