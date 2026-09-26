/**
 * Item definitions with 3D ASCII art renderers.
 * Ported from CLI — uses HTML color spans instead of chalk.
 *
 * Two independent rendering rigs live here: the flat rotating card/icon rig
 * (CORNERS/UVS/renderIconCard, used by every card-type item) and Power
 * Dice's own rendered-cube rig (DICE_CORNERS/DICE_FACES/renderPowerDiceFrame,
 * see the block comment above it) — a die needed to read as an actual solid,
 * not a card with a die-face icon painted on it. Both share `project`/
 * `triUV`, nothing else.
 */

// Imported from the leaf module rather than the package barrel: the barrel
// re-exports this file, and that cycle left RAINBOW_RAMP undefined while the
// item frames were being generated at module load.
import {
  CHAR_ASPECT,
  col,
  cross,
  dot3,
  LIGHT,
  normV,
  OCEAN_RAMP,
  RAINBOW_RAMP,
  RAMP_ITEM,
  rotX,
  rotY,
  rotZ,
  TEAL_RAMP,
  type V2,
  type V3,
  VIOLET_RAMP,
} from "./ascii3d.js";
import { BOSS_DAMAGE_PER_MINUTE } from "./types.js";

export type Rarity = "common" | "uncommon" | "rare" | "legendary";

/** Inventory grouping. Most items are cards (some grant a visual, some a bonus); "misc" is for non-card items. */
export type ItemCategory = "deck" | "misc";

/** Catalog equip categories (item.equip_slot). Ground items choose a side at equip time.
 * "modifier" stacks up to MAX_MODIFIERS — see EQUIPPED_SLOTS below, it isn't one of the
 * single-value slots. */
export const EQUIP_SLOTS = [
  "head",
  "face",
  "body",
  "scenery",
  "ground",
  "color",
  "modifier",
] as const;
export type EquipSlot = (typeof EQUIP_SLOTS)[number];

/** Single-value keys stored on herzies.equipped — ground splits into left/right instance
 * slots. Modifier items are tracked separately via the `modifier` array on Equipped, since
 * any number of them can be equipped at once (see Equipped below). */
export const EQUIPPED_SLOTS = [
  "head",
  "face",
  "body",
  "scenery",
  "ground_left",
  "ground_right",
  "color",
] as const;
export type EquippedSlot = (typeof EQUIPPED_SLOTS)[number];

/** Modifier items stack in Equipped.modifier, but only up to this many at once
 * (enforced server-side in the equip route; the desktop UI also disables the
 * Equip action once this cap is hit, for instant feedback). */
export const MAX_MODIFIERS = 6;

export type GroundSide = "left" | "right";

/** Slot-keyed map of currently equipped item IDs. `modifier` is a list (up to
 * MAX_MODIFIERS) rather than a single-value slot, since more than one modifier
 * item can be equipped at once. */
export type Equipped = Partial<Record<EquippedSlot, string>> & {
  modifier?: string[];
};

export function groundSlot(side: GroundSide): EquippedSlot {
  return side === "left" ? "ground_left" : "ground_right";
}

/** The catalog equip slot an item must have to fill a given stored slot —
 * the inverse of the ground split, since both ground_left and ground_right
 * are filled by items whose catalog `equipSlot` is plain "ground". Every
 * other key is spelled identically in both sets. */
export function equipSlotFor(slot: EquippedSlot): EquipSlot {
  return slot === "ground_left" || slot === "ground_right" ? "ground" : slot;
}

/** Which side a ground slot key refers to, for the reverse trip. */
export function groundSideOf(slot: EquippedSlot): GroundSide | undefined {
  if (slot === "ground_left") return "left";
  if (slot === "ground_right") return "right";
  return undefined;
}

export function equippedItemIds(
  equipped: Equipped | null | undefined,
): string[] {
  if (!equipped) return [];
  const single = Object.values(equipped).filter(
    (id): id is string => typeof id === "string" && id.length > 0,
  );
  return [...single, ...(equipped.modifier ?? [])];
}

export function findEquippedSlot(
  equipped: Equipped | null | undefined,
  itemId: string,
): EquippedSlot | null {
  if (!equipped) return null;
  for (const slot of EQUIPPED_SLOTS) {
    if (equipped[slot] === itemId) return slot;
  }
  return null;
}

export function isModifierEquipped(
  equipped: Equipped | null | undefined,
  itemId: string,
): boolean {
  return !!equipped?.modifier?.includes(itemId);
}

/** Every player's starting bank capacity: the desktop Cards grid's first
 * three rows of six (see InventoryView's GRID_COLS, which must stay in sync
 * with this). A player's actual capacity is this plus what they've bought —
 * see `bankCapacity`. Exported here so non-UI code (e.g. deciding whether to
 * warn before a purchase or pickup) doesn't have to duplicate the
 * slot-counting rules below. */
export const BANK_SLOT_COUNT = 18;

/** Slots one Inventory Expansion adds. Two full grid rows, so the extra
 * capacity always lands on whole rows of the scrolling grid. */
export const BANK_EXPANSION_SLOTS = 12;

/** How many expansions one player can own. Enforced at checkout only — never
 * once the money is taken — so two concurrent checkouts can overshoot it by
 * one, which is harmless. */
export const MAX_BANK_EXPANSIONS = 5;

/** A player's bank capacity given how many expansions they own. Everything
 * that asks "is there room" takes this rather than reading BANK_SLOT_COUNT,
 * so a bought expansion is honoured everywhere at once. Tolerates a missing or
 * junk count (an older payload) as none owned. */
export function bankCapacity(expansions: number | null | undefined): number {
  const owned =
    typeof expansions === "number" && Number.isFinite(expansions)
      ? Math.max(0, Math.floor(expansions))
      : 0;
  return BANK_SLOT_COUNT + owned * BANK_EXPANSION_SLOTS;
}

/** The only two item facts bank-slot counting needs. */
export interface BankItemInfo {
  stackable?: boolean;
  category: ItemCategory;
}

/**
 * Resolves those facts for an item id. Defaults to the bundled catalog; server
 * code that has no catalog (the Edge Functions) passes one built from the
 * `items` table instead, so there is one slot-counting implementation rather
 * than a second one to keep in sync.
 */
export type BankItemLookup = (itemId: string) => BankItemInfo | undefined;

const catalogBankLookup: BankItemLookup = (itemId) => {
  const item = getItem(itemId);
  if (!item) return undefined;
  return { stackable: item.stackable, category: getItemCategory(item) };
};

/** How many bank slots (see `bankCapacity`) `inventory`
 * currently needs: one slot per stackable item id owned (any quantity),
 * plus one per unit of a non-stackable item — except whatever's currently
 * equipped, which reserves a unit as "worn" and frees its bank slot. Mirrors
 * the slot-key expansion InventoryView uses to lay out its grid. */
export function bankSlotsUsed(
  inventory: Record<string, number> | null | undefined,
  equipped: Equipped | null | undefined,
  lookup: BankItemLookup = catalogBankLookup,
): number {
  if (!inventory) return 0;
  let count = 0;
  for (const [itemId, qty] of Object.entries(inventory)) {
    if (qty <= 0) continue;
    const item = lookup(itemId);
    if (item && item.category !== "deck") continue;
    const isEquipped =
      findEquippedSlot(equipped, itemId) !== null ||
      isModifierEquipped(equipped, itemId);
    if (item?.stackable) {
      // A stackable item frees its slot only once every owned copy is
      // equipped — applyEquip never lets the same id occupy two modifier
      // slots, so "equipped" here means at most one unit is worn.
      if (!isEquipped || qty > 1) count += 1;
      continue;
    }
    count += Math.max(0, isEquipped ? qty - 1 : qty);
  }
  return count;
}

/** Whether the bank has no free slot left for a fresh item — see
 * bankSlotsUsed. `capacity` is the player's own (`bankCapacity`), required
 * rather than defaulted so a caller that forgets it fails to compile instead of
 * quietly treating an expanded bank as the starting 18. */
export function isBankFull(
  inventory: Record<string, number> | null | undefined,
  equipped: Equipped | null | undefined,
  capacity: number,
  lookup: BankItemLookup = catalogBankLookup,
): boolean {
  return bankSlotsUsed(inventory, equipped, lookup) >= capacity;
}

/**
 * Whether one more of `itemId` would fit in the bank.
 *
 * Not the same question as `isBankFull`: a stackable item the player already
 * owns shares its existing slot, so it still fits at capacity. Gate item
 * *acquisition* on this rather than on `isBankFull`, or a full bank wrongly
 * blocks picking up another copy of something already stacked there.
 *
 * Pass a `lookup` to source item facts from somewhere other than the bundled
 * catalog — server code can build one from the `items` table.
 */
export function hasRoomFor(
  inventory: Record<string, number> | null | undefined,
  equipped: Equipped | null | undefined,
  itemId: string,
  capacity: number,
  lookup: BankItemLookup = catalogBankLookup,
): boolean {
  const current = inventory ?? {};
  const next = { ...current, [itemId]: (current[itemId] ?? 0) + 1 };
  return bankSlotsUsed(next, equipped, lookup) <= capacity;
}

/** Normalize API/cache payloads that may still be a legacy string[]. */
export function normalizeEquipped(raw: unknown): Equipped {
  if (!raw || typeof raw !== "object") return {};
  if (Array.isArray(raw)) {
    // Legacy array — drop side info; callers should re-equip after migration.
    return {};
  }
  const out: Equipped = {};
  for (const slot of EQUIPPED_SLOTS) {
    const v = (raw as Record<string, unknown>)[slot];
    if (typeof v === "string" && v.length > 0) out[slot] = v;
  }
  const modifierRaw = (raw as Record<string, unknown>).modifier;
  if (Array.isArray(modifierRaw)) {
    const ids = modifierRaw.filter(
      (id): id is string => typeof id === "string" && id.length > 0,
    );
    if (ids.length > 0) out.modifier = ids;
  } else if (typeof modifierRaw === "string" && modifierRaw.length > 0) {
    out.modifier = [modifierRaw];
  }
  return out;
}

/** Where a unit is worn: one of the stored slot keys, or "modifier" for the
 * capped list. Mirrors item_units.equipped_slot. */
export type UnitSlot = EquippedSlot | "modifier";

/**
 * One owned copy of an item — the unit of ownership. It is what a bank tile is,
 * what gets sold, traded and worn, and what a dice upgrade lands on.
 *
 * Until these existed an item was only a count against its catalog id, so
 * anything that could differ between two copies (an upgrade level) could only
 * be a property of the whole item type: upgrade one Box of Boom and every Box
 * of Boom was upgraded.
 *
 * `inventory`/`equipped`/`itemUpgrades` still exist as derived views (the
 * server recomputes them from the units) for readers that only need "how many"
 * or "which ids are worn"; anything that has to tell copies apart reads these.
 */
export interface ItemUnit {
  id: string;
  itemId: string;
  upgradeLevel: number;
  equippedSlot: UnitSlot | null;
}

