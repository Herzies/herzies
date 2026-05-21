import { useEffect, useState } from "react";

// ── Stage 1 parts (head only) ──────────────────────────────────
const S1_HEADS = [
  ["  ╭─────╮  ", "  │     │  ", "  │ EYE │  ", "  │ MTH │  ", "  ╰─────╯  "],
  ["  ╭──∧──╮  ", "  │     │  ", "  │ EYE │  ", "  │ MTH │  ", "  ╰─────╯  "],
  ["  ╭──~──╮  ", "  │     │  ", "  │ EYE │  ", "  │ MTH │  ", "  ╰─────╯  "],
  ["  ╭─────╮  ", "  │     │  ", "  │ EYE │  ", "  │ MTH │  ", "  ╰──○──╯  "],
];
const S1_EYES = ["◕ ◕", "● ●", "◉ ◉", "◕ ●", "★ ★", "◠ ◠"];
const S1_MOUTHS = [" ▽ ", " ◡ ", " ω ", " ▿ ", " ∪ "];
const S1_ACCESSORIES = [
  "     ♪     ",
  "    ✿      ",
  "     ⋆     ",
  "    ◇      ",
  "     ~     ",
  "           ",
];

// ── Stage 2 parts (head + limbs) ──────────────────────────────
const S2_HEADS = [
  ["  ╭─────╮  ", "  │     │  ", "  │ EYE │  ", "  │ MTH │  ", "  ╰─────╯  "],
  ["  ╭──∧──╮  ", "  │     │  ", "  │ EYE │  ", "  │ MTH │  ", "  ╰─────╯  "],
  ["  ╭──~──╮  ", "  │     │  ", "  │ EYE │  ", "  │ MTH │  ", "  ╰─────╯  "],
  ["  ╭─────╮  ", "  │     │  ", "  │ EYE │  ", "  │ MTH │  ", "  ╰──○──╯  "],
];
const S2_EYES = ["◕ ◕", "● ●", "◉ ◉", "◕ ●", "★ ★", "◠ ◠"];
const S2_MOUTHS = [" ▽ ", " ◡ ", " ω ", " ▿ ", " ∪ "];
const S2_ACCESSORIES = [
  "    ♫ ♪    ",
  "   ✿✿✿    ",
  "   ⋆ ★ ⋆   ",
  "   ◇◈◇     ",
  "    ∿∿∿    ",
  "           ",
];
const S2_LIMBS = [
  [" ╱│     │╲ ", "  │     │  ", "  ╱     ╲  ", " ╱       ╲ "],
  ["──┤     ├── ", "  │     │   ", "  ╱     ╲   ", " ╱       ╲  "],
  [" ─┤     ├─  ", "  │     │   ", "  │     │   ", "  ┘     └   "],
  [" ╲│     │╱  ", "  │     │   ", "  ├─   ─┤  ", "  │     │   "],
];

// ── Stage 3 parts (head + body + legs) ────────────────────────
const S3_HEADS = [
  ["  ╭─────╮  ", "  │     │  ", "  │ EYE │  ", "  │ MTH │  ", "  ╰──┬──╯  "],
  ["  ╭──∧──╮  ", "  │     │  ", "  │ EYE │  ", "  │ MTH │  ", "  ╰──┬──╯  "],
  ["  ╭──~──╮  ", "  │     │  ", "  │ EYE │  ", "  │ MTH │  ", "  ╰──┬──╯  "],
  ["  ╭─────╮  ", "  │     │  ", "  │ EYE │  ", "  │ MTH │  ", "  ╰──┬──╯  "],
];
const S3_EYES = ["◕ ◕", "✦ ✦", "◉ ◉", "★ ★", "◈ ◈", "⊛ ⊛"];
const S3_MOUTHS = ["╰◡╯", "◡◡◡", " ω ", "╰▽╯", "╰─╯"];
const S3_ACCESSORIES = [
  "   ♫♪♫♪♫   ",
  "  ✿❀✿❀✿   ",
  "  ⋆ ★ ◆ ★  ",
  "   ◇◈◆◈◇   ",
  "   ∿∿∿∿∿   ",
  "           ",
];
const S3_BODIES = [
  ["  ╭──┴──╮  ", " ─┤ ♥♥♥ ├─ ", "  │ ♥♥♥ │  ", "  ╰──┬──╯  "],
  ["  ╭──┴──╮  ", " ─┤ ⋆⋆⋆ ├─ ", "  │ ♫♫♫ │  ", "  ╰──┬──╯  "],
  ["  ╭──┴──╮  ", " ╱│ ◈◈◈ │╲ ", "  │ ◈◈◈ │  ", "  ╰──┬──╯  "],
  ["  ╭──┴──╮  ", " ─┤ ♪♪♪ ├─ ", "  │ ═══ │  ", "  ╰──┬──╯  "],
];
const S3_LEGS = [
  ["   ╱   ╲   ", "  ╱     ╲  ", "  │     │  "],
  ["   │   │   ", "   │   │   ", "   ┘   └   "],
  ["   ├───┤   ", "   │   │   ", "  ─┘   └─  "],
  ["   ║   ║   ", "   ║   ║   ", "   ╨   ╨   "],
];

const COLORS: Record<string, string> = {
  pink: "#ff79c6",
  blue: "#7ec8e3",
  green: "#4ade80",
  purple: "#c77dff",
  orange: "#FF8C00",
  yellow: "#facc15",
  cyan: "#22d3ee",
  red: "#ff6b6b",
};

