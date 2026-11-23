import { SpeechBubble, useChatter } from "@herzies/shared";
import { useEffect, useState } from "react";
import { HuntCrystalView } from "./HuntCrystalView";
import { useWildsService, useWildsUpcoming } from "./town/airship/service";
import { skyNow } from "./town/airship/skyClock";
import { huntCrystalLines } from "./town/wilds/huntCrystalLines";
import { huntNow, useWildsLoot, wildsLoot } from "./town/wilds/loot";

/** How often its lines are worked out again: the countdown in them is to
 * the second (useChatter keeps them through a ref, so this doesn't cut it
 * off mid-sentence). */
const TICK_MS = 1000;

/**
 * The Hunt Crystal, talked to in the Wilds' safe camp: how full of gold it
 * is and how soon it's full, or which way its treasure lies (what the room
 * says; see huntCrystalLines.ts). A click on it moves it on a line.
 */
export function HuntCrystalPanel({ paused }: { paused: boolean }) {
  const service = useWildsService();
  const upcoming = useWildsUpcoming();
  useWildsLoot();
  const [now, setNow] = useState(() => skyNow());
  useEffect(() => {
    if (paused) return;
    setNow(skyNow());
    const id = setInterval(() => setNow(skyNow()), TICK_MS);
    return () => clearInterval(id);
  }, [paused]);
  const hunt = wildsLoot.hunt;
  const charge = huntNow(performance.now());
  const { line, typed, advance } = useChatter(
    huntCrystalLines(
      service,
      upcoming,
      wildsLoot.cache,
      hunt && { charge, rate: hunt.rate, listeners: hunt.listeners },
      now,
    ),
    !paused,
  );
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      <div className="text-center text-[16px] font-bold text-[#ffc61a]">
        The Hunt Crystal
      </div>
      <div className="relative flex h-[190px] shrink-0 flex-col">
        <div className="flex min-h-0 flex-1 items-center justify-center overflow-hidden">
          <HuntCrystalView
            charge={charge}
            hunt={wildsLoot.cache !== null}
            paused={paused}
            talking={!!line && typed < line.length}
          />
        </div>
        <button
          type="button"
          aria-label="Talk to the Hunt Crystal"
          onClick={advance}
          className="absolute inset-0 z-[2] cursor-pointer border-none bg-transparent p-0"
        />
        <SpeechBubble line={line} typed={typed} />
      </div>
    </div>
  );
}
