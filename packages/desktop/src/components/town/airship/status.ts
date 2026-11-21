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
      text: "Blåmann is laid up till the next sailing: please go ashore",
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
    return { text: `Blåmann to ${to} · departs in ${clock(st.until - now)}` };
  }
  const next = nextDeparture(service, dock, now);
  if (next) {
    return {
      text:
        next.dockedFrom > now
          ? `Blåmann boards for ${to} in ${clock(next.dockedFrom - now)}`
          : `Blåmann to ${to} · departs in ${clock(next.departsAt - now)}`,
    };
  }
  if (service && now < service.endsAt + 600_000) {
    return {
      text:
        dock === "wilds"
          ? "Blåmann has sailed home for the last time: you'll be taken back to Town"
          : "Blåmann has made her last sailing for today",
    };
  }
  if (upcoming !== null) {
    const at = new Date(upcoming);
    const when = at.toLocaleString(undefined, {
      weekday: upcoming - now > 86_400_000 ? "short" : undefined,
      hour: "numeric",
      minute: "2-digit",
    });
    return { text: `Blåmann sails to ${to} from ${when}` };
  }
  return {
    text:
      dock === "wilds"
        ? "Blåmann isn't sailing now: you'll be taken back to Town"
        : "Blåmann isn't sailing today",
  };
}