const UNIT_SLOTS: readonly string[] = [...EQUIPPED_SLOTS, "modifier"];

/** Parse an untrusted units payload (an API response, a local cache), dropping
 * anything malformed rather than trusting its shape. */
export function normalizeUnits(raw: unknown): ItemUnit[] {
  if (!Array.isArray(raw)) return [];
  const out: ItemUnit[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const r = entry as Record<string, unknown>;
    if (typeof r.id !== "string" || typeof r.itemId !== "string") continue;
    out.push({
      id: r.id,
      itemId: r.itemId,
      upgradeLevel: typeof r.upgradeLevel === "number" ? r.upgradeLevel : 0,
      equippedSlot:
        typeof r.equippedSlot === "string" &&
        UNIT_SLOTS.includes(r.equippedSlot)
          ? (r.equippedSlot as UnitSlot)
          : null,
    });
  }
  return out;
}

/** `{itemId: count}` — the legacy inventory shape, derived. */
export function unitsToInventory(
  units: readonly ItemUnit[],
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const u of units) out[u.itemId] = (out[u.itemId] ?? 0) + 1;
  return out;
}

/** The id-keyed `Equipped` shape (what the renderer draws from), derived. The
 * modifier list keeps the order the units arrive in. */
export function unitsToEquipped(units: readonly ItemUnit[]): Equipped {
  const equipped: Equipped = {};
  const modifier: string[] = [];
  for (const u of units) {
    if (u.equippedSlot === null) continue;
    if (u.equippedSlot === "modifier") modifier.push(u.itemId);
    else equipped[u.equippedSlot] = u.itemId;
  }
  if (modifier.length > 0) equipped.modifier = modifier;
  return equipped;
}

/**
 * One tile in the bank grid. A stack of interchangeable copies (a stackable
 * item, which never carries per-unit state) is one tile with a count; every
 * other copy is a tile of its own, since each has its own upgrade level.
 */
export interface BankTile {
  /** A stable identity for arranging tiles in the grid: the copy's own id for
   * a single copy, `stack:<itemId>` for a stack. */
  key: string;
  itemId: string;
  /** The copies behind this tile — one for a single copy, every unworn copy of
   * a stack (oldest first). */
  unitIds: string[];
  /** Upgrade level of a single copy; always 0 for a stack. */
  upgradeLevel: number;
}

/**
 * The bank grid's tiles: every unworn copy in the "deck" category, with a
 * stackable item's copies folded into one tile. Always exactly as many tiles as
 * `bankSlotsUsed` counts slots — they are the same rule, one returning the
 * tiles and the other their number.
 */
export function bankTiles(
  units: readonly ItemUnit[],
  lookup: BankItemLookup = catalogBankLookup,
): BankTile[] {
  const tiles: BankTile[] = [];
  const stacks = new Map<string, BankTile>();
  for (const u of units) {
    if (u.equippedSlot !== null) continue;
    const info = lookup(u.itemId);
    if (info && info.category !== "deck") continue;
    if (info?.stackable) {
      const stack = stacks.get(u.itemId);
      if (stack) {
        stack.unitIds.push(u.id);
      } else {
        const tile: BankTile = {
          key: `stack:${u.itemId}`,
          itemId: u.itemId,
          unitIds: [u.id],
          upgradeLevel: 0,
        };
        stacks.set(u.itemId, tile);
        tiles.push(tile);
      }
    } else {
      tiles.push({
        key: u.id,
        itemId: u.itemId,
        unitIds: [u.id],
        upgradeLevel: u.upgradeLevel,
      });
    }
  }
  return tiles;
}

/** Copies of one item, plainest first — unworn before worn, then lowest level,
 * then in the order given (oldest first). What "sell/offer N of this item"
 * means when it can't say which copies: a spare goes before one you've
 * invested in or are wearing. */
export function unitsPlainestFirst(
  units: readonly ItemUnit[],
  itemId: string,
): ItemUnit[] {
  return units
    .filter((u) => u.itemId === itemId)
    .map((u, order) => ({ u, order }))
    .sort(
      (a, b) =>
        Number(a.u.equippedSlot !== null) - Number(b.u.equippedSlot !== null) ||
        a.u.upgradeLevel - b.u.upgradeLevel ||
        a.order - b.order,
    )
    .map(({ u }) => u);
}

/** The ids of the `quantity` plainest copies of an item, or null if the player
 * doesn't own that many. */
export function pickPlainestUnitIds(
  units: readonly ItemUnit[],
  itemId: string,
  quantity: number,
): string[] | null {
  const ordered = unitsPlainestFirst(units, itemId);
  return ordered.length >= quantity
    ? ordered.slice(0, quantity).map((u) => u.id)
    : null;
}

/** Copies of one item, best first — worn before unworn, then highest level,
 * then in the order given. The copy worth keeping when the rest are spares. */
export function unitsBestFirst(
  units: readonly ItemUnit[],
  itemId: string,
): ItemUnit[] {
  return units
    .filter((u) => u.itemId === itemId)
    .map((u, order) => ({ u, order }))
    .sort(
      (a, b) =>
        Number(b.u.equippedSlot !== null) - Number(a.u.equippedSlot !== null) ||
        b.u.upgradeLevel - a.u.upgradeLevel ||
        a.order - b.order,
    )
    .map(({ u }) => u);
}

/** The copy of an item that "the item" most plausibly means: the one worn if
 * any, else the best one owned. For surfaces that only know an item id. */
export function bestUnitOf(
  units: readonly ItemUnit[],
  itemId: string,
): ItemUnit | undefined {
  return unitsBestFirst(units, itemId)[0];
}

/** Why an equip/unequip can't be applied. Whether an item is equipable at all
 * is the caller's lookup (the `equipSlot` it passes in). */
export type EquipRejection =
  | "not-owned"
  | "already-equipped"
  | "not-equipped"
  | "max-modifiers"
  | "missing-side"
  | "no-slot";

export type EquipOutcome =
  | { ok: true; units: ItemUnit[] }
  | { ok: false; reason: EquipRejection };

/**
 * What equipping or unequipping one specific unit does. The equip_unit RPC does
 * the same thing under a row lock to persist it; the desktop applies this to
 * predict the result, and sharing the rules is what lets the prediction match
 * the server's answer so the real response lands as a no-op rather than a
 * visible correction.
 *
 * Pure: never mutates `units`. `equipSlot` is passed in because the server
 * reads it from the items row and the client from the bundled catalog.
 *
 * Two behaviours worth knowing:
 *  - Equipping a copy of an item whose OTHER copy is worn is a swap, never a
 *    second equip — one copy of an item worn at a time has always been the
 *    rule, and it's what stops a stat being counted twice.
 *  - Equipping into an occupied single-value slot displaces the incumbent
 *    (swapping a hat shouldn't need an explicit unequip first); the displaced
 *    copy returns to the bank.
 */
export function applyEquip(
  units: readonly ItemUnit[],
  unitId: string,
  action: "equip" | "unequip",
  equipSlot: EquipSlot | undefined,
  side?: GroundSide,
): EquipOutcome {
  const unit = units.find((u) => u.id === unitId);
  if (!unit) return { ok: false, reason: "not-owned" };

  if (action === "unequip") {
    if (unit.equippedSlot === null)
      return { ok: false, reason: "not-equipped" };
    return {
      ok: true,
      units: units.map((u) =>
        u.id === unitId ? { ...u, equippedSlot: null } : u,
      ),
    };
  }

  if (!equipSlot) return { ok: false, reason: "no-slot" };

  let slot: UnitSlot;
  if (equipSlot === "ground") {
    if (side !== "left" && side !== "right") {
      return { ok: false, reason: "missing-side" };
    }
    slot = groundSlot(side);
  } else {
    // Ruling out "ground" narrows EquipSlot to exactly the members UnitSlot
    // also has, so no cast is needed.
    slot = equipSlot;
  }

  if (unit.equippedSlot === slot) {
    return { ok: false, reason: "already-equipped" };
  }

  if (slot === "modifier") {
    const others = units.filter(
      (u) => u.equippedSlot === "modifier" && u.itemId !== unit.itemId,
    ).length;
    if (others >= MAX_MODIFIERS) return { ok: false, reason: "max-modifiers" };
  }

  return {
    ok: true,
    units: units.map((u) => {
      if (u.id === unitId) return { ...u, equippedSlot: slot };
      // The other worn copy of this item, if any — the swap.
      if (u.itemId === unit.itemId && u.equippedSlot !== null) {
        return { ...u, equippedSlot: null };
      }
      // Whoever held a single-value slot before.
      if (slot !== "modifier" && u.equippedSlot === slot) {
        return { ...u, equippedSlot: null };
      }
      return u;
    }),
  };
}

export type SellRejection = "not-sellable" | "not-enough";

export type SellOutcome =
  | {
      ok: true;
      units: ItemUnit[];
      earned: number;
      newCurrency: number;
    }
  | { ok: false; reason: SellRejection };

/**
 * What selling specific units does. The sell_units RPC persists it under a row
 * lock; the desktop predicts it so the grid and coin move on click instead of
 * after the round trip.
 *
 * Pure: never mutates `units`. A worn copy that is sold simply stops being
 * worn — it no longer exists — so ownership and equip state can't drift apart.
 * `sellPriceOf` is the caller's price lookup (the items row on the server, the
 * bundled catalog on the client); no price means not sellable.
 */
export function applySell(
  units: readonly ItemUnit[],
  currency: number,
  unitIds: readonly string[],
  sellPriceOf: (itemId: string) => number | undefined,
): SellOutcome {
  const wanted = new Set(unitIds);
  if (wanted.size === 0) return { ok: false, reason: "not-enough" };

  const chosen = units.filter((u) => wanted.has(u.id));
  if (chosen.length !== wanted.size) return { ok: false, reason: "not-enough" };

  let earned = 0;
  for (const u of chosen) {
    const price = sellPriceOf(u.itemId);
    if (!price) return { ok: false, reason: "not-sellable" };
    earned += price;
  }

  return {
    ok: true,
    units: units.filter((u) => !wanted.has(u.id)),
    earned,
    newCurrency: currency + earned,
  };
}

/** How many times a card can be upgraded — Power Dice 1 and any future dice
 * item share this cap. The level-cap check inside apply_item_upgrade
 * (00079_item_units.sql) and item_units.upgrade_level's CHECK can't import this
 * constant — it's duplicated there as a bare 3, and they must stay in sync
 * (same arrangement as GROUND_DROP_CAP/BANK_SLOT_COUNT). */
export const MAX_ITEM_UPGRADE_LEVEL = 3;

export type ItemUpgradeRejection =
  | "not-dice"
  | "dice-not-owned"
  | "target-not-owned"
  | "not-statted"
  | "max-level";

export type ItemUpgradeOutcome =
  | {
      ok: true;
      /** Units with one die consumed and the target's level raised by one. */
      units: ItemUnit[];
      newLevel: number;
    }
  | { ok: false; reason: ItemUpgradeRejection };

