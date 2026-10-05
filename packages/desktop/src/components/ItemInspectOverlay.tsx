import {
  cardFrameBackground,
  type Equipped,
  equippedItemIds,
  getItem,
  getItemSet,
  RARITY_COLORS as ITEM_RARITY_COLORS,
  ItemCard,
  ItemStatLines,
  ItemTypeTag,
} from "@herzies/shared";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { getCardIllustration } from "../lib/card-art";
import { cn } from "../lib/utils";
import { Tooltip } from "./Tooltip";

/** The item's collector card (ItemCard), as the content of the
 * click-to-inspect modal: the card can fly in from its tile (`flightRef`,
 * `flightLayers`), and `footer` actions render below it, outside the tilt, so
 * the buttons stay put under the cursor. */
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
  /** Current deck, used to show set progress (e.g. "Prismatic set 1/2"). */
  equipped?: Equipped | null;
  /** Current dice-upgrade level (0-MAX_ITEM_UPGRADE_LEVEL). */
  level?: number;
  className?: string;
  /** The card's flying layer (see ItemInspectOverlay's flight): the card,
   * plus `flightLayers`, in one 3D-preserving box — the footer isn't in it. */
  flightRef?: React.Ref<HTMLDivElement>;
  /** Extra layers that fly with the card (the icon it grows from, its back). */
  flightLayers?: React.ReactNode;
  footerRef?: React.Ref<HTMLDivElement>;
}) {
  if (!getItem(itemId)) return null;

  return (
    <div className={cn("flex flex-col items-center", className)}>
      <div ref={flightRef} className="relative transform-3d">
        {/* backface-hidden: mid-spin, the card's back (a flight layer) shows
          instead of its mirrored face. */}
        <div data-card-face="" className="backface-hidden">
          <ItemCard
            itemId={itemId}
            meta={meta}
            equipped={equipped}
            level={level}
            illustration={getCardIllustration(itemId)}
            tooltip={tagTooltip}
          />
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

/** The card's set and modifier tags explain themselves on hover. */
function tagTooltip(label: string, tag: React.ReactElement) {
  return <Tooltip label={label}>{tag}</Tooltip>;
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
/** The flight home retraces the open — spinning back the way it came —
 * but with its own timing: the open's curve played backwards turned its
 * long settle (fine for the big card arriving) into a long crawl of the
 * tiny icon into its tile. Shorter, eased in and out. */
const HOME_MS = 480;
const HOME_EASING = "cubic-bezier(0.45, 0, 0.25, 1)";

/** The card's back, seen mid-spin: the same frame, a patterned face and the
 * rarity diamond the front's small print carries. */
function CardBack({ itemId }: { itemId: string }) {
  const item = getItem(itemId);
  if (!item) return null;
  const rarityColor = ITEM_RARITY_COLORS[item.rarity];
  return (
    <div
      aria-hidden="true"
      data-card-back=""
      className="absolute inset-0 rotate-y-180 rounded-lg p-[5px] backface-hidden"
      style={{ background: cardFrameBackground(item.id, item.rarity) }}
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

/** Marks an element holding an item's icon as somewhere an inspected card
 * can grow out of — a store row, a reward link. Pass
 * `inspectOrigin(key)` as ItemInspectOverlay's `origin`. (The bag and deck
 * use their own flight selectors instead.) */
export const INSPECT_ORIGIN_ATTR = "data-inspect-origin";
export const inspectOrigin = (key: string) =>
  `[${INSPECT_ORIGIN_ATTR}="${CSS.escape(key)}"]`;

/** Puts a copy of `icon` on the card's back, so what flies is exactly the
 * icon it left — the bag's rarity frame, a store row's plain one. */
function copyIconInto(ghost: HTMLElement | null, icon: SVGElement | null) {
  if (!ghost || !icon) return;
  const copy = icon.cloneNode(true) as SVGElement;
  copy.removeAttribute("class");
  copy.style.cssText = "display:block;width:100%;height:100%";
  ghost.replaceChildren(copy);
}

/** The icon `origin` points at — what the card grows out of and shrinks back
 * into. `origin` is a selector for the element holding it (possibly several,
 * comma-separated), resolved fresh each time since the view re-renders and,
 * in the bag, the copy may have moved. */
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
  const backRef = useRef<HTMLElement | null>(null);
  const closing = useRef(false);
  /** The opening flight's animations, while it may still be playing. */
  const opening = useRef<Animation[]>([]);
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
    const ghost = ghostRef.current;
    const flight = flightRef.current;
    const base = flight?.offsetParent?.getBoundingClientRect();
    if (!icon || !ghost || !flight || !base || icon.width === 0) return null;
    // Where the card's icon sits with the card at rest, from layout offsets
    // (which ignore transforms) off its untransformed parent — not its
    // on-screen box: measured mid-3D (the open card, turned and in
    // perspective), WebKit reported it far too small, so the card flew home
    // at nearly full size.
    const side = ghost.offsetWidth;
    const x = base.left + flight.offsetLeft + ghost.offsetLeft + side / 2;
    const y = base.top + flight.offsetTop + ghost.offsetTop + side / 2;
    const dx = icon.left + icon.width / 2 - x;
    const dy = icon.top + icon.height / 2 - y;
    return `perspective(1000px) translate(${dx}px, ${dy}px) scale(${icon.width / side}) rotateY(0deg)`;
  }, [origin]);

  /** One flight, out (open) or home (close). In the bag and the deck a
   * card lies face down — its icon is its back — so it travels turning half
   * over: out from face down on its tile to face up and full size, home the
   * same way back. Its back starts (and ends) as just the icon, the card
   * back's pattern fading in around it as it grows; the front comes into view
   * as the card turns past edge-on. `tile` is the transform that puts the
   * card on the icon (measureFrom). */
  const fly = useCallback((tile: string, way: "out" | "home") => {
    const open = `perspective(1000px) translate(0px, 0px) scale(1) rotateY(360deg)`;
    // Face down: half a turn from face up.
    const faceDown = tile.replace("rotateY(0deg)", "rotateY(180deg)");
    const out = way === "out";
    const timing = {
      duration: out ? FLIGHT_MS : HOME_MS,
      easing: out ? FLIGHT_EASING : HOME_EASING,
      fill: "both" as const,
    };
    // Which side faces you is switched here, exactly at edge-on (halfway:
    // the turn is linear in progress) — not left to backface-visibility,
    // which WebKit (the desktop app's engine) ignores on the card's face:
    // its front showed, mirrored, all the way home.
    const EDGE = 0.5;
    const JUST = 0.0001;
    const animations = out
      ? [
          // Turned 180 + 180·progress: the back faces you until halfway.
          flightRef.current?.animate({ transform: [faceDown, open] }, timing),
          faceRef.current?.animate(
            { opacity: [0, 0, 1, 1], offset: [0, EDGE, EDGE + JUST, 1] },
            timing,
          ),
          ghostRef.current?.animate(
            { opacity: [1, 1, 0, 0], offset: [0, EDGE, EDGE + JUST, 1] },
            timing,
          ),
          // The back's pattern fades in around the icon as the card grows.
          backRef.current?.animate(
            {
              opacity: [0, 1, 1, 0, 0],
              offset: [0, 0.25, EDGE, EDGE + JUST, 1],
            },
            timing,
          ),
          backdropRef.current?.animate(
            { opacity: [0, 1] },
            { ...timing, duration: FLIGHT_MS * 0.6 },
          ),
          footerRef.current?.animate(
            { opacity: [0, 0, 1], offset: [0, 0.7, 1] },
            timing,
          ),
        ]
      : [
          // Turning back the way it came, 360 − 180·progress: the front
          // faces you until halfway, the back from then on.
          flightRef.current?.animate({ transform: [open, faceDown] }, timing),
          faceRef.current?.animate(
            { opacity: [1, 1, 0, 0], offset: [0, EDGE, EDGE + JUST, 1] },
            timing,
          ),
          ghostRef.current?.animate(
            { opacity: [0, 0, 1, 1], offset: [0, EDGE - JUST, EDGE, 1] },
            timing,
          ),
          // Only a glimpse of the back's pattern past edge-on, gone soon
          // after, so it's the icon — not a card-sized back — that shrinks
          // into the tile.
          backRef.current?.animate(
            {
              opacity: [0, 0, 0.6, 0, 0],
              offset: [0, EDGE - JUST, EDGE, 0.65, 1],
            },
            timing,
          ),
          backdropRef.current?.animate(
            { opacity: [1, 0] },
            { ...timing, duration: HOME_MS * 0.7 },
          ),
          footerRef.current?.animate(
            { opacity: [1, 0, 0], offset: [0, 0.2, 1] },
            timing,
          ),
        ];
    if (out) opening.current = animations.filter((a) => a !== undefined);
    return Promise.all(
      animations.map((a) => a?.finished.catch(() => undefined)),
    );
  }, []);

  useLayoutEffect(() => {
    if (!flying) return;
    faceRef.current =
      flightRef.current?.querySelector<HTMLElement>("[data-card-face]") ?? null;
    backRef.current =
      flightRef.current?.querySelector<HTMLElement>("[data-card-back]") ?? null;
    // The icon on the card's back sits behind the art window's middle
    // square, at its full height — the card's horizontal centre, so the
    // half turn (about its centre) keeps it in place.
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
    copyIconInto(ghost, originIcon(origin));
    hidden.current = originIcon(origin);
    if (hidden.current) hidden.current.style.visibility = "hidden";
    fly(from, "out");
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
    const restore = () => {
      if (hidden.current) hidden.current.style.visibility = "";
      hidden.current = null;
    };
    // Dismissed while still opening: play the opening backwards from
    // wherever it's got to, retracing its path into the tile. Starting the
    // flight home instead snapped the card to full size first (that flight
    // starts from the open card), with the unfinished opening showing
    // through around it.
    const stillOpening = opening.current.some((a) => a.playState === "running");
    if (stillOpening) {
      // Every part rewinds from the flight's own elapsed time — the
      // backdrop's shorter fade may have finished already — so they all
      // arrive back together.
      const elapsed = Number(opening.current[0]?.currentTime ?? 0);
      for (const a of opening.current) {
        a.currentTime = Math.min(Number(a.currentTime ?? 0), elapsed);
        a.reverse();
      }
      void Promise.all(
        opening.current.map((a) => a.finished.catch(() => undefined)),
      ).then(() => {
        restore();
        onClose();
      });
      return;
    }
    // Home to wherever the copy's icon is now — it may have moved between
    // bag and deck (Place / Return) while the card was open.
    const from = measureFrom();
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
    // The icon as it is now: the copy may have moved (bag <-> deck).
    copyIconInto(ghostRef.current, originIcon(origin));
    hidden.current = originIcon(origin);
    if (hidden.current) hidden.current.style.visibility = "hidden";
    void fly(from, "home").then(() => {
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

  // At the document's top level, so its z-index outranks everything — a
  // popover it was opened from included (George's help, portalled itself),
  // which the view it's rendered in can't otherwise get above.
  return createPortal(
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
                  // On the card's back: mirrored, so it reads right while the
                  // card is turned over, and a hair toward the back's side.
                  // Plain 2D, no backface-visibility — WebKit (the desktop
                  // app's engine) didn't draw it as a rotated, backface-
                  // hidden layer. The flight shows it only while the back
                  // faces you instead.
                  // Filled with a copy of the origin's icon (copyIconInto).
                  className="pointer-events-none absolute opacity-0 [transform:translateZ(-1px)_scaleX(-1)]"
                />
              </>
            )
          }
        />
      </div>
    </div>,
    document.body,
  );
}
