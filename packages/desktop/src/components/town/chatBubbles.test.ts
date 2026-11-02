import { formatCurrentSongChatMessage } from "@herzies/shared";
import { describe, expect, it } from "vitest";
import { bubbleDuration, bubbleText } from "./chatBubbles";

describe("bubbleText", () => {
  it("shows item references by name", () => {
    const text = bubbleText({
      content: "look at my #headphones",
      itemRefs: ["headphones"],
    });
    expect(text).not.toContain("#");
    expect(text.startsWith("look at my ")).toBe(true);
  });

  it("cuts long lines short", () => {
    const text = bubbleText({ content: "a".repeat(300), itemRefs: [] });
    expect(text.length).toBe(90);
    expect(text.endsWith("…")).toBe(true);
  });

  it("shows a song share by its song, without the link", () => {
    const content = formatCurrentSongChatMessage(
      "Karma Police",
      "Radiohead",
      500,
    );
    expect(content).toContain("last.fm");
    expect(bubbleText({ content, itemRefs: [] })).toBe(
      "♪ Karma Police — Radiohead",
    );
  });

  it("shows any other Last.fm link as Last.fm", () => {
    expect(
      bubbleText({
        content: "hear this https://www.last.fm/music/Radiohead please",
        itemRefs: [],
      }),
    ).toBe("hear this Last.fm please");
  });

  it("collapses whitespace", () => {
    expect(bubbleText({ content: "  hi \n  there ", itemRefs: [] })).toBe(
      "hi there",
    );
  });
});

describe("bubbleDuration", () => {
  it("grows with the line, up to a limit", () => {
    expect(bubbleDuration("hi")).toBeLessThan(bubbleDuration("a".repeat(50)));
    expect(bubbleDuration("a".repeat(500))).toBe(10_000);
  });
});