/**
 * What applying a die to one specific card does — raises THAT unit's level and
 * no other's, which is the whole point. The apply_item_upgrade RPC re-validates
 * ownership and the level cap under a row lock; the desktop predicts it so the
 * "+N" appears on click instead of after the round trip.
 *
 * Pure: never mutates `units`. Dice are fungible, so which die is consumed
 * doesn't matter (the first unworn one, matching the RPC). "Is this a statted
 * card" can only be checked here (and in the upgrade API route) since `stats`
 * lives only in this TS catalog, never in the DB `items` table.
 */
export function applyItemUpgrade(
  units: readonly ItemUnit[],
  diceItemId: string,
  targetUnitId: string,
): ItemUpgradeOutcome {
  if (!getItem(diceItemId)?.dice) return { ok: false, reason: "not-dice" };

  const dice = units.find(
    (u) => u.itemId === diceItemId && u.equippedSlot === null,
  );
  if (!dice) return { ok: false, reason: "dice-not-owned" };

  const target = units.find((u) => u.id === targetUnitId);
  if (!target) return { ok: false, reason: "target-not-owned" };

  const targetStats = getItem(target.itemId)?.stats;
  if (!targetStats || Object.keys(targetStats).length === 0) {
    return { ok: false, reason: "not-statted" };
  }

  if (target.upgradeLevel >= MAX_ITEM_UPGRADE_LEVEL) {
    return { ok: false, reason: "max-level" };
  }

  const newLevel = target.upgradeLevel + 1;
  return {
    ok: true,
    units: units
      .filter((u) => u.id !== dice.id)
      .map((u) => (u.id === target.id ? { ...u, upgradeLevel: newLevel } : u)),
    newLevel,
  };
}

/** The stats a herzie has. Add a key here (and a label in STAT_LABELS) and
 * every item, tooltip and total below picks it up. */
export const STAT_KEYS = ["sonicPower", "luck"] as const;
export type StatKey = (typeof STAT_KEYS)[number];

/** What an item adds to its wearer. Most items add nothing, so every key is
 * optional and an item with no `stats` is the norm. */
export type ItemStats = Partial<Record<StatKey, number>>;

/** A herzie's totals: what its equipped items add up to. Derived from
 * `equipped` every time it is needed, never stored, so unequipping an item
 * takes its stats with it and there is nothing to keep in sync. */
export type HerzieStats = Record<StatKey, number>;

export const STAT_LABELS: Record<StatKey, string> = {
  sonicPower: "Sonic power",
  luck: "Luck",
};

export interface ItemDef {
  id: string;
  name: string;
  description: string;
  rarity: Rarity;
  frames: string[][]; // Each frame is an array of lines (with HTML color spans)
  /** Whether owning more than one is allowed (gates re-buying from the
   * store). Independent of equipable/equipSlot — see getItemType — so an
   * item can be both stackable and equipable. A stackable item must never
   * carry per-unit state (an upgrade level), or its copies stop being
   * interchangeable and can't share a tile. */
  stackable?: boolean;
  equipable?: boolean;
  /** Catalog category; ground items occupy ground_left or ground_right when equipped,
   * modifier items stack unbounded in Equipped.modifier. */
  equipSlot?: EquipSlot;
  sellPrice?: number;
  /** Set when the item can be bought with in-game currency from the store's Items tab. */
  buyPrice?: number;
  /** Inventory sub-tab grouping. Defaults to "deck" when unset. */
  category?: ItemCategory;
  /** Stats added to the herzie while this is equipped. Most items have none. */
  stats?: ItemStats;
  /** Set when the item has a gameplay effect while equipped (e.g. an XP bonus), not just cosmetic. */
  modifier?: {
    /** Short label for the effect badge, e.g. "Exp boost". */
    label: string;
    /** Hover detail, e.g. "2% per song hunt won". */
    tooltip: string;
  };
  /** Set when the item modifies another item rather than being worn itself
   * (e.g. Power Dice 1, applied to a statted card — see applyItemUpgrade).
   * Mutually exclusive with equipable/equipSlot in practice — see
   * getItemType, which checks this first. */
  dice?: boolean;
}

export function getItemCategory(item: Pick<ItemDef, "category">): ItemCategory {
  return item.category ?? "deck";
}

/** Display classification, derived from the equip fields rather than stored directly. */
export type ItemType =
  | "dice"
  | "skin"
  | "sceneryCard"
  | "equipable"
  | "accessory"
  | "modifier"
  | "artefact";

export function getItemType(
  item: Pick<ItemDef, "equipable" | "equipSlot" | "modifier" | "dice">,
): ItemType {
  if (item.dice) return "dice";
  if (item.equipSlot === "color") return "skin";
  if (item.equipSlot === "modifier") return "modifier";
  if (item.equipSlot === "scenery") return "sceneryCard";
  if (item.equipSlot === "ground") return "accessory";
  if (item.equipable) return "equipable";
  return "artefact";
}

export const ITEM_TYPE_LABELS: Record<ItemType, string> = {
  dice: "Dice",
  skin: "Skin",
  sceneryCard: "Scenery",
  equipable: "Equipable",
  accessory: "Accessory",
  modifier: "Modifier",
  artefact: "Artefact",
};

/** Names a catalog equip slot. Finer-grained than ITEM_TYPE_LABELS, which
 * groups head/face/body together as one "Equipable" type: a deck box holds
 * exactly one of those slots, so naming the slot is what tells the player
 * why an empty Equipment box offers hats but not shirts. */
export const EQUIP_SLOT_LABELS: Record<EquipSlot, string> = {
  head: "Head",
  face: "Face",
  body: "Body",
  scenery: "Scenery",
  ground: "Accessory",
  color: "Skin",
  modifier: "Modifier",
};

/** A set is a named group of items whose `effect` describes what equipping
 * all of them together does — membership is purely by `itemIds`, not a
 * field on ItemDef, so adding an item to a set never touches its own entry. */
export interface ItemSet {
  id: string;
  /** Display name, e.g. "Prismatic". */
  name: string;
  /** What equipping the full set does — shown on each member's item preview. */
  effect: string;
  /** Item ids that make up this set. */
  itemIds: string[];
  /** Shared visual clue applied to every member's small card icon, on top of
   * whatever shape that item's own icon has — e.g. a rainbow gradient fill
   * instead of the item's usual solid dominant-colour tint, so set members
   * read as related regardless of their individual icon depiction. */
  visual?: { gradient: readonly string[] };
}

export const ITEM_SETS: ItemSet[] = [
  {
    id: "prismatic",
    name: "Prismatic",
    effect: "Even more rainbow",
    itemIds: ["rainbow-headband", "prism"],
    visual: { gradient: RAINBOW_RAMP },
  },
];

export function getItemSet(itemId: string): ItemSet | undefined {
  return ITEM_SETS.find((set) => set.itemIds.includes(itemId));
}

/** Whether every item in `set` is currently equipped. */
export function isSetFullyEquipped(
  equipped: Equipped | null | undefined,
  set: ItemSet,
): boolean {
  const ids = new Set(equippedItemIds(equipped));
  return set.itemIds.every((id) => ids.has(id));
}

/** Drives the inventory "Deck" slot row: one entry per visual group, in
 * left-to-right display order. `slots` is either the ordered list of
 * single-value EquippedSlot keys in the group (box i ↔ slots[i]), or the
 * literal "modifier" for the capped modifier array (box i ↔ equipped.modifier[i]).
 * `itemType` selects the icon + ITEM_TYPE_TEXT_CLASSES color for filled boxes. */
export interface DeckSlotGroup {
  label: string;
  itemType: ItemType;
  slots: EquippedSlot[] | "modifier";
  count: number;
}

export const DECK_SLOT_GROUPS: DeckSlotGroup[] = [
  {
    label: "Equipment",
    itemType: "equipable",
    slots: ["head", "face", "body"],
    count: 3,
  },
  {
    label: "Accessories",
    itemType: "accessory",
    slots: ["ground_left", "ground_right"],
    count: 2,
  },
  { label: "Scenery", itemType: "sceneryCard", slots: ["scenery"], count: 1 },
  {
    label: "Modifiers",
    itemType: "modifier",
    slots: "modifier",
    count: MAX_MODIFIERS,
  },
  { label: "Skin", itemType: "skin", slots: ["color"], count: 1 },
];

/** Total fixed slot capacity across all groups (3+2+1+6+1 = 13). */
export const DECK_TOTAL_SLOTS = DECK_SLOT_GROUPS.reduce(
  (sum, g) => sum + g.count,
  0,
);

export const RARITY_COLORS: Record<Rarity, string> = {
  common: "#9d9d9d",
  uncommon: "#1eff00",
  rare: "#0070dd",
  legendary: "#ff8000",
};

export const RARITY_LABELS: Record<Rarity, string> = {
  common: "Common",
  uncommon: "Uncommon",
  rare: "Rare",
  legendary: "Legendary",
};

/** Relative weight for random world drops — common is heaviest, legendary
 * lightest.
 *
 * Deliberately on a 1000-scale rather than the 100-scale this used to use.
 * Only the ratios matter, but legendary sat at the minimum useful integer
 * (1), and that made the tier impossible to tune *down*: shrinking uncommon
 * and rare to sharpen the curve shrinks the total, so a fixed legendary
 * weight of 1 gained share instead of losing it (100/15/3/1 moved the one
 * legendary from ~97h of listening to ~81h — the opposite of the intent).
 * The extra digit is the headroom to move every tier in the direction
 * intended.
 *
 * Roughly, at the current pool and one guaranteed drop per DROP_TICK_MINUTES:
 * a non-CD item lands about every 57 minutes of listening, a given uncommon
 * every ~5.4h, a given rare every ~32h, and the lone legendary every ~270h
 * (it is also buyable, which is the intended path for most players). */
export const RARITY_DROP_WEIGHTS: Record<Rarity, number> = {
  common: 1000,
  uncommon: 150,
  rare: 25,
  legendary: 3,
};

/** Items that can never appear as a random world drop, regardless of rarity. */
export const NON_DROPPABLE_ITEM_IDS = ["first-edition", "spirit-orb"] as const;

/** How many uncollected drops may stand on the ground at once.
 *
 * At the cap a rolled drop is *forfeited*, not queued: the roll is spent and
 * nothing lands. That is deliberate — a queue would make the cap invisible
 * (everything owed would still arrive eventually) and would leave a player
 * who ignores the ground for a month with a month of drops waiting. Losing
 * drops to a full ground is also what makes an auto-collecting pet (the
 * Greedy Spirit) worth equipping rather than a convenience.
 *
 * Enforced in the `roll_pending_drops` SQL function, under a row lock, so
 * concurrent syncs can't both claim the last slot. This constant is the
 * documented copy for client-side use; the number itself is duplicated there
 * and the two must stay in sync (same arrangement as BANK_SLOT_COUNT). */
export const GROUND_DROP_CAP = 10;

/** Listened minutes that earn one drop roll. Eligibility is a counter diff on
 * total_minutes_listened, not a wall-clock timer — see processSync step 5. */
