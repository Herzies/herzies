# Set Effects: Prismatic

**Status: shipped.** This doc originally pitched a different render approach (see "Revision note" at the bottom) — it's been rewritten to describe what actually built and merged, so it stays a reliable reference instead of describing a path that was abandoned mid-build.

## Problem

Equipped items today are entirely independent — nothing happens when a herzie happens to own two items that share a theme. The catalog already has an obvious first candidate for a synergy, and it needs no new items to ship: the **Rainbow Headband** (`rainbow-headband`, head slot) and the **Prismatic Surrenderer** (`prism`, color slot) occupy different slots so nothing conflicts wearing both. The combination is proven compatible; it just isn't rewarded.

## Appetite

**Small** — under a day. Visual-only, off the creature canvas entirely, no schema or server changes.

## Solution

**A set is an id-keyed entry, not a new field.** No schema change on `ItemDef`, no DB migration. `ITEM_SETS: ItemSet[]` lives in `shared/src/items.ts` (near `ITEM_TYPE_LABELS`), each entry `{ id, name, effect, itemIds }`. `getItemSet(itemId)` finds an item's set (if any); `isSetFullyEquipped(equipped, set)` checks whether every member is currently worn.

**Detection is pure client-side**, off the same `equippedItemIds(equipped)` helper the desktop wrapper already calls for scenery variants: a set is active when every id in its `itemIds` appears in that flattened list. No server enforcement, no equip-route change — this is cosmetic, not a stat bonus.

**First set: Prismatic** = `rainbow-headband` + `prism`, effect text `"Even more rainbow"`. Both items already existed.

**Render target: a standalone CSS layer in the desktop wrapper, not the ASCII Sky pipeline.** The original pitch called for extending `renderSky()`'s `SceneryVariant` union so the effect stayed inside the terminal-native `<pre>` rendering path. That was tried conceptually and dropped in favor of a `position: fixed` gradient div added directly in `packages/desktop/src/components/Herzie3D.tsx`:

- A 7-stop rainbow `linear-gradient`, `background-size: 220% 220%`, at `opacity: 0.1` with `mix-blend-mode: screen` — low-intensity enough to read as an ambient wash rather than a flat color block.
- Animated via `@utility animate-prismatic` (`globals.css`): a 14s linear loop combining `hue-rotate(0deg → 360deg)` with `background-position` drifting `0% → 100% → 0%`, so the wash both shifts hue and visibly drifts rather than just cycling color in place.
- Positioned `top: 0; left: 0; width: 100vw; height: 45vh`, matching `Sky`'s own full-bleed-to-the-window-edges treatment (not confined to the component's local layout box — an earlier attempt to scope it via `position: absolute` inside a wrapper div made it look boxed-in against the app chrome, so it reverted to `fixed` + `100vw`, same as `Sky`).
- A `mask-image` (with `-webkit-` prefix for the WKWebView) fades it from fully opaque at the top to fully transparent by 85% down, so the bottom dissolves into whatever's actually behind it instead of cutting off in a hard rectangle.
- Gated behind `showSky`, same condition `Sky` itself uses, so it doesn't render in compact/sandbox previews.

**No precedence logic with `stars`/`clouds`.** Because the effect is now an independent layer rather than a `SceneryVariant`, it simply renders alongside whatever scenery is equipped — there's no mutual-exclusion check, and none was added. A herzie can show `stars` and the Prismatic wash at once.

**Item preview surfaces set membership.** `SetTag` (`ItemTypeTag.tsx`) is a small hover badge — set name, tooltip shows the effect text — placed top-right over the preview art in `ItemInspectOverlay.tsx`. Below the description, a set section (only rendered when the item is in a set) shows `"{name} set {owned}/{total}"`, a `"Set effect: {effect}"` line, and a bullet list of every member by name, colored white when owned and dim when not (via a new `inventory` prop threaded into `ItemInspectOverlay` from both `InventoryView` and `StoreView`).

## Rabbit Holes

- **Legibility with multiple rainbow elements on screen at once (headband + body + backdrop)** — not formally spiked in `sandbox.tsx` as originally planned; validated informally by eyeballing the running app across several iterations (opacity, blend mode, and fade were all tuned down from the first pass specifically because it read as too strong).
- **Marketing site** — unaffected: the effect lives entirely in `packages/desktop/src/components/Herzie3D.tsx` (the desktop-only wrapper), not in shared code, so `Herzie3DHero.tsx` structurally cannot reach it regardless of what props it's given.
- **Future sets** — `ITEM_SETS` holds more than one entry already, but only Prismatic ships. A second set with a different visual treatment (not rainbow) would need its own conditional layer, following this one as a template rather than a generic "any full set" mechanism.

## No-gos

- **No stat or gameplay bonus.** Visual only — a set never grants a `modifier` effect.
- **No catalog changes.** Both items already existed; no new item, rarity, or drop path.
- **No DB migration, no equip-route change.** Detection is derived at render time from `equipped`.
- **No change to the creature canvas or its render/cache path.** The effect is a sibling layer, not a modification to `SharedHerzie3D` or the ASCII creature renderer.
- **No set browser or explanatory UI beyond the item preview.** Discovery is "notice it when you wear both" plus the preview badge/section; no dedicated sets screen.
- **No sets beyond Prismatic.**

## Revision note

The original version of this doc specified extending `renderSky()`/`SceneryVariant` and explicitly rejected a CSS gradient layer as a rabbit hole ("precisely what visual-pop's success criteria warn against"), with a mandatory sandbox spike before building anything further. Implementation went a different direction — a CSS layer in the desktop wrapper, built and iterated on directly in the running app rather than spiked first — and the result was kept after review. This revision replaces the original plan with what shipped, so the doc and the code agree.
