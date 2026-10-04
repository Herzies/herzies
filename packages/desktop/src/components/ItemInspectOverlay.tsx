import {
  type Equipped,
  equippedItemIds,
  getItem,
  getItemIconGradient,
  getItemSet,
  RARITY_COLORS as ITEM_RARITY_COLORS,
  ITEMS,
  RARITY_LABELS,
  type Rarity,
} from "@herzies/shared";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { cn } from "../lib/utils";
import {
  ItemStatLines,
  ItemTypeTag,
  ModifierEffectTag,
  SetTag,
} from "./ItemTypeTag";
import { getCardIllustration, ItemCardArt } from "./icons/ItemCardArt";
import { ItemTypeIcon } from "./icons/ItemTypeIcon";
import { TiltCard } from "./TiltCard";

/** How strongly each rarity's frame shines (the `.holo-foil` layer's
 * `--foil`) — a common card is plain cardstock, a mythic one full foil. */
const RARITY_FOIL: Record<Rarity, number> = {
  common: 0,
  uncommon: 0.35,
  rare: 0.55,
  legendary: 0.8,
  mythic: 1,
};

/** Rarities whose art window is foil too, like a real holo card's. */
const HOLO_ART: ReadonlySet<Rarity> = new Set(["legendary", "mythic"]);

/** The card's metallic frame: the set's gradient for a set member (the same
 * clue its small icon wears), otherwise the rarity colour, lit from the
 * top-left. */
function frameBackground(itemId: string, rarity: Rarity): string {
  const gradient = getItemIconGradient(itemId);
  if (gradient) return `linear-gradient(135deg, ${gradient.join(", ")})`;
  const c = ITEM_RARITY_COLORS[rarity];
  return `linear-gradient(135deg, color-mix(in srgb, ${c} 55%, white), color-mix(in srgb, ${c} 75%, #12121e) 35%, color-mix(in srgb, ${c} 40%, #12121e) 70%, color-mix(in srgb, ${c} 70%, #12121e))`;
}

/** The item as a collector card — framed art (its commissioned
 * illustration, or its pixel icon until it has one), with its name, type,
 * rarity, stats, description and set progress printed on the card, which
 * leans toward the cursor with a rarity-scaled holo foil (TiltCard). The
 * content of the click-to-inspect modal; `footer` actions render below the
 * card, outside the tilt, so the buttons stay put under the cursor. */