export const DROP_TICK_MINUTES = 10;

/** Chance a drop is rolled on each eligible listening tick (see DROP_TICK_MINUTES).
 * 1 = guaranteed — every 10-minute tick drops something, with which item
 * decided by ITEM_DROP_WEIGHT_OVERRIDES / RARITY_DROP_WEIGHTS below. */
export const DROP_CHANCE_PER_TICK = 1;

/** Ceiling on how many owed rolls a single sync may award. The desktop path
 * never owes more than one (its minutes are capped per sync), but the Spotify
 * cron passes uncapped catch-up minutes and could otherwise owe dozens at
 * once. Anything above this carries over to the next sync rather than being
 * written off — see the drop_rolls_done bookkeeping in processSync. */
export const MAX_DROP_ROLLS_PER_SYNC = 20;

/** Per-item drop-weight overrides, applied instead of RARITY_DROP_WEIGHTS when
 * present. CDs are earned purely by listening (not by any special rarity),
 * so they're weighted well above even the heaviest common item to make them
 * the most likely drop by a wide margin. */
export const ITEM_DROP_WEIGHT_OVERRIDES: Partial<Record<string, number>> = {
  cd: 4000,
};

/** How much luck nudges a rarity's drop weight, as a fraction of that
 * rarity's own weight per point of luck — e.g. rare: 0.015 means +10 luck
 * multiplies every rare candidate's weight by 1 + 10*0.015 = 1.15 (+15%).
 * Scales up with rarity so the bias reads as "toward better stuff," not a
 * flat tax on the whole pool, while staying the "very minor" nudge luck was
 * scoped as: at the live droppable pool (12 items: 1 common-override cd, 6
 * uncommon, 5 rare — power-dice-1 included, spirit-orb excluded per
 * NON_DROPPABLE_ITEM_IDS), +10 luck (First Edition Card's whole
 * contribution) moves a single rare item's odds from 0.498% to 0.565% of
 * any roll (+13.6% relative), a single uncommon's from 2.985% to 3.095%
 * (+3.7% relative), and cd's from 79.60% to 78.60% (-1.3% relative). Common
 * is 0 so cd — the guaranteed-cadence item, see ITEM_DROP_WEIGHT_OVERRIDES —
 * stays luck-independent. Legendary is filled in for completeness even
 * though no droppable legendary exists today (spirit-orb is the only one,
 * and it's in NON_DROPPABLE_ITEM_IDS). These numbers shift again whenever
 * the droppable pool's item/rarity mix changes — recompute rather than trust
 * them blindly. */
export const RARITY_LUCK_WEIGHT_BONUS: Record<Rarity, number> = {
  common: 0,
  uncommon: 0.005,
  rare: 0.015,
  legendary: 0.03,
};

/** Weighted-random pick from a rarity-tagged candidate pool. `luck` (default
 * 0, a herzie's summed luck stat — see getHerzieStats) biases which
 * candidate wins via RARITY_LUCK_WEIGHT_BONUS. `rng` returns a float in
 * [0, 1) — inject Math.random in production, a seeded fn in tests. */
export function pickWeightedDrop<T extends { id: string; rarity: Rarity }>(
  candidates: T[],
  luck = 0,
  rng: () => number = Math.random,
): T | undefined {
  if (candidates.length === 0) return undefined;
  const weights = candidates.map((c) => {
    const base =
      ITEM_DROP_WEIGHT_OVERRIDES[c.id] ?? RARITY_DROP_WEIGHTS[c.rarity];
    return base * (1 + luck * RARITY_LUCK_WEIGHT_BONUS[c.rarity]);
  });
  const total = weights.reduce((a, b) => a + b, 0);
  let r = rng() * total;
  for (let i = 0; i < candidates.length; i++) {
    r -= weights[i];
    if (r <= 0) return candidates[i];
  }
  return candidates[candidates.length - 1];
}

// --- Constants ---
const SW = 30;
const SH = 18;
const CARD_HW = 0.85;
const CARD_HH = 1.3;
const TILT = 12 * (Math.PI / 180);
const CAM = 4.5;

const CORNERS: V3[] = [
  [-CARD_HW, -CARD_HH, 0],
  [CARD_HW, -CARD_HH, 0],
  [CARD_HW, CARD_HH, 0],
  [-CARD_HW, CARD_HH, 0],
];
const UVS: V2[] = [
  [0, 0],
  [1, 0],
  [1, 1],
  [0, 1],
];

// --- Card textures ---
function frontTexture(u: number, v: number): number {
  const bw = 0.055;
  if (u < bw || u > 1 - bw || v < bw || v > 1 - bw) return 0.9;
  const ib = 0.11,
    ibw = 0.012;
  if (
    (u > ib - ibw && u < ib + ibw && v > ib && v < 1 - ib) ||
    (u > 1 - ib - ibw && u < 1 - ib + ibw && v > ib && v < 1 - ib) ||
    (v > ib - ibw && v < ib + ibw && u > ib && u < 1 - ib) ||
    (v > 1 - ib - ibw && v < 1 - ib + ibw && u > ib && u < 1 - ib)
  )
    return 0.65;
  const diamonds: V2[] = [
    [0.16, 0.1],
    [0.84, 0.1],
    [0.16, 0.9],
    [0.84, 0.9],
  ];
  for (const [dx, dy] of diamonds) {
    const du = Math.abs(u - dx) / 0.035;
    const dv = Math.abs(v - dy) / 0.045;
    if (du + dv < 1) return 1.0;
  }
  const cx = 0.5,
    cy = 0.5;
  const blocks: [number, number, number, number][] = [
    [cx - 0.03, cy - 0.16, cx + 0.03, cy + 0.13],
    [cx - 0.08, cy - 0.13, cx - 0.02, cy - 0.09],
    [cx - 0.055, cy - 0.16, cx - 0.02, cy - 0.13],
    [cx - 0.09, cy + 0.13, cx + 0.09, cy + 0.17],
  ];
  for (const [x1, y1, x2, y2] of blocks) {
    if (u >= x1 && u <= x2 && v >= y1 && v <= y2) return 0.95;
  }
  return 0.3;
}

function backTexture(u: number, v: number): number {
  const bw = 0.055;
  if (u < bw || u > 1 - bw || v < bw || v > 1 - bw) return 0.7;
  const g = 0.065,
    w = 0.018;
  if (u % g < w || v % g < w) return 0.5;
  return 0.28;
}

function project(p: V3): V2 {
  const z = p[2] + CAM;
  const s = CAM / z;
  return [
    SW / 2 + p[0] * s * SW * 0.22 * CHAR_ASPECT,
    SH / 2 + p[1] * s * SH * 0.28,
  ];
}

function triUV(
  px: number,
  py: number,
  ax: number,
  ay: number,
  au: number,
  av: number,
  bx: number,
  by: number,
  bu: number,
  bv: number,
  cx: number,
  cy: number,
  cu: number,
  cv: number,
): V2 | null {
  const v0x = cx - ax,
    v0y = cy - ay,
    v1x = bx - ax,
    v1y = by - ay,
    v2x = px - ax,
    v2y = py - ay;
  const d00 = v0x * v0x + v0y * v0y,
    d01 = v0x * v1x + v0y * v1y,
    d02 = v0x * v2x + v0y * v2y,
    d11 = v1x * v1x + v1y * v1y,
    d12 = v1x * v2x + v1y * v2y;
  const den = d00 * d11 - d01 * d01;
  if (Math.abs(den) < 1e-10) return null;
  const inv = 1 / den;
  const s = (d11 * d02 - d01 * d12) * inv,
    t = (d00 * d12 - d01 * d02) * inv;
  if (s < -0.001 || t < -0.001 || s + t > 1.001) return null;
  const w = 1 - s - t;
  return [w * au + t * bu + s * cu, w * av + t * bv + s * cv];
}

function renderCardFrame(yAngle: number): string[] {
  const xf = CORNERS.map((v) => rotY(rotZ(v, TILT), yAngle));
  const e1: V3 = [
    xf[1][0] - xf[0][0],
    xf[1][1] - xf[0][1],
    xf[1][2] - xf[0][2],
  ];
  const e2: V3 = [
    xf[3][0] - xf[0][0],
    xf[3][1] - xf[0][1],
    xf[3][2] - xf[0][2],
  ];
  const faceN = normV(cross(e1, e2));
  const front = faceN[2] < 0;
  const diffuse = Math.abs(dot3(faceN, LIGHT));
  const pr = xf.map((v) => project(v));

  const bright: number[][] = Array.from({ length: SH }, () =>
    Array(SW).fill(-1),
  );
  const isContent: boolean[][] = Array.from({ length: SH }, () =>
    Array(SW).fill(false),
  );

  for (let sy = 0; sy < SH; sy++) {
    for (let sx = 0; sx < SW; sx++) {
      const px = sx + 0.5,
        py = sy + 0.5;
      const uv =
        triUV(
          px,
          py,
          pr[0][0],
          pr[0][1],
          UVS[0][0],
          UVS[0][1],
          pr[1][0],
          pr[1][1],
          UVS[1][0],
          UVS[1][1],
          pr[2][0],
          pr[2][1],
          UVS[2][0],
          UVS[2][1],
        ) ??
        triUV(
          px,
          py,
          pr[0][0],
          pr[0][1],
          UVS[0][0],
          UVS[0][1],
          pr[2][0],
          pr[2][1],
          UVS[2][0],
          UVS[2][1],
          pr[3][0],
          pr[3][1],
          UVS[3][0],
          UVS[3][1],
        );
      if (!uv) continue;
      let [u, v] = uv;
      if (!front) u = 1 - u;
      const tex = front ? frontTexture(u, v) : backTexture(u, v);
      const lit = tex * (0.2 + 0.8 * diffuse);
      bright[sy][sx] = lit;
      isContent[sy][sx] = front && tex > 0.5;
    }
  }

  return bright.map((row, y) =>
    row
      .map((val, x) => {
        if (val < 0) return " ";
        const idx = Math.min(
          Math.floor(val * (RAMP_ITEM.length - 1)),
          RAMP_ITEM.length - 1,
        );
        const ch = RAMP_ITEM[idx];
        if (ch === " ") return " ";
        return isContent[y][x]
          ? col("#FFD700", ch)
          : front
            ? col("#8B6914", ch)
            : col("#654A0E", ch);
      })
      .join(""),
  );
}

// --- Shared card-frame renderer for icon-based item cards ---
// Every non-signature item is presented as a card using the same
// CORNERS/UVS/TILT/CAM rig as First Edition and Prism above (untouched) —
// each item just supplies an icon glyph and a couple of accent colours
// instead of reimplementing the projection/lighting loop.

/** Icon-space radius so a circle centred on the card face reads as round
 * despite the card being taller than it is wide. */
const ICON_ASPECT = CARD_HH / CARD_HW;

function iconUV(u: number, v: number): V2 {
  return [u - 0.5, (v - 0.5) * ICON_ASPECT];
}

