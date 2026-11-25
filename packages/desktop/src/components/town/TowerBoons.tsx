import {
  RARITY_COLORS,
  RARITY_FOIL,
  RarityMark,
  rarityFrameBackground,
  TiltCard,
} from "@herzies/shared";
import {
  describeTowerBoon,
  TOWER_BOON_DEFS,
  type TowerBoon,
} from "@herzies/shared/tower";
import { type CSSProperties, useEffect, useRef, useState } from "react";
import { leaveCombat, resumeCombat } from "./combat/Combat";
import { combat } from "./combat/state";
import { townNet } from "./net/townNet";

/**
 * The window a Tower boon is picked in (TOWER_BOON_DEFS): the floor's
 * three offers, each a card in its rarity's frame, or a skip. (What a
 * climb's boons add up to: towerBoonText.)
 */

/** A pick asked for and not answered after this long may be asked again. */
const ANSWER_MS = 2_000;

/** The keys that take an offer while the window's up, by its place (the
 * number row and the pad): ahead of the hotbar's, whatever it's bound to. */
const OFFER_KEYS: Record<string, number> = {
  Digit1: 0,
  Digit2: 1,
  Digit3: 2,
  Numpad1: 0,
  Numpad2: 1,
  Numpad3: 2,
};

/**
 * The pick window, while the climb has `picks` to spend: the floor's
 * `offers`, a card each; a click or its number key (1, 2, 3) takes one,
 * "Skip" takes none (either way the room answers with the floor and the
 * next offers). While it's up the herzie stands still and holds its fire
 * (`combat.picking`: Player and Combat), and the mouse is yours (aiming's
 * let go); once it's gone, aiming comes back if it was on.
 */
export function BoonPick({
  offers,
  picks,
  onClose,
}: {
  offers: readonly TowerBoon[];
  picks: number;
  onClose: () => void;
}) {
  useEffect(() => {
    const aiming = combat.on;
    leaveCombat();
    combat.picking = true;
    return () => {
      combat.picking = false;
      if (aiming) resumeCombat();
    };
  }, []);
  // Asked, for the picks it was asked on: no second pick spent by a quick
  // double click before the room answers.
  const [asked, setAsked] = useState<number | null>(null);
  useEffect(() => {
    if (asked === null) return;
    const t = setTimeout(() => setAsked(null), ANSWER_MS);
    return () => clearTimeout(t);
  }, [asked]);
  const waiting = asked === picks;
  const pick = (offer: number | null) => {
    if (waiting) return;
    if (townNet().sendTowerPick(offer)) setAsked(picks);
  };
  // The number keys, taken before the hotbar hears them (capture, and no
  // one after us), only for offers that are there.
  const pickRef = useRef(pick);
  pickRef.current = pick;
  const count = offers.length;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const i = OFFER_KEYS[e.code];
      if (i === undefined || i >= count) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      if (!e.repeat) pickRef.current(i);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [count]);
  return (
    <div className="pointer-events-none absolute inset-x-0 top-[26%] z-30 flex justify-center">
      <section
        aria-label="Pick a buff"
        className="pointer-events-auto w-[min(32rem,calc(100%-1.5rem))] rounded-xl border border-white/12 bg-black/60 px-3 py-2.5 text-ui text-white shadow-lg backdrop-blur-md"
      >
        <div className="flex items-center">
          <span className="font-bold text-[#ffd84a]">Pick a buff</span>
          {picks > 1 ? (
            <span className="ml-1.5 text-[11px] text-white/60">
              {picks} to pick
            </span>
          ) : null}
          <button
            type="button"
            aria-label="Later"
            title="Later (the floor's card has it)"
            className="ml-auto cursor-pointer rounded border-0 bg-transparent px-1 text-white/60 hover:text-white"
            onClick={onClose}
          >
            ✕
          </button>
        </div>
        <div className="mt-2.5 flex gap-3 px-1">
          {offers.map((boon, i) => (
            <BoonCard
              // biome-ignore lint/suspicious/noArrayIndexKey: an offer is its place in the floor's three
              key={i}
              boon={boon}
              n={i + 1}
              disabled={waiting}
              onPick={() => pick(i)}
            />
          ))}
        </div>
        <div className="mt-2.5 flex items-end gap-3">
          <p className="m-0 text-[9px] leading-3 text-white/50">
            For the rest of this month's climb, in the Tower. You stand still
            while you choose.
          </p>
          <button
            type="button"
            disabled={waiting}
            onClick={() => pick(null)}
            className="ml-auto shrink-0 cursor-pointer rounded border border-white/20 bg-transparent px-2 py-0.5 text-[11px] text-white/70 hover:bg-white/10 hover:text-white disabled:cursor-default disabled:opacity-60"
          >
            Skip
          </button>
        </div>
      </section>
    </div>
  );
}

/** One offer as a collector card: a frame in its rarity's colour that
 * leans toward the cursor with the item cards' foil (stronger the rarer;
 * boon-card in globals.css adds a glow, a breathing one, a turning rainbow
 * edge), its name, what it does, its rarity bottom left and its number
 * key bottom right. */
function BoonCard({
  boon,
  n,
  disabled,
  onPick,
}: {
  boon: TowerBoon;
  n: number;
  disabled: boolean;
  onPick: () => void;
}) {
  const colour = RARITY_COLORS[boon.rarity];
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onPick}
      aria-keyshortcuts={String(n)}
      className="min-w-0 flex-1 cursor-pointer border-0 bg-transparent p-0 text-left disabled:cursor-default disabled:opacity-60"
    >
      <div
        className="boon-card"
        data-rarity={boon.rarity}
        style={{ "--glow": colour } as CSSProperties}
      >
        <TiltCard
          className="relative rounded-lg p-[4px] shadow-xl shadow-black/60"
          style={
            {
              background: rarityFrameBackground(boon.rarity),
              "--foil": RARITY_FOIL[boon.rarity],
            } as CSSProperties
          }
        >
          <div className="holo-foil rounded-lg" />
          <div className="relative flex min-h-[8.5rem] flex-col gap-1 rounded-[5px] bg-bg-panel p-2">
            <div className="text-ui font-bold leading-tight text-text">
              {TOWER_BOON_DEFS[boon.id].name}
            </div>
            <div className="text-[11px] leading-4 text-white/85">
              {describeTowerBoon(boon)}
            </div>
            <div className="mt-auto flex items-center text-[8px]">
              <RarityMark rarity={boon.rarity} />
              <kbd className="ml-auto shrink-0 rounded border border-white/25 bg-black/40 px-1 font-mono text-[9px] leading-[14px] text-white/70">
                {n}
              </kbd>
            </div>
          </div>
          <div className="holo-glare rounded-lg" />
        </TiltCard>
      </div>
    </button>
  );
}