const ACCENT_COLORS: Record<string, string> = {
  pink: "#22d3ee",
  blue: "#facc15",
  green: "#ff79c6",
  purple: "#facc15",
  orange: "#22d3ee",
  yellow: "#c77dff",
  cyan: "#ff79c6",
  red: "#facc15",
};

function pick<T>(arr: T[], index: number): T {
  return arr[index % arr.length];
}

function injectFace(lines: string[], eye: string, mouth: string): string[] {
  return lines.map((line) => line.replace("EYE", eye).replace("MTH", mouth));
}

interface Appearance {
  headIndex: number;
  eyesIndex: number;
  mouthIndex: number;
  accessoryIndex: number;
  limbsIndex?: number;
  bodyIndex?: number;
  legsIndex?: number;
  colorScheme: string;
}

function composeHerzie(
  appearance: Appearance,
  stage: number,
): { lines: string[]; accentLineCount: number; limbAccent: boolean } {
  if (stage === 3) {
    const acc = pick(S3_ACCESSORIES, appearance.accessoryIndex);
    const head = pick(S3_HEADS, appearance.headIndex);
    const eye = pick(S3_EYES, appearance.eyesIndex);
    const mouth = pick(S3_MOUTHS, appearance.mouthIndex);
    const body = pick(S3_BODIES, appearance.bodyIndex ?? 0);
    const legs = pick(S3_LEGS, appearance.legsIndex ?? 0);
    const face = injectFace(head, eye, mouth);
    return {
      lines: [acc, ...face, ...body, ...legs],
      accentLineCount: 1 + face.length,
      limbAccent: false,
    };
  }

  if (stage === 2) {
    const acc = pick(S2_ACCESSORIES, appearance.accessoryIndex);
    const head = pick(S2_HEADS, appearance.headIndex);
    const eye = pick(S2_EYES, appearance.eyesIndex);
    const mouth = pick(S2_MOUTHS, appearance.mouthIndex);
    const limbs = pick(S2_LIMBS, appearance.limbsIndex ?? 0);
    const face = injectFace(head, eye, mouth);
    return {
      lines: [acc, ...face, ...limbs],
      accentLineCount: 1,
      limbAccent: true,
    };
  }

  // Stage 1
  const acc = pick(S1_ACCESSORIES, appearance.accessoryIndex);
  const head = pick(S1_HEADS, appearance.headIndex);
  const eye = pick(S1_EYES, appearance.eyesIndex);
  const mouth = pick(S1_MOUTHS, appearance.mouthIndex);
  const face = injectFace(head, eye, mouth);
  return { lines: [acc, ...face], accentLineCount: 1, limbAccent: false };
}

interface HerzieArtProps {
  appearance?: Appearance;
  stage?: number;
  size?: number;
}

export function HerzieArt({
  appearance,
  stage = 1,
  size = 16,
}: HerzieArtProps) {
  const [herzie, setHerzie] = useState<Appearance | null>(appearance ?? null);

  // Pick random appearance on mount (only if no appearance prop)
  useEffect(() => {
    if (appearance) return;
    const colorKeys = Object.keys(COLORS);
    setHerzie({
      headIndex: Math.floor(Math.random() * S1_HEADS.length),
      eyesIndex: Math.floor(Math.random() * S1_EYES.length),
      mouthIndex: Math.floor(Math.random() * S1_MOUTHS.length),
      accessoryIndex: Math.floor(Math.random() * S1_ACCESSORIES.length),
      colorScheme: colorKeys[Math.floor(Math.random() * colorKeys.length)],
    });
  }, [appearance]);

  if (!herzie) return null;

  const { lines, accentLineCount, limbAccent } = composeHerzie(herzie, stage);
  const color = COLORS[herzie.colorScheme] ?? COLORS.pink;
  const accent = ACCENT_COLORS[herzie.colorScheme] ?? ACCENT_COLORS.pink;

  // In the CLI, the accessory line uses accent color, head uses main color,
  // and for stage 2 limbs use accent, for stage 3 body uses accent.
  const coloredLines = lines.map((line, i) => {
    if (i < accentLineCount) {
      // First line (accessory) always accent; for stage 3, body lines are also accent
      return i === 0 ? { text: line, color: accent } : { text: line, color };
    }
    if (limbAccent) {
      // Stage 2: limbs use accent
      return { text: line, color: accent };
    }
    return { text: line, color };
  });

  // For stage 3: accessory = accent, head = main, body = accent, legs = main
  let finalLines = coloredLines;
  if (stage === 3) {
    const headLen = pick(S3_HEADS, herzie.headIndex).length;
    const bodyLen = pick(S3_BODIES, herzie.bodyIndex ?? 0).length;
    finalLines = lines.map((line, i) => {
      if (i === 0) return { text: line, color: accent }; // accessory
      if (i <= headLen) return { text: line, color }; // head
      if (i <= headLen + bodyLen) return { text: line, color: accent }; // body
      return { text: line, color }; // legs
    });
  }

  return (
    <pre
      className="m-0 leading-[1.3] select-none"
      style={{
        fontSize: size,
        filter: `drop-shadow(0 0 12px ${color}40)`,
      }}
      aria-label={`A stage ${stage} herzie`}
    >
      {finalLines.map((l, i) => (
        <span key={i} style={{ color: l.color, display: "block" }}>
          {l.text}
        </span>
      ))}
    </pre>
  );
}
