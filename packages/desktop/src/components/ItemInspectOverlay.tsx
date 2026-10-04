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
import { useEffect } from "react";
import { cn } from "../lib/utils";
import {
  ItemStatLines,
  ItemTypeTag,
  ModifierEffectTag,
  SetTag,
} from "./ItemTypeTag";
import { getCardIllustration, ItemCardArt } from "./icons/ItemCardArt";
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
              {level > 0 ? <span className="text-cyan"> +{level}</span> : null}
            </div>
            <ItemTypeTag item={item} className="shrink-0" />
          </div>

          <div
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
              <span className="ml-auto truncate italic">Illus. {artist}</span>
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
      {footer && (
        <div className="mt-3 flex flex-col items-center gap-2">{footer}</div>
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

export default function ItemInspectOverlay({
  itemId,
  onClose,
  meta,
  footer,
  equipped,
  level,
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
}) {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);

  if (!getItem(itemId)) return null;

  return (
    <div
      onClick={onClose}
      className="fixed inset-0 z-[1000] flex items-center justify-center bg-black/70"
    >
      <div onClick={(e) => e.stopPropagation()}>
        <ItemPreviewCard
          itemId={itemId}
          meta={meta}
          footer={footer}
          equipped={equipped}
          level={level}
        />
      </div>
    </div>
  );
}
