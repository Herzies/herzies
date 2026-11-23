import { useEffect, useState } from "react";
import { cn } from "../../../lib/utils";
import { townSave, useTownMap } from "../runtime";
import { HUD_LINE } from "../SkillHud";
import { berthOf } from "./berth";
import { dockOf, noShipHome, shipAt } from "./boarding";
import { fleet } from "./fleet";
import { useWildsService, useWildsUpcoming } from "./service";
import { aboardStatus, type DockStatus, dockStatus } from "./status";

/** How often the board is read again (ms). */
const LOOK_MS = 200;
/** Near enough the pier's end to read the board (world units). */
const NEAR = 16;

/**
 * The Sky Dock's departures board, as a line in the stacked list under
 * the now-playing box (HUD_LINE): near the dock, when the next ship to
 * the far end boards and leaves (anywhere on the Wilds, once there's none
 * to come and you're about to be sent home); aboard, when it casts off
 * and when you'll be there, with how far along the flight is under it.
 */
export function SkyDockHud() {
  const map = useTownMap();
  const service = useWildsService();
  const upcoming = useWildsUpcoming();
  const [status, setStatus] = useState<DockStatus | null>(null);
  useEffect(() => {
    // A new status only when what it says has changed: not a render every
    // look.
    const show = (next: DockStatus | null) =>
      setStatus((was) =>
        was?.text === next?.text && was?.progress === next?.progress
          ? was
          : next,
      );
    const look = () => {
      const now = fleet.now;
      if (!now) return show(null);
      if (map.ship)
        return show(aboardStatus(fleet.poses[townSave.ship].state, now));
      const dock = dockOf(map);
      const b = dock ? berthOf(map) : null;
      const near =
        !!b &&
        Math.hypot(townSave.x - b.pierEnd.x, townSave.z - b.pierEnd.z) <= NEAR;
      if (!dock || !b || !(near || (dock === "wilds" && noShipHome())))
        return show(null);
      const k = shipAt(dock);
      show(
        dockStatus(
          dock,
          service,
          upcoming,
          k === null ? null : { ship: k, state: fleet.poses[k].state },
          now,
        ),
      );
    };
    look();
    const id = setInterval(look, LOOK_MS);
    return () => clearInterval(id);
  }, [map, service, upcoming]);
  if (!status) return null;
  return (
    <div className="pointer-events-none flex flex-col">
      <div
        role="status"
        className={cn(HUD_LINE, "text-[#f5d38a] tabular-nums")}
      >
        {status.text}
      </div>
      {status.progress !== undefined ? (
        <div className="mx-0.5 mt-0.5 mb-1 h-0.5 w-36 overflow-hidden rounded-full bg-black/40">
          <div
            className="h-full rounded-full bg-[#f5d38a] transition-[width] duration-200 ease-linear"
            style={{ width: `${status.progress * 100}%` }}
          />
        </div>
      ) : null}
    </div>
  );
}