export function ItemPreviewCard({
  itemId,
  meta,
  footer,
  equipped,
  level = 0,
  className,
  flightRef,
  flightLayers,
  footerRef,
}: {
  itemId: string;
  /** Extra line in the card's small print (e.g. owned quantity). */
  meta?: React.ReactNode;
  /** Actions rendered below the card (e.g. equip / sell controls). */
  footer?: React.ReactNode;
  /** Current deck, used to show set progress (e.g. "Prismatic set 1/2") —
   * a set effect is only active while its members are equipped, so owning
   * them isn't enough. */
  equipped?: Equipped | null;
  /** Current dice-upgrade level (0-MAX_ITEM_UPGRADE_LEVEL) — renders as a
   * "+N" next to the name and feeds ItemStatLines' effective totals. */
  level?: number;
  className?: string;
  /** The card's flying layer (see ItemInspectOverlay's flight): the card,
   * plus `flightLayers`, in one 3D-preserving box — the footer isn't in it. */
  flightRef?: React.Ref<HTMLDivElement>;
  /** Extra layers that fly with the card (the icon it grows from, its back). */
  flightLayers?: React.ReactNode;
  footerRef?: React.Ref<HTMLDivElement>;
}) {
  const item = getItem(itemId);
  const set = getItemSet(itemId);
  const equippedIds = new Set(equippedItemIds(equipped));
  const equippedCount =
    set?.itemIds.filter((id) => equippedIds.has(id)).length ?? 0;

  if (!item) return null;

  const rarityColor = ITEM_RARITY_COLORS[item.rarity];
  const number = ITEMS.findIndex((i) => i.id === item.id) + 1;
  const artist = getCardIllustration(item.id)?.artist;

  return (
    <div className={cn("flex flex-col items-center", className)}>
      <div ref={flightRef} className="relative transform-3d">
        {/* backface-hidden: mid-spin, the card's back (a flight layer) shows
          instead of its mirrored face. */}
        <div data-card-face="" className="backface-hidden">
          <TiltCard
            className="relative w-[218px] rounded-lg p-[5px] shadow-2xl shadow-black/60"
            style={
              {
                background: frameBackground(item.id, item.rarity),
                "--foil": RARITY_FOIL[item.rarity],
              } as React.CSSProperties
            }
          >
            {/* Shows only on the frame: the opaque face below covers the rest. */}
            <div className="holo-foil rounded-lg" />
            <div className="relative flex min-h-[314px] flex-col gap-1.5 rounded-[5px] bg-bg-panel p-1.5 text-left">
              <div className="flex items-center gap-1">
                <div className="min-w-0 flex-1 truncate text-ui font-bold text-text">
                  {item.name}
                  {level > 0 ? (
                    <span className="text-cyan"> +{level}</span>
                  ) : null}
                </div>
                <ItemTypeTag item={item} className="shrink-0" />
              </div>

              <div
                data-card-art=""
                className="relative overflow-hidden border-2 bg-bg"
                style={{
                  borderColor: `color-mix(in srgb, ${rarityColor} 45%, #2a2a3a)`,
                }}
              >
                {/* 192x144: 4:3, and a 24px icon fills its height at exactly 6x. */}
                <ItemCardArt item={item} className="block h-36 w-48" />
                {HOLO_ART.has(item.rarity) && (
                  <div
                    className="holo-foil"
                    style={{ "--foil": 0.6 } as React.CSSProperties}
                  />
                )}
              </div>

              <div className="-mt-0.5 flex items-center gap-1">
                <ModifierEffectTag item={item} />
                <SetTag itemId={itemId} />
                <span
                  className="ml-auto text-ui-sm italic"
                  style={{ color: rarityColor }}
                >
                  {RARITY_LABELS[item.rarity]}
                </span>
              </div>

              <ItemStatLines
                item={item}
                level={level}
                className="border border-border bg-bg px-1.5 py-1"
              />

              <div className="text-ui-sm italic leading-snug text-text-dim">
                {item.description}
              </div>

              {set && (
                <div className="border-t border-border pt-1 text-ui-sm leading-snug">
                  <div className="font-bold text-text">
                    {set.name} set {equippedCount}/{set.itemIds.length}
                  </div>
                  <div className="text-text-dim">{set.effect}</div>
                  <div>
                    {set.itemIds.map((id, i) => (
                      <span
                        key={id}
                        className={
                          equippedIds.has(id) ? "text-white" : "text-text-dim"
                        }
                      >
                        {i > 0 ? " · " : ""}
                        {getItem(id)?.name ?? id}
                      </span>
                    ))}
                  </div>
                </div>
              )}

              <div className="mt-auto flex items-center gap-1 text-[8px] text-text-dim">
                <span
                  className="inline-block size-1.5 rotate-45"
                  style={{ background: rarityColor }}
                />
                {meta ? <span>{meta}</span> : null}
                {artist ? (
                  <span className="ml-auto truncate italic">
                    Illus. {artist}
                  </span>
                ) : null}
                {number > 0 && (
                  <span className={cn("shrink-0", !artist && "ml-auto")}>
                    № {number}/{ITEMS.length}
                  </span>
                )}
              </div>
            </div>
            <div className="holo-glare rounded-lg" />
          </TiltCard>
        </div>
        {flightLayers}
      </div>
      {footer && (
        <div ref={footerRef} className="mt-3 flex flex-col items-center gap-2">
          {footer}
        </div>
      )}
    </div>
  );
}

/** The condensed hover preview for the bag and the deck: name, type, stats and
 * set progress — no art, icon, rarity or description, so it reads at a glance
 * while browsing. Right-click → Inspect opens the full card. */
export function CompactItemPreview({
  itemId,
  equipped,
  level = 0,
}: {
  itemId: string;
  /** Current deck — for set progress, as in ItemPreviewCard. */
  equipped?: Equipped | null;
  level?: number;
}) {
  const item = getItem(itemId);
  const set = getItemSet(itemId);
  if (!item) return null;
  const equippedIds = new Set(equippedItemIds(equipped));
  const setCount = set?.itemIds.filter((id) => equippedIds.has(id)).length;

  return (
    // Text only, no icon: the card's own tile is right there under the cursor.
    <div className="w-[180px] border border-border bg-bg-panel p-2 text-left shadow-xl shadow-black/50">
      <div className="text-ui font-bold leading-4 text-text">
        {item.name}
        {level > 0 ? <span className="text-cyan"> +{level}</span> : null}
      </div>
      <div className="text-ui-sm">
        <ItemTypeTag item={item} variant="text" />
      </div>
      {/* No margins, so the lines are evenly spaced. */}
      <ItemStatLines item={item} level={level} dim className="text-left" />
      {set && (
        <div className="text-ui-sm text-text-dim">
          {set.name} set {setCount}/{set.itemIds.length}
        </div>
      )}
    </div>
  );
}

/** The flight between a bag/deck icon and the open card, each way. */
const FLIGHT_MS = 650;
const FLIGHT_EASING = "cubic-bezier(0.22, 0.8, 0.24, 1)";
/** FLIGHT_EASING mirrored, for the flight home. Played in reverse, an
 * ease-out turns into an ease-in — slow to leave, fast to land — so the
 * return felt slower; the mirror plays the same fast-then-settle shape
 * backwards. */
