import { describe, expect, it } from "vitest";
import { validateName } from "./name.js";

describe("validateName", () => {
  it("rejects empty string", () => {
    expect(validateName("")).not.toBeNull();
  });

  it("accepts 1 character name", () => {
    expect(validateName("A")).toBeNull();
  });

  it("accepts 20 character name", () => {
    expect(validateName("A".repeat(20))).toBeNull();
  });

  it("rejects 21+ character name", () => {
    expect(validateName("A".repeat(21))).not.toBeNull();
  });

  it("accepts letters, numbers, spaces, hyphens, underscores", () => {
    expect(validateName("My Herzie-1_2")).toBeNull();
  });

  it("rejects special characters", () => {
    expect(validateName("test@name")).not.toBeNull();
    expect(validateName("test#name")).not.toBeNull();
    expect(validateName("test!")).not.toBeNull();
  });

  it("rejects emoji", () => {
    expect(validateName("test🥚")).not.toBeNull();
  });
});
