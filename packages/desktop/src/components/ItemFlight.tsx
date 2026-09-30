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
  /** Finds where it lands. Resolved each frame until it exists, since the
   * landing spot isn't always drawn yet — a card returning to the bank only
   * gets its grid slot once the arrangement reconciles, a render later. */
  target: string;
}

const SPRITE = 24;
const DURATION_MS = 320;
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
      const to = target.getBoundingClientRect();
      const dx = to.left + to.width / 2 - flight.from.x;
      const dy = to.top + to.height / 2 - flight.from.y;
      animation = ref.current?.animate(
        [
          { transform: "translate(0, 0) scale(1)" },
          {
            transform: `translate(${dx / 2}px, ${dy / 2 - 24}px) scale(1.4)`,
            offset: 0.45,
          },
          { transform: `translate(${dx}px, ${dy}px) scale(0.85)` },
        ],
        {
          duration: DURATION_MS,
          easing: "cubic-bezier(0.3, 0.7, 0.4, 1)",
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