const FLIGHT_EASING_HOME = "cubic-bezier(0.76, 0, 0.78, 0.2)";

/** The card's back, seen mid-spin: the same frame, a patterned face and the
 * rarity diamond the front's small print carries. */
function CardBack({ itemId }: { itemId: string }) {
  const item = getItem(itemId);
  if (!item) return null;
  const rarityColor = ITEM_RARITY_COLORS[item.rarity];
  return (
    <div
      aria-hidden="true"
      className="absolute inset-0 rotate-y-180 rounded-lg p-[5px] backface-hidden"
      style={{ background: frameBackground(item.id, item.rarity) }}
    >
      <div
        className="flex h-full items-center justify-center rounded-[5px] bg-bg-panel"
        style={{
          backgroundImage: `radial-gradient(circle, color-mix(in srgb, ${rarityColor} 25%, transparent), transparent 60%), repeating-linear-gradient(45deg, rgb(255 255 255 / 0.04) 0 6px, transparent 6px 12px)`,
        }}
      >
        <span
          className="size-14 rotate-45 border-4 border-bg-panel"
          style={{
            background: rarityColor,
            boxShadow: `0 0 0 3px ${rarityColor}`,
          }}
        />
      </div>
    </div>
  );
}

/** The icon `origin` points at — what the card grows out of and shrinks back
 * into. `origin` is a selector for the tile or deck box (the bag's own
 * flight selectors, possibly several, comma-separated), resolved fresh each
 * time since the bag re-renders and the copy may have moved. */
function originIcon(origin: string | undefined): SVGElement | null {
  if (!origin) return null;
  return document.querySelector(origin)?.querySelector("svg") ?? null;
}

