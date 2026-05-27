import { describe, expect, it } from "vitest";
import { getChatInputMenuState } from "./chat-mentions.js";

describe("getChatInputMenuState", () => {
  it("detects # item mention at cursor", () => {
    expect(getChatInputMenuState("hello #sw", 9)).toEqual({
      kind: "item",
      triggerIdx: 6,
      filter: "sw",
    });
  });

  it("detects @ user mention at cursor", () => {
    expect(getChatInputMenuState("hi @al", 6)).toEqual({
      kind: "user",
      triggerIdx: 3,
      filter: "al",
    });
  });

  it("prefers rightmost trigger", () => {
    expect(getChatInputMenuState("hi @bob #ite", 13)).toEqual({
      kind: "item",
      triggerIdx: 8,
      filter: "ite",
    });
  });

  it("returns none when filter contains a space", () => {
    expect(getChatInputMenuState("hi @bo b", 8)).toEqual({ kind: "none" });
  });
});
