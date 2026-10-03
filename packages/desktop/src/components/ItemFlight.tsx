import { getItem } from "@herzies/shared";
import { useLayoutEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { ItemTypeIcon } from "./icons/ItemTypeIcon";

/** One card on its way between the bank and the deck. */
export interface Flight {
  id: number;
  itemId: string;
  /** The copy moving — what its landing spot is found by. */
  unitId: string;
  /** Where it took off, captured before the move: the tile or box it left is
   * gone by the time the flight starts. */
  from: { x: number; y: number };
  /** The icon's size there, px. Default: ICON. */
  fromSize?: number;
  /** Finds where it lands. Resolved each frame until it exists, since the
   * landing spot isn't always drawn yet — a card returning to the bank only
   * gets its grid slot once the arrangement reconciles, a render later. */
  target: string;
}

const SPRITE = 24;
/** The icon size a card takes off from when the flight doesn't say: the
 * deck's 16px (the bag's are 24px, and its flights pass that). */
const ICON = 16;
/** Where in the flight the card is back to its landing size — before the end,
 * so the last stretch is at the size it settles at rather than shrinking onto
 * it, which read as a glitch. */
const SETTLE_AT = 0.8;
/** How big a card gets mid-flight, against its sprite: 24px, half again the
 * 16px icon it took off from. */
const PEAK_SCALE = 1;
/** Also the length of the bag badges' fade-in (animate-flight-meta-in in
 * globals.css) — keep the two in step. */
const DURATION_MS = 160;
/** Frames to wait for the landing spot before giving up on the flight — it
 * only happens when the move was refused, and then there's nowhere to go. */
const MAX_WAIT_FRAMES = 20;

function FlightSprite({
  flight,
  onDone,
}: {
  flight: Flight;
  onDone: (id: number) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  // Held in a ref so a parent re-render (every flight landing re-renders the
  // list) doesn't restart this one's animation.
  const onDoneRef = useRef(onDone);
  onDoneRef.current = onDone;

  useLayoutEffect(() => {
    let frame = 0;
    let waited = 0;
    let animation: Animation | undefined;
    const finish = () => onDoneRef.current(flight.id);

    const launch = () => {
      const target = document.querySelector<HTMLElement>(flight.target);
      if (!target) {
        if (++waited > MAX_WAIT_FRAMES) finish();
        else frame = requestAnimationFrame(launch);
        return;
      }
      // A returning card can land on a grid row that's scrolled out of view.
      target.scrollIntoView({ block: "nearest" });
      // Lands exactly on the icon it lands on — the landing spot's own (hidden
      // but laid out) icon, at its size and position. Aiming at the middle of
      // a bag tile instead was half a pixel off where the tile centres its
      // icon, a visible jump at the swap.
      const icon = target.querySelector("svg")?.getBoundingClientRect();
      const to = icon ?? target.getBoundingClientRect();
      const dx = to.left + to.width / 2 - flight.from.x;
      const dy = to.top + to.height / 2 - flight.from.y;
      const start = (flight.fromSize || ICON) / SPRITE;
      const end = (icon?.width || ICON) / SPRITE;
      // The shortest way: every waypoint sits on the straight line from
      // take-off to landing, at the same fraction of the way as of the time,
      // so the card grows and settles without leaving the line.
      const at = (f: number) => ({ x: dx * f, y: dy * f });
      const mid = at(0.45);
      const settle = at(SETTLE_AT);
      animation = ref.current?.animate(
        [
          {
            transform: `translate(0, 0) scale(${start})`,
          },
          {
            transform: `translate(${mid.x}px, ${mid.y}px) scale(${PEAK_SCALE})`,
            offset: 0.45,
          },
          {
            transform: `translate(${settle.x}px, ${settle.y}px) scale(${end})`,
            offset: SETTLE_AT,
          },
          { transform: `translate(${dx}px, ${dy}px) scale(${end})` },
        ],
        {
          duration: DURATION_MS,
          // No easing: a steady speed the whole way.
          easing: "linear",
          fill: "forwards",
        },
      );
      if (animation) animation.onfinish = finish;
      else finish();
    };
    launch();
    return () => {
      cancelAnimationFrame(frame);
      animation?.cancel();
    };
  }, [flight]);

  const def = getItem(flight.itemId);
  if (!def) return null;
  return (
    <div
      ref={ref}
      className="pointer-events-none fixed z-200 flex items-center justify-center"
      style={{
        left: flight.from.x - SPRITE / 2,
        top: flight.from.y - SPRITE / 2,
        width: SPRITE,
        height: SPRITE,
        // Its take-off size, for the frame or two before the animation
        // starts (while the landing spot is found).
        transform: `scale(${(flight.fromSize || ICON) / SPRITE})`,
      }}
    >
      <ItemTypeIcon
        item={def}
        className="h-full w-full drop-shadow-[0_0_4px_rgba(0,0,0,0.8)]"
      />
    </div>
  );
}

/** Every card currently in the air, drawn over the whole window. */
export function ItemFlights({
  flights,
  onDone,
}: {
  flights: Flight[];
  onDone: (id: number) => void;
}) {
  if (flights.length === 0) return null;
  return createPortal(
    flights.map((f) => <FlightSprite key={f.id} flight={f} onDone={onDone} />),
    document.body,
  );
}
