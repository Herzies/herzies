import type { CSSProperties, ReactNode } from "react";
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
} from "../items.js";
import { cx } from "./cx.js";
import { type CardIllustration, ItemCardArt } from "./ItemCardArt.js";
import { TiltCard } from "./TiltCard.js";
import {
  ItemStatLines,
  ItemTypeTag,
  ModifierEffectTag,
  SetTag,
  type TagTooltip,
} from "./tags.js";

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
export function cardFrameBackground(itemId: string, rarity: Rarity): string {
  const gradient = getItemIconGradient(itemId);
  if (gradient) return `linear-gradient(135deg, ${gradient.join(", ")})`;
  const c = ITEM_RARITY_COLORS[rarity];
  return `linear-gradient(135deg, color-mix(in srgb, ${c} 55%, white), color-mix(in srgb, ${c} 75%, #12121e) 35%, color-mix(in srgb, ${c} 40%, #12121e) 70%, color-mix(in srgb, ${c} 70%, #12121e))`;
}

/** The item as a collector card: framed art (its commissioned
 * illustration, or its pixel artwork until it has one), with its name, type,
 * rarity, stats, description and set progress printed on the card, which
 * leans toward the cursor with a rarity-scaled holo foil (TiltCard). Needs
 * the `.holo-*` rules and `--text-ui*` sizes from `@herzies/shared/theme.css`.
 *
 * Just the card: the desktop's inspect modal (ItemPreviewCard) adds its
 * flight and action buttons around it. */
export function ItemCard({
  itemId,
  meta,
  equipped,
  level = 0,
  illustration,
  tooltip,
  className,
}: {
  itemId: string;
  /** Extra line in the card's small print (e.g. owned quantity). */
  meta?: ReactNode;
  /** Current deck, used to show set progress (e.g. "Prismatic set 1/2") —
   * a set effect is only active while its members are equipped, so owning
   * them isn't enough. */
  equipped?: Equipped | null;
  /** Current dice-upgrade level (0-MAX_ITEM_UPGRADE_LEVEL) — renders as a
   * "+N" next to the name and feeds ItemStatLines' effective totals. */
  level?: number;
  /** The item's commissioned illustration, if it has one (see
   * CardIllustration); otherwise the card shows its pixel artwork. */
  illustration?: CardIllustration;
  /** Hover tooltip for the set and modifier tags (see TagTooltip). */
  tooltip?: TagTooltip;
  /** Extra classes on the card itself (the tilting frame). */
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
  const artist = illustration?.artist;

  return (
    <TiltCard
      className={cx(
        "relative w-[218px] rounded-lg p-[5px] shadow-2xl shadow-black/60",
        className,
      )}
      style={
        {
          background: cardFrameBackground(item.id, item.rarity),
          "--foil": RARITY_FOIL[item.rarity],
        } as CSSProperties
      }
    >
      {/* Shows only on the frame: the opaque face below covers the rest. */}
      <div className="holo-foil rounded-lg" />
      <div className="relative flex min-h-[314px] flex-col gap-1.5 rounded-[5px] bg-bg-panel p-1.5 text-left">
        <div className="truncate text-ui font-bold text-text">
          {item.name}
          {level > 0 ? <span className="text-cyan"> +{level}</span> : null}
        </div>

        <div
          data-card-art=""
          className="relative overflow-hidden border-2 bg-bg"
          style={{
            borderColor: `color-mix(in srgb, ${rarityColor} 45%, #2a2a3a)`,
          }}
        >
          {/* Fills the window at 4:3: 192x144 in the desktop, where a 24px
              icon fills its height at exactly 6x. Sized by the window rather
              than in rem, so a host with a smaller root font (the website)
              gets no gap beside it. */}
          <ItemCardArt
            item={item}
            illustration={illustration}
            className="block aspect-[4/3] h-auto w-full"
          />
          {HOLO_ART.has(item.rarity) && (
            <div
              className="holo-foil"
              style={{ "--foil": 0.6 } as CSSProperties}
            />
          )}
        </div>

        <div className="-mt-0.5 flex items-center gap-1">
          <ItemTypeTag item={item} className="shrink-0" />
          <ModifierEffectTag item={item} tooltip={tooltip} />
          <SetTag itemId={itemId} tooltip={tooltip} />
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
            <span className={cx("shrink-0", !artist && "ml-auto")}>
              № {number}/{ITEMS.length}
            </span>
          )}
        </div>
      </div>
      <div className="holo-glare rounded-lg" />
    </TiltCard>
  );
}