interface TexSample {
  bright: number;
  /** Present for "content" pixels — tints them instead of the card's dim colour. */
  color?: string;
}

/** Border, inner rule, and four corner diamonds shared by every icon card —
 * mirrors First Edition's frame proportions. Returns null over the open
 * interior so the caller's icon can fill it in. */
function cardChrome(u: number, v: number, accent: string): TexSample | null {
  const bw = 0.055;
  if (u < bw || u > 1 - bw || v < bw || v > 1 - bw) return { bright: 0.9 };
  const ib = 0.11,
    ibw = 0.012;
  if (
    (u > ib - ibw && u < ib + ibw && v > ib && v < 1 - ib) ||
    (u > 1 - ib - ibw && u < 1 - ib + ibw && v > ib && v < 1 - ib) ||
    (v > ib - ibw && v < ib + ibw && u > ib && u < 1 - ib) ||
    (v > 1 - ib - ibw && v < 1 - ib + ibw && u > ib && u < 1 - ib)
  )
    return { bright: 0.65 };
  const diamonds: V2[] = [
    [0.16, 0.1],
    [0.84, 0.1],
    [0.16, 0.9],
    [0.84, 0.9],
  ];
  for (const [dx, dy] of diamonds) {
    const du = Math.abs(u - dx) / 0.035;
    const dv = Math.abs(v - dy) / 0.045;
    if (du + dv < 1) return { bright: 1.0, color: accent };
  }
  return null;
}

function renderIconCard(
  yAngle: number,
  accent: string,
  dimColor: string,
  backColor: string,
  icon: (u: number, v: number) => TexSample | null,
): string[] {
  const xf = CORNERS.map((v) => rotY(rotZ(v, TILT), yAngle));
  const e1: V3 = [
    xf[1][0] - xf[0][0],
    xf[1][1] - xf[0][1],
    xf[1][2] - xf[0][2],
  ];
  const e2: V3 = [
    xf[3][0] - xf[0][0],
    xf[3][1] - xf[0][1],
    xf[3][2] - xf[0][2],
  ];
  const faceN = normV(cross(e1, e2));
  const front = faceN[2] < 0;
  const diffuse = Math.abs(dot3(faceN, LIGHT));
  const pr = xf.map((v) => project(v));

  const bright: number[][] = Array.from({ length: SH }, () =>
    Array(SW).fill(-1),
  );
  const pixelColor: (string | undefined)[][] = Array.from({ length: SH }, () =>
    Array(SW).fill(undefined),
  );

  for (let sy = 0; sy < SH; sy++) {
    for (let sx = 0; sx < SW; sx++) {
      const px = sx + 0.5,
        py = sy + 0.5;
      const uv =
        triUV(
          px,
          py,
          pr[0][0],
          pr[0][1],
          UVS[0][0],
          UVS[0][1],
          pr[1][0],
          pr[1][1],
          UVS[1][0],
          UVS[1][1],
          pr[2][0],
          pr[2][1],
          UVS[2][0],
          UVS[2][1],
        ) ??
        triUV(
          px,
          py,
          pr[0][0],
          pr[0][1],
          UVS[0][0],
          UVS[0][1],
          pr[2][0],
          pr[2][1],
          UVS[2][0],
          UVS[2][1],
          pr[3][0],
          pr[3][1],
          UVS[3][0],
          UVS[3][1],
        );
      if (!uv) continue;
      let [u, v] = uv;
      if (!front) u = 1 - u;
      let sample: TexSample;
      if (front) {
        sample = cardChrome(u, v, accent) ?? icon(u, v) ?? { bright: 0.3 };
      } else {
        const bw = 0.055;
        if (u < bw || u > 1 - bw || v < bw || v > 1 - bw) {
          sample = { bright: 0.7 };
        } else {
          const g = 0.065,
            w = 0.018;
          sample = { bright: u % g < w || v % g < w ? 0.5 : 0.28 };
        }
      }
      bright[sy][sx] = sample.bright * (0.2 + 0.8 * diffuse);
      pixelColor[sy][sx] = sample.color;
    }
  }

  return bright.map((row, y) =>
    row
      .map((val, x) => {
        if (val < 0) return " ";
        const idx = Math.min(
          Math.floor(val * (RAMP_ITEM.length - 1)),
          RAMP_ITEM.length - 1,
        );
        const ch = RAMP_ITEM[idx];
        if (ch === " ") return " ";
        const c = pixelColor[y][x];
        return col(c ?? (front ? dimColor : backColor), ch);
      })
      .join(""),
  );
}

// --- CD card ---
function cdCardIcon(u: number, v: number): TexSample | null {
  const [ix, iy] = iconUV(u, v);
  const r = Math.sqrt(ix * ix + iy * iy);
  const R = 0.27;
  if (r > R || r < R * 0.16) return null;
  const band = ((r / R) * 7) % 1;
  const bright = band < 0.5 ? 0.85 : 0.5;
  const color = r < R * 0.4 ? "#E8E8E8" : r < R * 0.7 ? "#C0C0C0" : "#808080";
  return { bright, color };
}

function renderCdFrame(yAngle: number): string[] {
  return renderIconCard(yAngle, "#C0C0C0", "#7a7a7a", "#4a4a4a", cdCardIcon);
}

// --- Power Dice: an actual rendered cube, not a card ---
//
// Every other item — including every "3D-looking" one — is a flat quad
// (CORNERS/UVS above) with a painted icon: a rotating rectangle, never an
// actual solid. Dice needed to read as dice rather than "a card with dots
// on it," so this is a second, independent rig: a real cube with 6 faces,
// each carrying the same single red-on-white pip (see dicePipIcon — this
// isn't a physical 1-6 die), lit per-face so the faces read as distinct
// planes as it spins. It reuses `project`/`triUV` (the same projection and
// barycentric UV lookup the card rig uses) but has its own geometry, since
// a cube's faces need real back-face culling that a single flat quad never
// does — see DICE_FACES below.

/** Cube half-extent. Unlike the card's CARD_HW/CARD_HH — flat corners at
 * z=0, so `project`'s perspective term never inflates their screen extent
 * beyond a fixed bound — a cube's corners move in depth as it rotates, and
 * the nearest corner at a 3-face angle projects noticeably larger than the
 * same corner would flat. This value is calibrated, not guessed: project
 * all 8 corners at every rotation frame, take the worst-case (nearest-
 * corner) screen extent, and pick H so that stays inside the SW×SH canvas
 * with a margin — width is the binding constraint here, not height (at
 * this pitch, the worst-case corner hits ~14.0/15 half-widths vs ~4.6/9
 * half-heights). Re-run that check before changing this number,
 * DICE_PITCH, or SW/SH/CAM — there isn't much room left above this value:
 * 0.64 is where the margin hits zero.
 *
 * This is sized to use roughly as much of the character canvas as the card
 * rig does — NOT shrunk to make the die look smaller than a card. Every
 * item's preview gets content-cropped and rescaled to fill a fixed
 * on-screen box (see `fitMetrics` in item-canvas.ts), so a smaller DICE_H
 * doesn't render a visually smaller die — it renders the same box filled by
 * fewer source characters stretched to cover it, i.e. strictly lower
 * resolution for no size change (this was tried; that's why this comment
 * exists). "Dice are smaller than cards" is instead handled entirely at
 * that display layer, via `previewFillFraction` — this constant should
 * only ever change to fix clipping or genuinely add/remove source detail. */
const DICE_H = 0.6;

/** Tilts the cube back before it spins around Y, the same way TILT gives
 * the flat card a cosmetic diagonal — here it's load-bearing: without it,
 * yAngle=0 looks straight at one face with the other five in silhouette,
 * and it never reads as a cube. This brings the top face into view. */
const DICE_PITCH = -22 * (Math.PI / 180);

const DICE_CORNERS = {
  lbb: [-DICE_H, -DICE_H, -DICE_H] as V3,
  rbb: [DICE_H, -DICE_H, -DICE_H] as V3,
  rtb: [DICE_H, DICE_H, -DICE_H] as V3,
  ltb: [-DICE_H, DICE_H, -DICE_H] as V3,
  lbf: [-DICE_H, -DICE_H, DICE_H] as V3,
  rbf: [DICE_H, -DICE_H, DICE_H] as V3,
  rtf: [DICE_H, DICE_H, DICE_H] as V3,
  ltf: [-DICE_H, DICE_H, DICE_H] as V3,
};

/** The cube's 6 faces, each 4 corners wound CCW as seen from outside (so
 * the cross product of its first two edges gives an outward-facing normal —
 * see the culling check in renderDiceFrame). Every face gets the same
 * single centred pip (see dicePipIcon) — this is Power Dice's own item, not
 * a physical 1-6 die, so there's no "opposite faces sum to 7" convention to
 * preserve; it's the same red dot on white the bespoke 16x16 icon uses,
 * repeated on all six faces so it reads as one consistent object from any
 * angle.
 *
 * The right and left faces below are wound the *other* way round from the
 * other four — swap indices 1 and 3 in either and `cross(e1, e2)` flips
 * from pointing inward back to outward, same as the rest. That inward
 * normal was a real bug, not cosmetic: the culling check in
 * renderPowerDiceFrame keeps a face exactly when its rotated normal faces
 * the camera, so a face whose normal starts out backwards gets culled
 * during the half of the spin where it should be visible (a gap you can
 * see clean through — the "invisible wall") and drawn during the half
 * where it should be hidden (painting the inside of the shell over
 * whichever real face is actually facing the camera there, since faces
 * share one pixel buffer with no depth test — see the comment on that). */
const DICE_FACES: { corners: [V3, V3, V3, V3] }[] = [
  {
    corners: [
      DICE_CORNERS.lbf,
      DICE_CORNERS.rbf,
      DICE_CORNERS.rtf,
      DICE_CORNERS.ltf,
    ],
  },
  {
    corners: [
      DICE_CORNERS.rbb,
      DICE_CORNERS.lbb,
      DICE_CORNERS.ltb,
      DICE_CORNERS.rtb,
    ],
  },
  {
    corners: [
      DICE_CORNERS.rbb,
      DICE_CORNERS.rtb,
      DICE_CORNERS.rtf,
      DICE_CORNERS.rbf,
    ],
  },
  {
    corners: [
      DICE_CORNERS.lbf,
      DICE_CORNERS.ltf,
      DICE_CORNERS.ltb,
      DICE_CORNERS.lbb,
    ],
  },
  {
    corners: [
      DICE_CORNERS.ltf,
      DICE_CORNERS.rtf,
      DICE_CORNERS.rtb,
      DICE_CORNERS.ltb,
    ],
  },
  {
    corners: [
      DICE_CORNERS.lbb,
      DICE_CORNERS.rbb,
      DICE_CORNERS.rbf,
      DICE_CORNERS.lbf,
    ],
  },
];

const DICE_PIP_RADIUS = 0.16;

// White body, red pip — matches the bespoke 16x16 pixel icon (see
// item-icon-grids.json's power-dice-1 palette) so the flat inventory icon
// and the spinning 3D card read as the same object, not two different dice.
const DICE_FACE_COLOR = "#ffffff";
const DICE_PIP_COLOR = "#ff1f1f";

