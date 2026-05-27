import type { ColorScheme, HerzieAppearance, Stage } from "@herzies/shared";
import chalk, { type ChalkInstance } from "chalk";

// Stage 1 parts (head only)
import { accessories as s1Acc } from "./parts/stage1/accessories.js";
import { eyes as s1Eyes } from "./parts/stage1/eyes.js";
import { heads as s1Heads } from "./parts/stage1/heads.js";
import { mouths as s1Mouths } from "./parts/stage1/mouths.js";

// Stage 2 parts (head + limbs)
import { accessories as s2Acc } from "./parts/stage2/accessories.js";
import { eyes as s2Eyes } from "./parts/stage2/eyes.js";
import { heads as s2Heads } from "./parts/stage2/heads.js";
import { limbs as s2Limbs } from "./parts/stage2/limbs.js";
import { mouths as s2Mouths } from "./parts/stage2/mouths.js";

// Stage 3 parts (head + body + legs)
import { accessories as s3Acc } from "./parts/stage3/accessories.js";
import { bodies as s3Bodies } from "./parts/stage3/bodies.js";
import { eyes as s3Eyes } from "./parts/stage3/eyes.js";
import { heads as s3Heads } from "./parts/stage3/heads.js";
import { legs as s3Legs } from "./parts/stage3/legs.js";
import { mouths as s3Mouths } from "./parts/stage3/mouths.js";

const COLOR_MAP: Record<ColorScheme, ChalkInstance> = {
  pink: chalk.magenta,
  blue: chalk.cyan,
  green: chalk.green,
  purple: chalk.magentaBright,
  orange: chalk.hex("#FF8C00"),
  yellow: chalk.yellow,
  cyan: chalk.cyanBright,
  red: chalk.red,
};

const ACCENT_MAP: Record<ColorScheme, ChalkInstance> = {
  pink: chalk.cyanBright,
  blue: chalk.yellow,
  green: chalk.magenta,
  purple: chalk.yellow,
  orange: chalk.cyanBright,
  yellow: chalk.magentaBright,
  cyan: chalk.magenta,
  red: chalk.yellow,
};

/** Replace EYE and MTH placeholders in head template lines */
function injectFace(
  lines: string[],
  eyeStr: string,
  mouthStr: string,
): string[] {
  return lines.map((line) =>
    line.replace("EYE", eyeStr).replace("MTH", mouthStr),
  );
}

/** Pick from array by index with wrapping */
function pick<T>(arr: T[], index: number): T {
  return arr[index % arr.length];
}

/** Compose a full Herzie ASCII art from its appearance and stage */
export function composeHerzie(
  appearance: HerzieAppearance,
  stage: Stage,
): string {
  const colorFn = COLOR_MAP[appearance.colorScheme];
  const accentFn = ACCENT_MAP[appearance.colorScheme];

  const colored = (lines: string[], fn: ChalkInstance = colorFn) =>
    lines.map((l) => fn(l));

  if (stage === 1) {
    const accessory = pick(s1Acc, appearance.accessoryIndex);
    const head = pick(s1Heads, appearance.headIndex);
    const eyeStr = pick(s1Eyes, appearance.eyesIndex);
    const mouthStr = pick(s1Mouths, appearance.mouthIndex);

    return [
      accentFn(accessory),
      ...colored(injectFace(head, eyeStr, mouthStr)),
    ].join("\n");
  }

  if (stage === 2) {
    const accessory = pick(s2Acc, appearance.accessoryIndex);
    const head = pick(s2Heads, appearance.headIndex);
    const eyeStr = pick(s2Eyes, appearance.eyesIndex);
    const mouthStr = pick(s2Mouths, appearance.mouthIndex);
    const limbSet = pick(s2Limbs, appearance.limbsIndex);

    return [
      accentFn(accessory),
      ...colored(injectFace(head, eyeStr, mouthStr)),
      ...colored(limbSet, accentFn),
    ].join("\n");
  }

  // Stage 3
  const accessory = pick(s3Acc, appearance.accessoryIndex);
  const head = pick(s3Heads, appearance.headIndex);
  const eyeStr = pick(s3Eyes, appearance.eyesIndex);
  const mouthStr = pick(s3Mouths, appearance.mouthIndex);
  const body = pick(s3Bodies, appearance.bodyIndex);
  const legSet = pick(s3Legs, appearance.legsIndex);

  return [
    accentFn(accessory),
    ...colored(injectFace(head, eyeStr, mouthStr)),
    ...colored(body, accentFn),
    ...colored(legSet),
  ].join("\n");
}
