import type { ShipIndex, SkyDock } from "@herzies/shared";
import * as THREE from "three";
import { townSave } from "../runtime";
import {
  sfxShipBell,
  sfxShipCreak,
  sfxShipHorn,
  sfxShipThunk,
  shipAmbience,
} from "../sfx";
import { fleet } from "./fleet";

/**
 * What a sky ship sounds like, and when: cues on the timetable (a long
 * horn a quarter-minute before it leaves, the bell twice at ten seconds,
 * three times at five, a creak as it lifts, the horn again as it comes in,
 * a thunk as it touches down and as its gangplank lands), heard from
 * wherever you are by how far off it is; and, near or aboard, the engines
 * and the wind. Every client plays the same cues at the same moments, from
 * the timetable alone.
 */

/** When each cue goes, relative to the moment it's tied to (ms). */
const HORN_BEFORE = 15_000;
const BELL_TWICE = 10_000;
const BELL_THRICE = 5_000;
const APPROACH_HORN = 9_000;
const PLANK_LANDS = 3_000;

/** A bell's last ringing: when its sound started (fleet time, ms) and how
 * many strikes (bell.ts poses the bell from these, on the same clock). */
export type BellRing = { at: number; strikes: number };

/** When each ship's bell last rang, and each dock's — which rings with
 * the ship's lying there. */
export const shipBells: Record<ShipIndex, BellRing> = {
  0: { at: Number.NEGATIVE_INFINITY, strikes: 0 },
};
export const dockBells: Record<SkyDock, BellRing> = {
  home: { at: Number.NEGATIVE_INFINITY, strikes: 0 },
  wilds: { at: Number.NEGATIVE_INFINITY, strikes: 0 },
};

/** The fleet time the cues were last stepped to (NaN: never). */
let last = Number.NaN;
const at = new THREE.Vector3();
const ear = new THREE.Vector3();
/** The ride's ambience, handed to shipAmbience each frame. */
const ambience = { near: 0, speed: 0, throttle: 0 };

/** How loud something this far off is (1 up close). */
const loudness = (d: number) => 1 / (1 + (d / 28) ** 2);

/** Where the listener is: set by the camera's owner each frame. */
export function setListener(camera: THREE.Camera): void {
  camera.getWorldPosition(ear);
}

/** Play whatever cues ship `ship` passed since last frame, and set the
 * ride's ambience. `deck` is its deck's group in the scene, already moved
 * for this frame. */
export function stepShipSounds(ship: ShipIndex, deck: THREE.Object3D): void {
  const now = fleet.now;
  const before = last;
  last = now;
  deck.getWorldPosition(at);
  const aboard = townSave.map === "airship" && townSave.ship === ship;
  const d = aboard ? 0 : at.distanceTo(ear);
  const p = fleet.poses[ship];
  // The engines and the wind: only close enough to hear.
  ambience.near = aboard ? 1 : Math.max(0, 1 - d / 45);
  ambience.speed = p.speed;
  ambience.throttle = p.throttle;
  shipAmbience.set(ambience);
  if (Number.isNaN(before) || now - before > 1000) return;
  const crossed = (t: number) => before < t && now >= t;
  const st = p.state;
  // The bell: seen swinging (from this frame, as its sound starts)
  // however far off it's heard, or if it isn't.
  const strikes =
    st.kind !== "docked" || st.until === null
      ? 0
      : crossed(st.until - BELL_TWICE)
        ? 2
        : crossed(st.until - BELL_THRICE)
          ? 3
          : 0;
  if (strikes && st.kind === "docked")
    for (const bell of [shipBells[ship], dockBells[st.at]]) {
      bell.at = now;
      bell.strikes = strikes;
    }
  const vol = loudness(d);
  if (vol < 0.02) return;
  if (strikes) sfxShipBell(strikes, vol);
  if (st.kind === "docked") {
    if (crossed(st.since + PLANK_LANDS)) sfxShipThunk(vol * 0.6);
    if (st.until !== null && crossed(st.until - HORN_BEFORE)) sfxShipHorn(vol);
  } else {
    if (crossed(st.departedAt + 400)) sfxShipCreak(vol);
    if (crossed(st.arrivesAt - APPROACH_HORN)) sfxShipHorn(vol);
    if (crossed(st.arrivesAt - 30)) {
      sfxShipThunk(vol);
      sfxShipCreak(vol * 0.7);
    }
  }
}
