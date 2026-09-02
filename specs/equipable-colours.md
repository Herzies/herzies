# Equipable Colours: Prism

## Problem

Every herzie gets exactly one body colour, drawn from a fixed palette and locked to the user's seed at birth. It is the single most visible thing about your herzie and the one thing you can never change. Meanwhile hats, faces, boomboxes and skies are all equipable and tradeable — so the most personal attribute is the only one that isn't expressible.

Two roadmap items ("customisable herzie", "skins") point at this gap. This pitch takes the smallest real bite: colour becomes a thing you can own, trade and put on, and the first one is **rainbow** — a gradient rather than a flat hue, so the debut colour is visibly not just another swatch from the existing palette.

## Appetite

**Medium** — a day or two of focused work.

The hue maths is trivial. The budget goes to three places: teaching the character renderer that colour can vary across the body instead of being one value for the whole creature, wiring a new colour slot through inventory / equipping / trade the way every other slot already works, and tuning the gradient so it survives rotation and doesn't undo the contrast work from the visual-pop pitch.

*Held.* The renderer gained one optional parameter threaded through its four animation entry points — the fan-out this pitch predicted. An early per-sphere version avoided that fan-out entirely but produced the flat-colour failure described above, so the cost was real, just for a different reason than expected.

## Solution

**A new colour equip slot.** It sits alongside head, face, body, scenery and ground. One colour equipped at a time. Equipping overrides the herzie's seeded body colour; unequipping restores it. The seed is never overwritten — the colour is a layer on top, so taking Prism off always returns the herzie you hatched.

**Prism**, the first colour item. Uncommon, equipable, not stackable. Named to avoid collision with the existing Rainbow Headband, and to leave room for siblings later (Ember, Frost, Void) as a family of colour items rather than a list of hex codes.

**The gradient runs vertically, in model space.** Hue comes from where a ray strikes the creature's surface, measured on the creature's own vertical axis — red at the ears, through yellow and green, to violet at the feet. Because the spin axis *is* the vertical axis, every surface point keeps its hue as the herzie turns: the bands never crawl or shimmer.

*Revised after the spike.* Shaping picked "colours travel around the body on spin," which meant deriving hue from the angle around the vertical axis. That does not work, for a structural reason rather than a tunable one: the head and body are each a single large sphere centred on that axis, so the angle is degenerate there and only limbs and ears pick up a distinct band. It rendered as a green herzie with a pink edge.

The same geometry sets the other constraint. Hue must be resolved **per pixel, from the ray hit point** — not per sphere. Colouring whole spheres gives the head one flat hue and the body another, which reads as an orange herzie in a red hat and blue socks, not a rainbow.

**Gradient applies to body zones only.** Eyes stay cream, pupils stay dark, and worn items keep their own colours. Otherwise a rainbow herzie loses its face and every hat turns to mush.

**Inventory art is a rainbow-swept card**, reusing the same rotating 3D card that CDs already use, with the gradient sweeping across its face. Consistent with every other item in the grid, and no new art pipeline.

**Prism ships as a song-hunt event reward.** That's the only path equipables currently take to players — there is no CD loot table, so building one is out of scope here.

Success looks like: **rainbow reads as rainbow at a glance** in the home view, the face still reads clearly against the gradient, rotation and dance stay shimmer-free, and unequipping returns the herzie you hatched, unchanged.

### Start with a spike — *done*

Before any of the above: hardcode one gradient onto a herzie in the existing parameter sandbox and look at it. Roughly 20 minutes.

The one question no amount of shaping can answer is whether a rainbow reads as *rainbow* through a three-level brightness ramp in monospace, or whether it reads as noise. If it looks bad, the Solution section above changes shape — maybe fewer, wider bands; maybe two-tone rather than full spectrum. Spend the twenty minutes first.

It was worth it: the spike killed the azimuthal approach and confirmed seven hues read cleanly, both before any real code was written.

## Rabbit Holes

- **Legibility through the brightness ramp** — *did not bite.* Seven hues read clearly; the fixed-colour path still yields three shades per hue, so a spinning herzie shows ~16 distinct colours, all of them ramp hues plus their shades.

- **Regressing the visual-pop work** — *did not bite.* The fixed-colour path shades no flatter than the seeded path in practice.

- **Crawl and moiré while rotating** — *closed by construction.* Hue depends only on the vertical axis, which rotation preserves, so it cannot crawl. Rotation does light shade variants that a single frame may not show; that is lighting, not shimmer.

- **Stale frames after equipping** — *real, and fixed.* The frame cache key listed its slots by hand and omitted the new one. It now derives from the slot enum so a future slot cannot silently miss it.

- **Rainbow on rainbow** — *fine.* The headband sweeps horizontally while the body bands vertically, so the perpendicular hue axes keep them legible as separate objects. Loud, as expected.

- **Flat colour on large spheres** — *the one that actually bit,* and it was not on this list. See the Solution note on per-pixel hue.

- **Shared renderer, two apps.** The character renderer is shared with the marketing site, so a change to how colour is resolved lands on both. The site renders herzies that have no equipped data, so it should be unaffected — but the change touches it.

## No-gos

- **No second colour.** Prism only. Ember, Frost and friends are a later pitch once the slot exists and rainbow proves the gradient reads.

- **No colour rarity tiers or drop-rate tuning.** Uncommon, one hunt reward, done. The 3-tier CD idea stays on the wishlist.

- **No customisation screen or colour picker.** You get colours by owning them and equipping them, through the existing inventory. No new UI surface.

- **No animated or cycling hue.** The gradient is static on the body. Colours that shift over time are a different, louder feature.

- **No CD loot table.** Building random drops from opening CDs is its own pitch.

- **No change to the seeded palette.** The ten existing body colours stay exactly as they are, and seeded colour assignment is untouched.

- **No rainbow on the marketing site.** The hero herzies keep their current look.

- **No re-render of items, scenery or sky.** Only creature body colour changes.

## What shipped

- `color` equip slot, permitted in the database and threaded through the shared slot enums.
- `prism` catalog row and client entry — uncommon, one per herzie, with a rainbow-swept inventory card.
- Vertical per-pixel gradient on the creature body; eyes, pupils, and worn items keep their own colours, and the seeded colour is untouched so unequipping restores the original herzie.
- One canonical rainbow ramp shared by the body gradient, the Prism card, and the Rainbow Headband.
- Frame-cache key derived from the slot enum rather than a hand-written list.

Not shipped, and still open: no hunt event grants Prism yet, so nothing can drop it.

---

Scope is bounded by this document. Anything not described here is out of scope unless the pitch is revised.
