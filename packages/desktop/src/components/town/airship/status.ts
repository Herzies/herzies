import {
  nextDeparture,
  type ShipIndex,
  type ShipState,
  type SkyDock,
  type WildsService,
} from "@herzies/shared";
import { mapById } from "../maps";
import { farEnd } from "./boarding";

/**
 * What the Sky Dock's board says, and what the ship you're on says: when
 * the next one leaves, how long till you're there. Pure, from the
 * timetable and where you are, so it's tested without a world.
 */

export type DockStatus = {
  /** The line to show. */
  text: string;
  /** In flight: how far along, 0–1. */
  progress?: number;
};

/** "m:ss". */
export function clock(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** When a sailing at `at` is, as the board puts it: the time, and the day
 * too if it's more than a day off. */
export function sailingTime(at: number, now: number): string {
  return new Date(at).toLocaleString(undefined, {
    weekday: at - now > 86_400_000 ? "short" : undefined,
    hour: "numeric",
    minute: "2-digit",
  });
}

const placeName = (dock: SkyDock) => mapById(dock).name;
const toward = (dock: SkyDock) => (dock === "home" ? "Town" : placeName(dock));

/** Aboard, the ship in state `st`. */
export function aboardStatus(st: ShipState, now: number): DockStatus {
  if (st.kind === "flying") {
    const span = st.arrivesAt - st.departedAt;
    return {
      text: `Arriving at ${placeName(st.to)} in ${clock(st.arrivesAt - now)}`,
      progress: Math.min(1, Math.max(0, (now - st.departedAt) / span)),
    };
  }
  if (st.until === null) {
    return {
      text: "Sofia III is laid up till the next sailing: please go ashore",
    };
  }
  return {
    text: `Departs for ${toward(farEnd(st.at))} in ${clock(st.until - now)}`,
  };
}

/** By the Sky Dock on `dock`: the ship there (if any) and the timetable. */
export function dockStatus(
  dock: SkyDock,
  service: WildsService | null,
  upcoming: number | null,
  docked: { ship: ShipIndex; state: ShipState } | null,
  now: number,
): DockStatus {
  const to = toward(farEnd(dock));
  const st = docked?.state;
  if (st?.kind === "docked" && st.until !== null) {
    return { text: `Sofia III to ${to} · departs in ${clock(st.until - now)}` };
  }
  const next = nextDeparture(service, dock, now);
  if (next) {
    return {
      text:
        next.dockedFrom > now
          ? `Sofia III boards for ${to} in ${clock(next.dockedFrom - now)}`
          : `Sofia III to ${to} · departs in ${clock(next.departsAt - now)}`,
    };
  }
  if (service && now < service.endsAt + 600_000) {
    return {
      text:
        dock === "wilds"
          ? "Sofia III has sailed home for the last time: you'll be taken back to Town"
          : "Sofia III has made her last sailing for today",
    };
  }
  if (upcoming !== null) {
    return {
      text: `Sofia III sails to ${to} from ${sailingTime(upcoming, now)}`,
    };
  }
  return {
    text:
      dock === "wilds"
        ? "Sofia III isn't sailing now: you'll be taken back to Town"
        : "Sofia III isn't sailing today",
  };
}