export default function ItemInspectOverlay({
  itemId,
  onClose,
  meta,
  footer,
  equipped,
  level,
  origin,
  closeBlocked = false,
}: {
  itemId: string;
  onClose: () => void;
  /** Extra line in the card's small print (e.g. owned quantity). */
  meta?: React.ReactNode;
  /** Actions rendered below the card (e.g. equip / sell controls). */
  footer?: React.ReactNode;
  /** Current deck, used to show set progress (e.g. "Prismatic set 1/2") —
   * a set effect is only active while its members are equipped, so owning
   * them isn't enough. */
  equipped?: Equipped | null;
  /** Current dice-upgrade level — see ItemPreviewCard. */
  level?: number;
  /** Selector for the bag tile / deck box the card was opened from. With
   * one, the card grows out of that icon — spinning once and turning from
   * the icon into the card on the way — and shrinks back into it on close.
   * Without one it just appears. */
  origin?: string;
  /** Ignore dismissal (backdrop click, Escape) — e.g. while a prompt on top
   * of the card has Escape. Checked before the closing flight starts, so it
   * never flies home only to be refused. */
  closeBlocked?: boolean;
}) {
  const backdropRef = useRef<HTMLDivElement>(null);
  const flightRef = useRef<HTMLDivElement>(null);
  const ghostRef = useRef<HTMLDivElement>(null);
  const footerRef = useRef<HTMLDivElement>(null);
  const faceRef = useRef<HTMLElement | null>(null);
  const closing = useRef(false);
  const hidden = useRef<SVGElement | null>(null);
  const [flying] = useState(
    () =>
      !!originIcon(origin) &&
      !window.matchMedia("(prefers-reduced-motion: reduce)").matches,
  );

  /** The transform that puts the card's art-window icon exactly over
   * `origin`'s icon, or null if that icon is gone (e.g. the copy was
   * equipped and its tile is no more). */
  const measureFrom = useCallback(() => {
    const icon = originIcon(origin)?.getBoundingClientRect();
    const ghost = ghostRef.current?.getBoundingClientRect();
    if (!icon || !ghost || icon.width === 0) return null;
    const dx = icon.left + icon.width / 2 - (ghost.left + ghost.width / 2);
    const dy = icon.top + icon.height / 2 - (ghost.top + ghost.height / 2);
    return `perspective(1000px) translate(${dx}px, ${dy}px) scale(${icon.width / ghost.width}) rotateY(0deg)`;
  }, [origin]);

  /** One flight, out (open) or home (close). The card's transform spins it
   * a full turn while it travels; the icon riding on top fades out as the
   * card's face fades in (the "merge"), with the card's back showing for the
   * half-turn in between. */
  const fly = useCallback((from: string, direction: "normal" | "reverse") => {
    const to =
      "perspective(1000px) translate(0px, 0px) scale(1) rotateY(360deg)";
    const timing = {
      duration: FLIGHT_MS,
      easing: direction === "reverse" ? FLIGHT_EASING_HOME : FLIGHT_EASING,
      direction,
      fill: "both" as const,
    };
    const animations = [
      flightRef.current?.animate({ transform: [from, to] }, timing),
      faceRef.current?.animate(
        { opacity: [0, 0, 1, 1], offset: [0, 0.3, 0.55, 1] },
        timing,
      ),
      ghostRef.current?.animate(
        { opacity: [1, 1, 0, 0], offset: [0, 0.4, 0.7, 1] },
        timing,
      ),
      backdropRef.current?.animate(
        { opacity: [0, 1] },
        {
          ...timing,
          duration: FLIGHT_MS * 0.6,
        },
      ),
      footerRef.current?.animate(
        { opacity: [0, 0, 1], offset: [0, 0.7, 1] },
        timing,
      ),
    ];
    return Promise.all(
      animations.map((a) => a?.finished.catch(() => undefined)),
    );
  }, []);

  useLayoutEffect(() => {
    if (!flying) return;
    faceRef.current =
      flightRef.current?.querySelector<HTMLElement>("[data-card-face]") ?? null;
    // The ghost icon sits over the art window's middle square at its full
    // height. The card's pixel artwork (derived from the icon) draws the
    // icon's face on exactly those pixels, so the frame melts away and the
    // background widens around a picture that doesn't move.
    const flight = flightRef.current?.getBoundingClientRect();
    const art = flightRef.current
      ?.querySelector("[data-card-art]")
      ?.getBoundingClientRect();
    const ghost = ghostRef.current;
    if (!flight || !art || !ghost || !flightRef.current) return;
    // The art window's 2px border isn't art.
    const side = art.height - 4;
    const left = art.left - flight.left + (art.width - side) / 2;
    const top = art.top - flight.top + 2;
    Object.assign(ghost.style, {
      left: `${left}px`,
      top: `${top}px`,
      width: `${side}px`,
      height: `${side}px`,
    });
    // Spin and scale about the icon, so it turns on the spot it grows from.
    flightRef.current.style.transformOrigin = `${left + side / 2}px ${top + side / 2}px`;

    const from = measureFrom();
    if (!from) return;
    // The icon leaves its tile: it's in the air now.
    hidden.current = originIcon(origin);
    if (hidden.current) hidden.current.style.visibility = "hidden";
    fly(from, "normal");
    return () => {
      if (hidden.current) hidden.current.style.visibility = "";
    };
  }, [flying, origin, fly, measureFrom]);

  const requestClose = useCallback(() => {
    if (closeBlocked || closing.current) return;
    closing.current = true;
    if (!flying) {
      onClose();
      return;
    }
    // Home to wherever the copy's icon is now — it may have moved between
    // bag and deck (Place / Return) while the card was open.
    const from = measureFrom();
    const restore = () => {
      if (hidden.current) hidden.current.style.visibility = "";
      hidden.current = null;
    };
    if (!from) {
      // Its icon is gone (sold, say): nowhere to land, so the card fades.
      restore();
      const timing = {
        duration: 200,
        easing: "ease-in",
        fill: "both" as const,
      };
      backdropRef.current?.animate({ opacity: [1, 0] }, timing);
      const fade = flightRef.current?.animate(
        { opacity: [1, 0], scale: [1, 0.92] },
        timing,
      );
      void (fade?.finished ?? Promise.resolve()).finally(onClose);
      return;
    }
    restore();
    hidden.current = originIcon(origin);
    if (hidden.current) hidden.current.style.visibility = "hidden";
    void fly(from, "reverse").then(() => {
      restore();
      onClose();
    });
  }, [closeBlocked, flying, measureFrom, fly, onClose, origin]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") requestClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [requestClose]);

  const item = getItem(itemId);
  if (!item) return null;

  return (
    <div
      onClick={requestClose}
      className="fixed inset-0 z-[1000] flex items-center justify-center"
    >
      {/* Its own layer, so it can fade without fading the card. */}
      <div ref={backdropRef} className="absolute inset-0 bg-black/70" />
      <div className="relative" onClick={(e) => e.stopPropagation()}>
        <ItemPreviewCard
          itemId={itemId}
          meta={meta}
          footer={footer}
          equipped={equipped}
          level={level}
          flightRef={flightRef}
          footerRef={footerRef}
          flightLayers={
            flying && (
              <>
                <CardBack itemId={itemId} />
                <div
                  ref={ghostRef}
                  aria-hidden="true"
                  className="pointer-events-none absolute opacity-0 backface-hidden"
                >
                  <ItemTypeIcon item={item} rarityFrame className="size-full" />
                </div>
              </>
            )
          }
        />
      </div>
    </div>
  );
}
