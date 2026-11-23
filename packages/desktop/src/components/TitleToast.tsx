import { RARITY_COLORS, RARITY_LABELS, type TitleDef } from "@herzies/shared";
import {
  type CSSProperties,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { notify } from "../lib/notices";
import {
  announceTitles,
  isGrandRarity,
  type TitleAnnouncement,
} from "../lib/titles";
import { cn } from "../lib/utils";
import { herzies, useWindowVisible } from "../tauri-bridge";
import { useInDuel } from "./town/duel/store";
import { useHomeMode } from "./town/homeMode";
import { townSave } from "./town/runtime";
import { sfxTitle } from "./town/sfx";

/** How long a toast holds, ms: longer for the rare ones, and for a summary
 * with several names to read. Paused while the mouse is on it. */
const HOLD_MS = { small: 6_000, grand: 9_000, many: 9_000 };
/** Its exit, matching `title-toast-out` in globals.css. */
const EXIT_MS = 260;
/** The sparks thrown out round a legendary or mythic toast. */
const SPARKS = 12;

/**
 * New titles, announced: a toast at the top in the title's colour, with
 * "Wear it". Legendary and mythic ones are bigger, glint, and throw sparks.
 * Three or more at once (the first launch with titles) are one summary
 * that opens the Titles tab.
 *
 * Titles wait in the app's queue (`newTitles`) until one can be shown: the
 * window on screen, no duel on, not in the boss's cave or the Tower. Taken
 * from the queue as they're shown, so each is announced once. (The server
 * already writes them to the activity feed.)
 */
export function TitleToasts({
  newTitles,
  onOpenTitles,
}: {
  newTitles: readonly string[];
  /** Opens the Stats window on its Titles tab. */
  onOpenTitles: () => void;
}) {
  const visible = useWindowVisible();
  const inDuel = useInDuel();
  // Re-rendered on going into (or out of) a fight's island.
  useHomeMode();
  const inFight = townSave.map === "bossroom" || townSave.map === "tower";
  const canShow = visible && !inDuel && !inFight;

  const [queue, setQueue] = useState<TitleAnnouncement[]>([]);
  /** Taken this session, so a state push that still lists them (the ack's
   * on its way) doesn't announce them twice. */
  const taken = useRef(new Set<string>());
  useEffect(() => {
    if (!canShow) return;
    const ids = newTitles.filter((id) => !taken.current.has(id));
    if (ids.length === 0) return;
    for (const id of ids) taken.current.add(id);
    setQueue((q) => [...q, ...announceTitles(ids)]);
    herzies.ackNewTitles(ids).catch(() => {
      // Left queued, they'd come round again next launch: nothing to do.
    });
  }, [newTitles, canShow]);

  const current = canShow ? queue[0] : undefined;
  const done = useCallback(() => setQueue((q) => q.slice(1)), []);
  if (!current) return null;
  return createPortal(
    <Toast
      key={
        current.kind === "one"
          ? current.def.id
          : current.defs.map((d) => d.id).join()
      }
      announcement={current}
      onDone={done}
      onOpenTitles={onOpenTitles}
    />,
    document.body,
  );
}

function Toast({
  announcement,
  onDone,
  onOpenTitles,
}: {
  announcement: TitleAnnouncement;
  onDone: () => void;
  onOpenTitles: () => void;
}) {
  const defs =
    announcement.kind === "one" ? [announcement.def] : announcement.defs;
  const top = defs[0];
  const colour = RARITY_COLORS[top.rarity];
  const grand = isGrandRarity(top.rarity);
  const hold =
    announcement.kind === "many"
      ? HOLD_MS.many
      : grand
        ? HOLD_MS.grand
        : HOLD_MS.small;

  const [leaving, setLeaving] = useState(false);
  const [hovered, setHovered] = useState(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: once, on arrival
  useEffect(() => {
    sfxTitle(grand);
  }, []);
  // Holds while hovered; the full hold again from when the mouse leaves.
  useEffect(() => {
    if (hovered || leaving) return;
    const t = setTimeout(() => setLeaving(true), hold);
    return () => clearTimeout(t);
  }, [hovered, leaving, hold]);
  useEffect(() => {
    if (!leaving) return;
    const t = setTimeout(onDone, EXIT_MS);
    return () => clearTimeout(t);
  }, [leaving, onDone]);

  const wear = (def: TitleDef) => {
    setLeaving(true);
    herzies.wearTitle(def.id).then(
      () => notify(`Now wearing "${def.name}"`, { kind: "success" }),
      (e: unknown) => notify(`Couldn't put "${def.name}" on: ${e}`),
    );
  };

  return (
    <div
      className="pointer-events-none fixed inset-x-0 top-10 z-[390] flex justify-center px-3"
      role="status"
      aria-live="polite"
    >
      <section
        // Held while the mouse is on it, to read or reach for Wear it.
        aria-label="New title"
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        className={cn(
          "pointer-events-auto relative w-full overflow-visible",
          grand ? "max-w-[300px]" : "max-w-[260px]",
          leaving ? "title-toast-out" : "title-toast-in",
        )}
        style={{ "--title-colour": colour } as CSSProperties}
      >
        <div
          className={cn(
            "relative flex flex-col overflow-hidden rounded border bg-bg-panel/90 py-2 pr-2.5 pl-3.5 backdrop-blur-xl",
            grand && "title-toast-glow py-2.5",
          )}
          style={{ borderColor: `${colour}99` }}
        >
          {/* The title's colour down the left edge, as on its row. */}
          <span
            aria-hidden="true"
            className="absolute inset-y-0 left-0 w-1"
            style={{ background: colour }}
          />
          {grand && <span aria-hidden="true" className="title-sheen" />}
          <span
            className="text-[9px] font-bold tracking-[0.14em] uppercase"
            style={{ color: colour }}
          >
            {announcement.kind === "many"
              ? `You earned ${defs.length} titles`
              : `${RARITY_LABELS[top.rarity]} title earned`}
          </span>
          {announcement.kind === "one" ? (
            <>
              <span
                className={cn(
                  "font-bold leading-tight",
                  grand ? "title-glint text-ui-xl" : "text-ui-lg",
                )}
                style={{ color: colour }}
              >
                {top.name}
              </span>
              <span className="text-ui-sm text-text-dim">
                {top.description}
              </span>
              <div className="mt-1.5 flex gap-1.5">
                <button
                  type="button"
                  className="btn h-[20px] px-2 text-ui-sm"
                  style={{ borderColor: colour, color: colour }}
                  onClick={() => wear(top)}
                >
                  Wear it
                </button>
                <button
                  type="button"
                  className="btn h-[20px] border-transparent px-2 text-ui-sm text-text-dim"
                  onClick={() => setLeaving(true)}
                >
                  Later
                </button>
              </div>
            </>
          ) : (
            <>
              <div className="mt-0.5 flex flex-wrap gap-x-2 leading-snug">
                {defs.slice(0, 4).map((d) => (
                  <span
                    key={d.id}
                    className={cn(
                      "text-ui font-bold",
                      isGrandRarity(d.rarity) && "title-glint",
                    )}
                    style={
                      {
                        color: RARITY_COLORS[d.rarity],
                        "--title-colour": RARITY_COLORS[d.rarity],
                      } as CSSProperties
                    }
                  >
                    {d.name}
                  </span>
                ))}
                {defs.length > 4 && (
                  <span className="text-ui text-text-dim">
                    +{defs.length - 4} more
                  </span>
                )}
              </div>
              <div className="mt-1.5 flex gap-1.5">
                <button
                  type="button"
                  className="btn h-[20px] px-2 text-ui-sm"
                  style={{ borderColor: colour, color: colour }}
                  onClick={() => {
                    setLeaving(true);
                    onOpenTitles();
                  }}
                >
                  See titles
                </button>
                <button
                  type="button"
                  className="btn h-[20px] border-transparent px-2 text-ui-sm text-text-dim"
                  onClick={() => setLeaving(true)}
                >
                  Later
                </button>
              </div>
            </>
          )}
        </div>
        {grand && !leaving && <Sparks />}
      </section>
    </div>
  );
}

/** Sparks thrown out from behind the toast, in its colour. */
function Sparks() {
  return (
    <span
      aria-hidden="true"
      className="pointer-events-none absolute inset-0 z-10"
    >
      {Array.from({ length: SPARKS }, (_, i) => {
        const angle = (i / SPARKS) * Math.PI * 2;
        const reach = 70 + (i % 3) * 22;
        return (
          <span
            // biome-ignore lint/suspicious/noArrayIndexKey: fixed sparks, placed by index
            key={i}
            className="title-spark"
            style={
              {
                "--dx": `${Math.cos(angle) * reach * 1.6}px`,
                "--dy": `${Math.sin(angle) * reach * 0.9}px`,
                animationDelay: `${(i % 4) * 40}ms`,
              } as CSSProperties
            }
          />
        );
      })}
    </span>
  );
}