/** Every face's pip: a single coloured divot sunk into the die's face
 * colour, dead centre. `null` (the face colour) elsewhere, same "return
 * null to fall through" convention as cardChrome/icon. */
function dicePipIcon(u: number, v: number): TexSample | null {
  const d = Math.hypot(u - 0.5, v - 0.5);
  if (d >= DICE_PIP_RADIUS) return null;
  return {
    bright: d < DICE_PIP_RADIUS * 0.5 ? 1.0 : 0.88,
    color: DICE_PIP_COLOR,
  };
}

/** How far a point in face-local UV space sits from that face's nearest
 * edge, expressed as a 1.0 (face interior) to 0.55 (right on the edge)
 * darkening factor. Without this, adjoining faces at a similar angle have
 * nothing but their (per-face-constant) diffuse shading telling them apart —
 * often barely any contrast — so the cube read as one flat blob with no
 * visible seam between its faces, a big part of why it looked papery rather
 * than solid. This paints a routed-looking bevel along every face boundary
 * so the eye always has an edge to lock onto, the same job a real die's
 * chamfered corners do. */
function diceEdgeBevel(u: number, v: number): number {
  const width = 0.14;
  const edgeDist = Math.min(u, 1 - u, v, 1 - v);
  return edgeDist >= width ? 1 : 0.55 + 0.45 * (edgeDist / width);
}

function renderPowerDiceFrame(yAngle: number): string[] {
  const bright: number[][] = Array.from({ length: SH }, () =>
    Array(SW).fill(-1),
  );
  const pixelColor: (string | undefined)[][] = Array.from({ length: SH }, () =>
    Array(SW).fill(undefined),
  );

  for (const face of DICE_FACES) {
    const xf = face.corners.map((p) => rotY(rotX(p, DICE_PITCH), yAngle));
    const e1: V3 = [
      xf[1][0] - xf[0][0],
      xf[1][1] - xf[0][1],
      xf[1][2] - xf[0][2],
    ];
    const e2: V3 = [
      xf[3][0] - xf[0][0],
      xf[3][1] - xf[0][1],
      xf[3][2] - xf[0][2],
    ];
    const faceN = normV(cross(e1, e2));
    // A convex solid's front-facing faces never overlap on screen once
    // back-facing ones are culled, so — unlike a scene with several
    // separate objects — no depth buffer is needed: every pixel a visible
    // face claims is one no other visible face will also claim.
    if (faceN[2] >= 0) continue;
    const diffuse = Math.abs(dot3(faceN, LIGHT));
    const pr = xf.map((v) => project(v));

    for (let sy = 0; sy < SH; sy++) {
      for (let sx = 0; sx < SW; sx++) {
        const px = sx + 0.5,
          py = sy + 0.5;
        const uv =
          triUV(
            px,
            py,
            pr[0][0],
            pr[0][1],
            UVS[0][0],
            UVS[0][1],
            pr[1][0],
            pr[1][1],
            UVS[1][0],
            UVS[1][1],
            pr[2][0],
            pr[2][1],
            UVS[2][0],
            UVS[2][1],
          ) ??
          triUV(
            px,
            py,
            pr[0][0],
            pr[0][1],
            UVS[0][0],
            UVS[0][1],
            pr[2][0],
            pr[2][1],
            UVS[2][0],
            UVS[2][1],
            pr[3][0],
            pr[3][1],
            UVS[3][0],
            UVS[3][1],
          );
        if (!uv) continue;
        const [u, v] = uv;
        const sample = dicePipIcon(u, v) ?? {
          // Was 0.6 — capped every face at '+' (RAMP_ITEM index 6) even at
          // the single brightest-lit frame across the whole 36-frame spin
          // (diffuse maxes out around 0.98). A believable plastic face
          // needs to actually reach the ramp's dense end when it's lit
          // near head-on, not just approach the midpoint.
          bright: 0.95,
          color: DICE_FACE_COLOR,
        };
        // Was `0.25 + 0.75 * diffuse`: raising the floor a bit (so a
        // grazing face doesn't fade to near-nothing) while still leaving
        // most of the range to diffuse keeps the per-face contrast that
        // makes the rotation read as light sweeping across real planes,
        // rather than everything sitting at one flat mid-tone.
        bright[sy][sx] =
          sample.bright * (0.32 + 0.68 * diffuse) * diceEdgeBevel(u, v);
        pixelColor[sy][sx] = sample.color;
      }
    }
  }

  return bright.map((row, y) =>
    row
      .map((val, x) => {
        if (val < 0) return " ";
        const idx = Math.min(
          Math.floor(val * (RAMP_ITEM.length - 1)),
          RAMP_ITEM.length - 1,
        );
        const ch = RAMP_ITEM[idx];
        return ch === " " ? " " : col(pixelColor[y][x] ?? DICE_FACE_COLOR, ch);
      })
      .join(""),
  );
}

// --- Spirit Orb card ---
function spiritOrbCardIcon(u: number, v: number): TexSample | null {
  const [ix, iy] = iconUV(u, v);
  const r = Math.sqrt(ix * ix + iy * iy);
  const R = 0.26;
  if (r > R) return null;
  const eyeR = R * 0.16;
  const ex = R * 0.32,
    ey = -R * 0.08;
  if (
    Math.hypot(ix - ex, iy - ey) < eyeR ||
    Math.hypot(ix + ex, iy - ey) < eyeR
  ) {
    return { bright: 0.15, color: "#1a1a2e" };
  }
  const shade = 0.9 - (r / R) * 0.35;
  return { bright: shade, color: "#d8c8ff" };
}

function renderSpiritOrbFrame(yAngle: number): string[] {
  return renderIconCard(
    yAngle,
    "#c9b8ff",
    "#7d6bb0",
    "#4a3d70",
    spiritOrbCardIcon,
  );
}

// --- Headphones card ---
function headbandArcIcon(
  u: number,
  v: number,
  cupColor: string | null,
): TexSample | null {
  const [ix, iy] = iconUV(u, v);
  const dist = Math.sqrt(ix * ix + iy * iy);
  const R = 0.26,
    bandT = 0.045;
  const angle = Math.atan2(iy, ix);
  const start = -2.7,
    end = -0.44; // upper arc, opening downward like a headband over ears
  if (Math.abs(dist - R) < bandT && angle > start && angle < end) {
    return { bright: 0.75, color: "#BBBBBB" };
  }
  if (cupColor) {
    for (const a of [start, end]) {
      const cx = R * Math.cos(a),
        cy = R * Math.sin(a);
      const d = Math.sqrt((ix - cx) ** 2 + (iy - cy) ** 2);
      if (d < 0.1) return { bright: d < 0.05 ? 0.9 : 0.6, color: cupColor };
    }
  }
  return null;
}

function renderHeadphonesFrame(yAngle: number): string[] {
  return renderIconCard(yAngle, "#c084fc", "#7a5aa0", "#4a3163", (u, v) =>
    headbandArcIcon(u, v, "#c084fc"),
  );
}

// --- Rainbow headband card ---
function rainbowHeadbandCardIcon(u: number, v: number): TexSample | null {
  const [ix, iy] = iconUV(u, v);
  const dist = Math.sqrt(ix * ix + iy * iy);
  const R = 0.26,
    bandT = 0.05;
  const angle = Math.atan2(iy, ix);
  const start = -2.7,
    end = -0.44;
  if (Math.abs(dist - R) < bandT && angle > start && angle < end) {
    const t = (angle - start) / (end - start);
    const idx = Math.min(
      RAINBOW_RAMP.length - 1,
      Math.floor(t * RAINBOW_RAMP.length),
    );
    return { bright: 0.85, color: RAINBOW_RAMP[idx] };
  }
  return null;
}

function renderRainbowHeadbandFrame(yAngle: number): string[] {
  return renderIconCard(
    yAngle,
    "#e8e2d0",
    "#8f8672",
    "#5c5648",
    rainbowHeadbandCardIcon,
  );
}

// --- Boombox card ---
function boomboxNoteIcon(u: number, v: number): TexSample | null {
  const [ix, iy] = iconUV(u, v);
  const headCx = -0.02,
    headCy = 0.22;
  const dHead = Math.sqrt((ix - headCx) ** 2 + (iy - headCy) ** 2);
  if (dHead < 0.16) return { bright: 0.85, color: "#f2f2f2" };
  const stemL = headCx + 0.12,
    stemR = headCx + 0.2;
  if (ix > stemL && ix < stemR && iy > -0.34 && iy < headCy)
    return { bright: 0.8, color: "#f2f2f2" };
  if (
    ix > stemR &&
    ix < stemR + 0.16 &&
    iy > -0.34 &&
    iy < -0.16 &&
    ix - stemR > (iy + 0.34) * 0.9
  )
    return { bright: 0.8, color: "#f2f2f2" };
  return null;
}

function renderBoomboxFrame(yAngle: number): string[] {
  return renderIconCard(
    yAngle,
    "#aeb4ba",
    "#75757a",
    "#45454a",
    boomboxNoteIcon,
  );
}

// --- Good Eye Sniper card ---
function goodEyeSniperIcon(u: number, v: number): TexSample | null {
  const [ix, iy] = iconUV(u, v);
  const r = Math.sqrt(ix * ix + iy * iy);
  const R = 0.27;
  if (r > R) return null;
  const ring = Math.floor((r / R) * 5); // 5 concentric bands, innermost = 0
  const isRed = ring % 2 === 0; // center + alternating bands red
  return {
    bright: isRed ? 0.8 : 0.95,
    color: isRed ? "#cc2222" : "#f2f2f2",
  };
}

function renderGoodEyeSniperFrame(yAngle: number): string[] {
  return renderIconCard(
    yAngle,
    "#e05050",
    "#8a3a3a",
    "#4a2020",
    goodEyeSniperIcon,
  );
}

// --- Generate all frames ---
// --- Prism (colour scheme) rendering ---

/** Scale a hex colour toward black — used for the card's reverse face. */
function shadeHex(hex: string, factor: number): string {
  const channel = (start: number) =>
    Math.min(
      255,
      Math.round(parseInt(hex.slice(start, start + 2), 16) * factor),
    )
      .toString(16)
      .padStart(2, "0");
  return `#${channel(1)}${channel(3)}${channel(5)}`.toUpperCase();
}

function prismTexture(u: number, v: number): number {
  const bw = 0.055;
  if (u < bw || u > 1 - bw || v < bw || v > 1 - bw) return 0.9;
  // Gentle sheen across the face so the gradient still reads as a lit card.
  return 0.55 + 0.35 * Math.sin((u + v) * Math.PI);
}

/** Band index for the diagonal colour sweep across the card face. */
function gradientBand(u: number, v: number, ramp: readonly string[]): number {
  const t = (u * 0.65 + v * 0.35) % 1;
  return Math.min(ramp.length - 1, Math.floor(t * ramp.length));
}

