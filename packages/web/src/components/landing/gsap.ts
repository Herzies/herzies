"use client";

import { useGSAP } from "@gsap/react";
import gsap from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";

// Registered once, here, so every landing section imports gsap from this
// module rather than repeating the setup.
gsap.registerPlugin(ScrollTrigger, useGSAP);
// The mobile address bar showing and hiding resizes the viewport; with
// full-height sections that would re-measure every trigger mid-scroll.
ScrollTrigger.config({ ignoreMobileResize: true });

/** Motion only for people who haven't asked for less of it. Animations go
 * inside `gsap.matchMedia().add(MOTION_OK, ...)`, so with reduced motion
 * everything simply stays where the markup put it. */
export const MOTION_OK = "(prefers-reduced-motion: no-preference)";

export { gsap, ScrollTrigger, useGSAP };
