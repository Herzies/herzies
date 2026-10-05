import { readFileSync } from "node:fs";
import rawCardArt from "@herzies/shared/card-art/card-art.json";
import { describe, expect, it } from "vitest";

// The webp imports in card-art.ts can't load under Vitest, so this reads the
// file's import specifiers instead of importing it.
const source = readFileSync(new URL("./card-art.ts", import.meta.url), "utf8");
const imported = new Set(
  [...source.matchAll(/from "@herzies\/shared\/card-art\/([^"]+\.\w+)"/g)]
    .map((m) => m[1])
    .filter((file) => file !== "card-art.json"),
);

describe("card art", () => {
  it("imports every illustration the manifest names", () => {
    const files = Object.values(
      rawCardArt as Record<string, { file?: string }>,
    ).flatMap((entry) => (entry.file ? [entry.file] : []));
    for (const file of files) expect(imported).toContain(file);
  });
});
