import { inWildsSafeCamp } from "@herzies/shared/wilds";
import { WILDS_CACHE_HOLD_MS } from "@herzies/shared/wilds-loot";
import { useEffect, useRef, useState } from "react";
import { notify } from "../../../lib/notices";
import { cn } from "../../../lib/utils";
import { townSave } from "../runtime";
import { HUD_LINE } from "../SkillHud";
import "./feel";
import { heldBy, useWildsLoot, wildsLoot } from "./loot";
import { inCombatUntil, useWilds, wilds, wildsOn } from "./store";

/** How often the HUD looks where you stand and what's counting down. */
const LOOK_MS = 250;
/** Set once you've been told the free-for-all starts at the camp's edge. */
const WARNED_KEY = "town.wilds.warned";

/**
 * The Wilds' free-for-all, as lines in the stacked list under the
 * now-playing box (HUD_LINE): whether you're in the safe camp or out where
 * anyone may fight you (with a word the first time you step out), how long
 * your protection lasts, when you get up after being taken down, while
 * you're in combat (no boarding), and your hold on the cache (CacheHud).
 */
export function WildsHud() {
  useWilds();
  const on = wildsOn();
  const now = useNow(on);
  const camp = inWildsSafeCamp(townSave.x, townSave.z);
  const wasCamp = useRef(camp);
  useEffect(() => {
    if (!on) return;
    const left = wasCamp.current && !camp;
    wasCamp.current = camp;
    if (!left || localStorage.getItem(WARNED_KEY)) return;
    localStorage.setItem(WARNED_KEY, "1");
    notify(
      "You've left the safe camp: out here other herzies can fight you. Taken down, you drop a card from your bag where you fall.",
      { kind: "info" },
    );
  }, [on, camp]);
  if (!on || wilds.you === null) return null;
  const me = wilds.standing.get(wilds.you);
  const down = me?.down ?? null;
  const shield = me?.shield ?? null;
  const shut = inCombatUntil();
  const secs = (until: number) => Math.max(1, Math.ceil((until - now) / 1000));
  return (
    <div className="pointer-events-none flex flex-col">
      <div
        role="status"
        className={cn(HUD_LINE, camp ? "text-[#8fe3a8]" : "text-[#ff8a7a]")}
      >
        {camp ? "Safe camp" : "PvP zone"}
      </div>
      {down !== null ? (
        <div role="status" className={cn(HUD_LINE, "text-white")}>
          {wilds.downBy ? <>Taken down by "{wilds.downBy}". </> : null}
          Back in camp in <span className="tabular-nums">{secs(down)}</span> s
        </div>
      ) : null}
      {down === null && shield !== null && shield > now && !camp ? (
        <div className={cn(HUD_LINE, "text-[#a8d4ff]")}>
          Protected for <span className="tabular-nums">{secs(shield)}</span> s
          (until you attack)
        </div>
      ) : null}
      {down === null && shut > now ? (
        <div className={cn(HUD_LINE, "text-[#ffb27a]")}>
          In combat: you can board a ship home in{" "}
          <span className="tabular-nums">{secs(shut)}</span> s
        </div>
      ) : null}
      {down === null ? <CacheHud /> : null}
    </div>
  );
}

/** Your hold on the cache, while you're in its ring, as a line (HUD_LINE):
 * how long yet till it opens, or that it's contested (someone else's hold
 * shows only on the ground, in the ring). On its own in the sandbox. */
export function CacheHud() {
  useWildsLoot();
  const now = useNow(heldBy(wildsLoot.you, performance.now()) !== null);
  const mine = heldBy(wildsLoot.you, now);
  if (mine === null) return null;
  const left = Math.max(1, Math.ceil((WILDS_CACHE_HOLD_MS - mine) / 1000));
  return wildsLoot.hold?.contested ? (
    <div role="status" className={cn(HUD_LINE, "text-[#ff8a7a]")}>
      Contested! Hold the ring alone to open the cache
    </div>
  ) : (
    <div role="status" className={cn(HUD_LINE, "text-[#ffd84a]")}>
      Opening the cache… <span className="tabular-nums">{left}</span> s
    </div>
  );
}

/** performance.now(), every LOOK_MS while `on`. */
function useNow(on: boolean): number {
  const [now, setNow] = useState(() => performance.now());
  useEffect(() => {
    if (!on) return;
    const t = setInterval(() => setNow(performance.now()), LOOK_MS);
    return () => clearInterval(t);
  }, [on]);
  return now;
}