/** Diagonal gradient card shared by every equipable colour-scheme item —
 * Prism sweeps the rainbow, Poseidon's Gift sweeps the ocean ramp. */
function renderGradientCardFrame(
  yAngle: number,
  ramp: readonly string[],
): string[] {
  const xf = CORNERS.map((v) => rotY(rotZ(v, TILT), yAngle));
  const e1: V3 = [
    xf[1][0] - xf[0][0],
    xf[1][1] - xf[0][1],
    xf[1][2] - xf[0][2],
  ];
  const e2: V3 = [
    xf[3][0] - xf[0][0],
    xf[3][1] - xf[0][1],
    xf[3][2] - xf[0][2],
  ];
  const faceN = normV(cross(e1, e2));
  const front = faceN[2] < 0;
  const diffuse = Math.abs(dot3(faceN, LIGHT));
  const pr = xf.map((v) => project(v));

  const bright: number[][] = Array.from({ length: SH }, () =>
    Array(SW).fill(-1),
  );
  const bands: number[][] = Array.from({ length: SH }, () => Array(SW).fill(0));

  for (let sy = 0; sy < SH; sy++) {
    for (let sx = 0; sx < SW; sx++) {
      const px = sx + 0.5,
        py = sy + 0.5;
      const uv =
        triUV(
          px,
          py,
          pr[0][0],
          pr[0][1],
          UVS[0][0],
          UVS[0][1],
          pr[1][0],
          pr[1][1],
          UVS[1][0],
          UVS[1][1],
          pr[2][0],
          pr[2][1],
          UVS[2][0],
          UVS[2][1],
        ) ??
        triUV(
          px,
          py,
          pr[0][0],
          pr[0][1],
          UVS[0][0],
          UVS[0][1],
          pr[2][0],
          pr[2][1],
          UVS[2][0],
          UVS[2][1],
          pr[3][0],
          pr[3][1],
          UVS[3][0],
          UVS[3][1],
        );
      if (!uv) continue;
      let [u, v] = uv;
      if (!front) u = 1 - u;
      bright[sy][sx] = prismTexture(u, v) * (0.2 + 0.8 * diffuse);
      bands[sy][sx] = gradientBand(u, v, ramp);
    }
  }

  return bright.map((row, y) =>
    row
      .map((val, x) => {
        if (val < 0) return " ";
        const idx = Math.min(
          Math.floor(val * (RAMP_ITEM.length - 1)),
          RAMP_ITEM.length - 1,
        );
        const ch = RAMP_ITEM[idx];
        if (ch === " ") return " ";
        const hue = ramp[bands[y][x]];
        return col(front ? hue : shadeHex(hue, 0.45), ch);
      })
      .join(""),
  );
}

function renderPrismFrame(yAngle: number): string[] {
  return renderGradientCardFrame(yAngle, RAINBOW_RAMP);
}

function renderPoseidonsGiftFrame(yAngle: number): string[] {
  return renderGradientCardFrame(yAngle, OCEAN_RAMP);
}

function renderPurpleDaneFrame(yAngle: number): string[] {
  return renderGradientCardFrame(yAngle, VIOLET_RAMP);
}

function renderThanksForAllTheFishFrame(yAngle: number): string[] {
  return renderGradientCardFrame(yAngle, TEAL_RAMP);
}

function generateFrames(
  renderFn: (angle: number) => string[],
  count = 36,
): string[][] {
  // The card faces us for the yAngle arc (PI/2, 3*PI/2) — a symmetric 180°
  // window regardless of the cosmetic Z tilt. PI/2 itself is edge-on (zero
  // width, nothing to render), so start one frame step past it: the earliest
  // angle that's actually visible, keeping nearly the whole front-facing arc
  // ahead of frame 0.
  const step = (Math.PI * 2) / count;
  const start = Math.PI / 2 + step;
  return Array.from({ length: count }, (_, i) => renderFn(start + i * step));
}

const firstEditionFrames = generateFrames(renderCardFrame);
const cdFrames = generateFrames(renderCdFrame);
const powerDiceFrames = generateFrames(renderPowerDiceFrame);
const headphonesFrames = generateFrames(renderHeadphonesFrame);
const rainbowHeadbandFrames = generateFrames(renderRainbowHeadbandFrame);
const boomboxFrames = generateFrames(renderBoomboxFrame);
const goodEyeSniperFrames = generateFrames(renderGoodEyeSniperFrame);
const prismFrames = generateFrames(renderPrismFrame);
const poseidonsGiftFrames = generateFrames(renderPoseidonsGiftFrame);
const purpleDaneFrames = generateFrames(renderPurpleDaneFrame);
const thanksForAllTheFishFrames = generateFrames(
  renderThanksForAllTheFishFrame,
);
const spiritOrbFrames = generateFrames(renderSpiritOrbFrame);

// --- Bigger Bag: a drawstring sack, ray-marched rather than built from quads ---
//
// Every other item here is a flat card or a convex solid of flat faces. A sack
// is neither, so it is a signed-distance shape sphere-traced per character
// cell instead: a squat ellipsoid body smoothly joined to a cinched neck that
// flares into a gathered mouth. Cheap at this resolution (SW x SH cells), and
// it needs no depth buffer — the ray stops at the first thing it hits.

/** How much bigger than its modelled size the bag is traced, so it fills more
 * of the SW x SH grid: the preview crops and rescales to a box anyway, so this
 * buys resolution (more cells on the bag) rather than on-screen size. */
const BAG_SCALE = 1.4;
/** The bag leans a little (about its own axis, fixed in view space) so it reads
 * as an object sitting there rather than a diagram of one. Cards get the same
 * treatment via TILT. */
const BAG_TILT = 9 * (Math.PI / 180);
const BAG_BODY_COLOR = "#c49a5a";
const BAG_ROPE_COLOR = "#7a4a24";
const BAG_PATCH_COLOR = "#f2d16b";

function bagSmoothMin(a: number, b: number, k: number): number {
  const h = Math.max(k - Math.abs(a - b), 0) / k;
  return Math.min(a, b) - h * h * k * 0.25;
}

/** Signed distance to the bag in its own space (y grows downward, like the
 * screen, so the mouth is at negative y). Not an exact distance — the neck is
 * scaled down to stay conservative — but the marcher only needs it never to
 * overshoot. */
function bagSdf(x: number, y: number, z: number): number {
  const rx = 0.68;
  const ry = 0.56;
  const rz = 0.6;
  const px = x / rx;
  const py = (y - 0.22) / ry;
  const pz = z / rz;
  const k0 = Math.hypot(px, py, pz);
  const k1 = Math.hypot(px / rx, py / ry, pz / rz);
  const body = k1 > 1e-6 ? (k0 * (k0 - 1)) / k1 : -rx;

  // Neck: a radius that pinches from the flared mouth (y = -0.92) down to the
  // drawstring at y = -0.55, then holds.
  const mouthY = -0.92;
  const cinchY = -0.55;
  const t = Math.min(1, Math.max(0, (y - mouthY) / (cinchY - mouthY)));
  const radius = 0.17 + 0.29 * (1 - t) * (1 - t);
  const neck = Math.max((Math.hypot(x, z) - radius) * 0.8, mouthY - y, y - 0.1);
  return bagSmoothMin(body, neck, 0.24);
}

function bagNormal(x: number, y: number, z: number): V3 {
  const e = 0.01;
  return normV([
    bagSdf(x + e, y, z) - bagSdf(x - e, y, z),
    bagSdf(x, y + e, z) - bagSdf(x, y - e, z),
    bagSdf(x, y, z + e) - bagSdf(x, y, z - e),
  ]);
}

/** What colour the bag is at a point on its surface: rope round the cinch, a
 * gold "H" (for herzies) on the side facing the camera at rest, sacking
 * elsewhere. */
function bagColor(x: number, y: number, z: number): string {
  if (y > -0.64 && y < -0.5) return BAG_ROPE_COLOR;
  const dy = y - 0.22;
  // Two uprights and a crossbar between them.
  const inH =
    (Math.abs(x) > 0.15 && Math.abs(x) < 0.28 && Math.abs(dy) < 0.34) ||
    (Math.abs(x) <= 0.15 && Math.abs(dy) < 0.07);
  if (z < -0.15 && inH) return BAG_PATCH_COLOR;
  return BAG_BODY_COLOR;
}

function renderBiggerBagFrame(yAngle: number): string[] {
  const kx = CAM * SW * 0.22 * CHAR_ASPECT;
  const ky = CAM * SH * 0.28;
  const rows: string[] = [];
  for (let sy = 0; sy < SH; sy++) {
    let row = "";
    for (let sx = 0; sx < SW; sx++) {
      // The camera sits at z = -CAM looking down +z (see project); un-spin
      // the ray into the bag's own space rather than spinning the bag.
      const dir = normV([
        (sx + 0.5 - SW / 2) / kx,
        (sy + 0.5 - SH / 2) / ky,
        1,
      ]);
      // View -> bag: undo the lean, then the spin (the bag spins about its own
      // axis, then leans).
      const o = rotY(rotZ([0, 0, -CAM], -BAG_TILT), -yAngle);
      const d = rotY(rotZ(dir, -BAG_TILT), -yAngle);
      let t = CAM - 2.4;
      let hit = false;
      for (let i = 0; i < 48 && t < CAM + 2.4; i++) {
        const dist =
          bagSdf(
            (o[0] + d[0] * t) / BAG_SCALE,
            (o[1] + d[1] * t) / BAG_SCALE,
            (o[2] + d[2] * t) / BAG_SCALE,
          ) * BAG_SCALE;
        if (dist < 0.004) {
          hit = true;
          break;
        }
        t += dist;
      }
      if (!hit) {
        row += " ";
        continue;
      }
      const x = (o[0] + d[0] * t) / BAG_SCALE;
      const y = (o[1] + d[1] * t) / BAG_SCALE;
      const z = (o[2] + d[2] * t) / BAG_SCALE;
      const n = rotZ(rotY(bagNormal(x, y, z), yAngle), BAG_TILT);
      const diffuse = Math.max(0, dot3(n, LIGHT));
      const bright = 0.3 + 0.7 * diffuse;
      const idx = Math.min(
        Math.floor(bright * (RAMP_ITEM.length - 1)),
        RAMP_ITEM.length - 1,
      );
      const ch = RAMP_ITEM[idx];
      row += ch === " " ? " " : col(bagColor(x, y, z), ch);
    }
    rows.push(row);
  }
  return rows;
}

const biggerBagFrames = generateFrames(renderBiggerBagFrame);

/** The Bigger Bag as a store listing. Deliberately not an `ItemDef`: it is
 * never owned, placed or worn, so it has no rarity or slot — buying it just
 * raises `bankCapacity`. It does have `frames`, so `ItemPreview` can spin it.
 * The Stripe product carries only the price; its `metadata.perk_id` is this id
 * (see /api/store/premium). */
export const BANK_EXPANSION = {
  id: "bank-expansion",
  name: "Bigger Bag",
  description: `Adds ${BANK_EXPANSION_SLOTS} fresh slots to your inventory`,
  frames: biggerBagFrames,
};

