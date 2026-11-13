import { describe, expect, it } from "vitest";
import { EMOTE_IDS, getEmote, isEmoteId, ownedEmotes } from "./emotes.js";
import { BANK_EXPANSION, getItem } from "./items.js";

describe("emotes", () => {
  it("never shares an id with an item or the Bigger Bag", () => {
    // The premium listing joins all three on one id.
    for (const id of EMOTE_IDS) {
      expect(getItem(id)).toBeUndefined();
      expect(id).not.toBe(BANK_EXPANSION.id);
    }
  });

  it("knows Wave", () => {
    expect(getEmote("wave")?.name).toBe("Wave");
    expect(isEmoteId("wave")).toBe(true);
    expect(isEmoteId("dance-off")).toBe(false);
  });

  it("lists the owned ones in catalog order, skipping unknown ids", () => {
    expect(ownedEmotes(["nope", "wave"])).toEqual(["wave"]);
    expect(ownedEmotes(null)).toEqual([]);
  });
});

describe("emote cooldowns", () => {
  it("a mic drop waits for its mic to go; the rest wait the usual moment", async () => {
    const { emoteCooldownMs, EMOTE_COOLDOWN_MS } = await import("./emotes.js");
    expect(emoteCooldownMs("micdrop")).toBeGreaterThan(EMOTE_COOLDOWN_MS);
    expect(emoteCooldownMs("wave")).toBe(EMOTE_COOLDOWN_MS);
    expect(emoteCooldownMs("not-an-emote")).toBe(EMOTE_COOLDOWN_MS);
  });
});