// --- Clouds card ---
function cloudCardIcon(u: number, v: number): TexSample | null {
  const [ix, iy] = iconUV(u, v);
  const puffs: [number, number, number][] = [
    [-0.14, 0.02, 0.13],
    [0.05, -0.06, 0.17],
    [0.22, 0.04, 0.12],
  ];
  for (const [cx, cy, r] of puffs) {
    const d = Math.sqrt((ix - cx) ** 2 + (iy - cy) ** 2);
    if (d < r) return { bright: d < r * 0.6 ? 0.85 : 0.6, color: "#c7d3de" };
  }
  if (ix > -0.22 && ix < 0.3 && iy > 0.08 && iy < 0.16)
    return { bright: 0.6, color: "#c7d3de" };
  return null;
}

function renderCloudsFrame(yAngle: number): string[] {
  return renderIconCard(yAngle, "#8899aa", "#5f707d", "#3d4a56", cloudCardIcon);
}

const cloudsFrames = generateFrames(renderCloudsFrame);

// --- Stars card ---
function starCardIcon(u: number, v: number): TexSample | null {
  const [ix, iy] = iconUV(u, v);
  const dist = Math.sqrt(ix * ix + iy * iy);
  const outerR = 0.26,
    innerR = 0.1;
  const angle = Math.atan2(iy, ix) + Math.PI / 2;
  const seg = ((angle % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
  const spike = seg / ((Math.PI * 2) / 5);
  const frac = spike - Math.floor(spike);
  const edgeR = innerR + (outerR - innerR) * (1 - Math.abs(frac - 0.5) * 2);
  if (dist < edgeR * 0.55) return { bright: 0.95, color: "#eaf2fb" };
  if (dist < edgeR) return { bright: 0.7, color: "#ccddee" };
  const sparkles: V2[] = [
    [-0.32, -0.3],
    [0.3, -0.28],
    [-0.28, 0.32],
  ];
  for (const [sx, sy] of sparkles) {
    const d = Math.sqrt((ix - sx) ** 2 + (iy - sy) ** 2);
    if (d < 0.03) return { bright: 0.8, color: "#8899aa" };
  }
  return null;
}

function renderStarsFrame(yAngle: number): string[] {
  return renderIconCard(yAngle, "#ccddee", "#5a6ea0", "#3a4868", starCardIcon);
}

const starsFrames = generateFrames(renderStarsFrame);

export const ITEMS: ItemDef[] = [
  {
    id: "first-edition",
    name: "First Edition Card",
    description: "A token of appreciation for early adopters.",
    rarity: "rare",
    frames: firstEditionFrames,
    // Not stackable: it is statted (+10 luck), so its copies can differ in
    // upgrade level, and a stackable item must never carry per-unit state —
    // that is what lets the bank treat a stack as one interchangeable tile.
    equipable: true,
    equipSlot: "modifier",
    sellPrice: 250,
    stats: { luck: 10 },
  },
  {
    id: "cd",
    name: "Nostalgic Token",
    description:
      "An image of a CD on a dull card. Weird. Probably not worth much.",
    rarity: "common",
    frames: cdFrames,
    stackable: true,
    sellPrice: 10,
  },
  {
    id: "power-dice-1",
    name: "Power Dice 1",
    description:
      "Roll it onto a statted card to bump every one of that card's stats by 1. Up to 3 rolls per card.",
    rarity: "rare",
    frames: powerDiceFrames,
    dice: true,
    stackable: true,
    sellPrice: 200,
    // Not equipable — clicking it opens the upgrade-target picker instead
    // of placing it (see InventoryView's handleGridClick). No buyPrice: a
    // normal world drop, same pool as any other card.
  },
  {
    id: "headphones",
    name: "Intimite Music Device",
    description: "Summons a pair of headphones on your herzie's head.",
    rarity: "uncommon",
    frames: headphonesFrames,
    equipable: true,
    equipSlot: "head",
    sellPrice: 100,
    stats: { sonicPower: 5 },
  },
  {
    id: "rainbow-headband",
    name: "Permanent Rainbow Dreams",
    description: "Rainbows forever on your mind. And head.",
    rarity: "uncommon",
    frames: rainbowHeadbandFrames,
    equipable: true,
    equipSlot: "head",
    sellPrice: 100,
  },
  {
    id: "boombox",
    name: "Box of Boom",
    description: "Grants your herzie real street cred.",
    rarity: "rare",
    frames: boomboxFrames,
    equipable: true,
    equipSlot: "ground",
    sellPrice: 250,
    stats: { sonicPower: 10 },
  },
  {
    id: "good-eye-sniper",
    name: "Good Eye, Sniper",
    description:
      "... and good ears! Displays your song hunt wins and boosts XP the more you rack up.",
    rarity: "rare",
    frames: goodEyeSniperFrames,
    equipable: true,
    equipSlot: "modifier",
    sellPrice: 250,
    modifier: { label: "Exp boost", tooltip: "2% per song hunt won" },
    // no buyPrice — reward-only, matches boombox
  },
  {
    id: "clouds",
    name: "Overcast",
    description: "Paints calming clouds on your herzie's sky.",
    rarity: "rare",
    frames: cloudsFrames,
    equipable: true,
    equipSlot: "scenery",
    sellPrice: 250,
  },
  {
    id: "stars",
    name: "Starfield",
    description: "Sprinkles a twinkling starfield on your herzie's sky.",
    rarity: "rare",
    frames: starsFrames,
    equipable: true,
    equipSlot: "scenery",
    sellPrice: 250,
  },
  {
    id: "prism",
    name: "Prismatic Surrenderer",
    description: "Turns your herzie into a walking rainbow.",
    rarity: "uncommon",
    frames: prismFrames,
    equipable: true,
    equipSlot: "color",
    buyPrice: 3000,
    sellPrice: 100,
  },
  {
    id: "poseidons-gift",
    name: "Poseidon's Gift",
    description:
      "Somehow ended up here. Use it only if you don't care about upsetting the gods.",
    rarity: "uncommon",
    frames: poseidonsGiftFrames,
    equipable: true,
    equipSlot: "color",
    buyPrice: 3000,
    sellPrice: 500,
  },
  {
    id: "purple-dane",
    name: "Purple Dane",
    description: "Denne her gør dig lilla.",
    rarity: "uncommon",
    frames: purpleDaneFrames,
    equipable: true,
    equipSlot: "color",
    buyPrice: 3000,
    sellPrice: 100,
  },
  {
    id: "thanks-for-all-the-fish",
    name: "Thanks for all the fish!",
    description: "Get ready to leave planet earth in style.",
    rarity: "uncommon",
    frames: thanksForAllTheFishFrames,
    equipable: true,
    equipSlot: "color",
    buyPrice: 3000,
    sellPrice: 100,
  },
  {
    id: "spirit-orb",
    name: "Greedy Spirit",
    description: "Tired of picking up items? This little guy can help.",
    rarity: "legendary",
    frames: spiritOrbFrames,
    equipable: true,
    equipSlot: "ground",
    // No coin price: sold for money only, as a Stripe product whose
    // metadata.item_id is "spirit-orb" (see /api/store/premium). It is the
    // one item that cannot be earned by playing — see NON_DROPPABLE_ITEM_IDS
    // — so a coin price would have made it grindable after all.
    sellPrice: 500,
  },
];

export function getItem(id: string): ItemDef | undefined {
  return ITEMS.find((item) => item.id === id);
}

/** The herzie's stats: every equipped item's `stats`, summed, plus +1 per
 * dice-upgrade level (see item_upgrades / applyItemUpgrade) on every stat
 * key that item's catalog `stats` already defines — Power Dice 1's "bump
 * each stat by 1" generalizes correctly if a future item ever carries two
 * stats. Takes a normalized `Equipped` — and on the server that must come
 * from the stored row, never from anything the client sent. */
export function getHerzieStats(
  equipped: Equipped | null | undefined,
  itemUpgrades?: Record<string, number> | null,
): HerzieStats {
  const totals = Object.fromEntries(
    STAT_KEYS.map((key) => [key, 0]),
  ) as HerzieStats;
  for (const id of equippedItemIds(equipped)) {
    const stats = getItem(id)?.stats;
    if (!stats) continue;
    const level = itemUpgrades?.[id] ?? 0;
    for (const key of STAT_KEYS) {
      if (stats[key] === undefined) continue;
      totals[key] += stats[key] + level;
    }
  }
  return totals;
}

/** The same totals, read straight off the units: each worn unit adds its
 * catalog `stats` plus its OWN upgrade level to every stat key it defines —
 * so two copies of one item at different levels contribute what each really
 * is, instead of the id-wide level `getHerzieStats` has to assume. */
export function getHerzieStatsFromUnits(
  units: readonly ItemUnit[] | null | undefined,
): HerzieStats {
  const totals = Object.fromEntries(
    STAT_KEYS.map((key) => [key, 0]),
  ) as HerzieStats;
  for (const unit of units ?? []) {
    if (unit.equippedSlot === null) continue;
    const stats = getItem(unit.itemId)?.stats;
    if (!stats) continue;
    for (const key of STAT_KEYS) {
      if (stats[key] === undefined) continue;
      totals[key] += stats[key] + unit.upgradeLevel;
    }
  }
  return totals;
}

/** Damage a listen deals to a boss per billed minute. Sonic power is a
 * percentage on top of the base rate — 10 sonic power is +10% — the same way
 * every other bonus in the game is a fraction of what it modifies. Both
 * `processSync` and the desktop tooltip call this, so what a player is told
 * is what the server bills. */
export function bossDamagePerMinute(stats: HerzieStats): number {
  return BOSS_DAMAGE_PER_MINUTE * (1 + stats.sonicPower / 100);
}

// getItemColor lived here. It moved to item-canvas.ts — the module its three
// dependencies already come from — so that this file stays free of the
// rendering chain (item-canvas -> creature-renderer, which pulls in canvas
// types). That keeps items.ts isomorphic and lets it be shared verbatim with
// the Deno edge functions via game-rules.ts. It is still re-exported from the
// package root, so importers are unaffected.

/** Filters raw {id, rarity} rows (e.g. fetched from the `items` DB table) down
 * to ones that are both a known catalog item and have a rarity recognized by
 * RARITY_DROP_WEIGHTS. Defends pickWeightedDrop against an id absent from
 * this catalog (mid-migration, a rename that left the old row behind, an
 * admin-created row) or a bad rarity value — either would otherwise let a
 * drop roll onto something the client can never render or collect, which
 * (since a pending drop is never overwritten) would silently and permanently
 * block that user from ever getting another drop. */
export function filterDroppablePool<T extends { id: string; rarity: string }>(
  rows: T[],
): (T & { rarity: Rarity })[] {
  return rows.filter(
    (r): r is T & { rarity: Rarity } =>
      getItem(r.id) !== undefined && r.rarity in RARITY_DROP_WEIGHTS,
  );
}
