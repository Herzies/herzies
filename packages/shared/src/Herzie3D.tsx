"use client";

import {
  type CSSProperties,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  type BoomboxConfig,
  type Cell,
  type CreatureParams,
  DEFAULT_Y_ANGLE,
  equippedCacheKey,
  generateDanceFrames,
  generateIdleFrames,
  generateRotationFrames,
  hasSpiritEquipped,
  isSpiritHopFrame,
  renderCreatureAtAngle,
  SH,
  SPIRIT_DANCE_HOP_VARIANT_COUNT,
  SW,
} from "./creature-renderer.js";
import type { Equipped } from "./items.js";

const FONT_FAMILY = "'SF Mono', 'Menlo', monospace";
const DRAG_SENSITIVITY = Math.PI / 200; // ~180° per 200px
const FRICTION = 0.92;
const MIN_VELOCITY = 0.0005;
/** Chance that a dance loop (1.56s) with a Greedy Spirit plays without a
 * hop — roughly one hop every 4s. */
const SPIRIT_CALM_LOOP_CHANCE = 0.6;

interface Props {
  userId: string;
  stage?: number;
  /** Font size in px for each character cell. */
  size?: number;
  /**
   * Width of the render grid in character columns. Default: SW (80).
   * Widening adds horizontal field of view — the creature is not stretched.
   */
  cols?: number;
  /** Enable continuous Y-axis rotation. Default: false (idle breathing only). */
  animate?: boolean;
  /** Music is playing — switches to dance animation. No effect when animate is false. */
  isPlaying?: boolean;
  /** Slot-keyed equipped items (preferred). */
  equipped?: Equipped;
  /** @deprecated Prefer `equipped`. Converted to a best-effort map if equipped is absent. */
  wearables?: string[];
  /** Override procedural params derived from userId (sandbox / tooling). */
  creatureParams?: CreatureParams;
  /** Override boombox placement/rotation (sandbox / tooling). */
  boomboxConfig?: BoomboxConfig;
  /** Enable click-drag rotation with momentum. Default: true. */
  draggable?: boolean;
  /** Stop the frame timer to save CPU while the host is hidden / unfocused. */
  paused?: boolean;
  /** Wrapper around the canvas. Consumer controls width/positioning. */
  wrapperStyle?: CSSProperties;
  wrapperClassName?: string;
  ariaLabel?: string;
  /** Y-axis rotation offset in radians (added to the default tilt). */
  defaultAngle?: number;
}

function resolveEquipped(
  equipped?: Equipped,
  wearables?: string[],
): Equipped | undefined {
  if (equipped) return equipped;
  if (!wearables?.length) return undefined;
  // Legacy array: put first ground item on left; head items on head.
  const out: Equipped = {};
  for (const id of wearables) {
    if (id === "headphones" || id === "rainbow-headband") out.head = id;
    else if (id === "clouds" || id === "stars") out.scenery = id;
    else if (id === "boombox") {
      if (!out.ground_left) out.ground_left = id;
      else out.ground_right = id;
    }
  }
  return out;
}

export function Herzie3D({
  userId,
  stage = 1,
  size = 5,
  cols = SW,
  animate,
  isPlaying = false,
  equipped: equippedProp,
  wearables,
  creatureParams,
  boomboxConfig,
  draggable = true,
  paused = false,
  wrapperStyle,
  wrapperClassName,
  ariaLabel,
  defaultAngle = 0,
}: Props) {
  const equippedRaw = resolveEquipped(equippedProp, wearables);
  // The parent may hand us a brand-new (but content-identical) `equipped`
  // object on every render — a fresh AppState push, an unrelated background
  // sync tick — since it's typically produced by re-normalizing raw data.
  // Keeping the same reference across those renders (as long as the actual
  // slots/modifiers are unchanged) keeps `frames` below stable, which in
  // turn keeps the frame-reset effect from firing and popping the idle
  // animation back to frame 0 for no visible reason.
  const equippedKeyRef = useRef<string>("");
  const equippedRef = useRef<Equipped | undefined>(equippedRaw);
  const equippedKey = equippedCacheKey(equippedRaw);
  if (equippedKeyRef.current !== equippedKey) {
    equippedKeyRef.current = equippedKey;
    equippedRef.current = equippedRaw;
  }
  const equipped = equippedRef.current;
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [frame, setFrame] = useState(0);
  const [dragAngle, setDragAngle] = useState(defaultAngle);
  const [isDragging, setIsDragging] = useState(false);
  const [dancing, setDancing] = useState(false);
  /** Greedy Spirit dance hop variant for the current loop; undefined = none. */
  const [hopVariant, setHopVariant] = useState<number | undefined>(undefined);
  const prevFrame = useRef(0);
  const dragging = useRef(false);
  const dragStartX = useRef(0);
  const dragStartAngle = useRef(0);
  const lastMoveX = useRef(0);
  const lastMoveTime = useRef(0);
  const velocity = useRef(0);
  const momentumRaf = useRef(0);

  const hasDragged = dragAngle !== 0;
  const wantsDancing = animate !== false && isPlaying;

  useEffect(() => {
    if (frame === 0 && dancing !== wantsDancing) {
      setDancing(wantsDancing);
    }
  }, [frame, dancing, wantsDancing]);

  const frames = useMemo(() => {
    if (dancing)
      return generateDanceFrames(
        userId,
        stage,
        equipped,
        creatureParams,
        cols,
        boomboxConfig,
        hopVariant,
      );
    if (animate)
      return generateRotationFrames(
        userId,
        stage,
        undefined,
        equipped,
        creatureParams,
        cols,
        boomboxConfig,
      );
    return generateIdleFrames(
      userId,
      stage,
      equipped,
      creatureParams,
      cols,
      boomboxConfig,
    );
  }, [
    userId,
    stage,
    animate,
    dancing,
    equipped,
    creatureParams,
    cols,
    boomboxConfig,
    hopVariant,
  ]);

  // Re-roll the Greedy Spirit's dance hop at each loop wrap: none or one of the
  // variants, never the same variant twice running. Every variant is the plain
  // loop outside its hops, so swapping at the wrap is seamless, and the random
  // choice is what spaces hops irregularly instead of on the loop's fixed
  // beat. Keyed on `wantsDancing`, the mode the next loop will play in (the
  // dance/idle switch also happens at the wrap).
  const canHop = !animate && wantsDancing && hasSpiritEquipped(equipped);
  useEffect(() => {
    const wrapped = frame === 0 && prevFrame.current !== 0;
    prevFrame.current = frame;
    if (!canHop) {
      setHopVariant(undefined);
      return;
    }
    if (!wrapped) return;
    setHopVariant((prev) => {
      if (Math.random() < SPIRIT_CALM_LOOP_CHANCE) return undefined;
      let next = Math.floor(Math.random() * SPIRIT_DANCE_HOP_VARIANT_COUNT);
      if (next === prev) next = (next + 1) % SPIRIT_DANCE_HOP_VARIANT_COUNT;
      return next;
    });
  }, [frame, canHop]);

  const interval = dancing ? 65 : animate ? 80 : 50;

  // Frames rendered at an arbitrary drag angle can't come from the module-level
  // frameCache — its keys carry no angle, and a live drag would add an entry per
  // mousemove to a cache that is never evicted. Cache per settled angle instead.
  //
  // This matters more than it looks: `hasDragged` latches on for the lifetime of
  // the component (dragAngle is only ever reset by a remount, and momentum
  // decays velocity, not angle), so without this every frame tick rebuilds the
  // whole creature — spheres, anchors, palette, projection — 20x a second,
  // forever, after a single drag.
  //
  // The Map identity is the invalidation: useMemo hands back a fresh one
  // whenever any render input changes, so a drag in progress misses on every
  // mousemove (correct — the angle really is new each time), while a settled
  // angle pays for one animation cycle and is free from then on. That is why
  // the deps below are wider than the factory body reads, and why `frame` is
  // deliberately absent from them.
  // biome-ignore lint/correctness/useExhaustiveDependencies: see above
  const angleFrames = useMemo(
    () => new Map<string, Cell[][]>(),
    [
      dragAngle,
      userId,
      stage,
      animate,
      dancing,
      equipped,
      creatureParams,
      cols,
      boomboxConfig,
    ],
  );

  const metrics = useMemo(() => {
    const charW = size * 0.6;
    const lineH = size * 1.35;
    return {
      charW,
      lineH,
      canvasW: Math.ceil(cols * charW),
      canvasH: Math.ceil(SH * lineH),
    };
  }, [size, cols]);

  const drawFrame = useCallback(
    (cells: Cell[][]) => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;

      ctx.clearRect(0, 0, metrics.canvasW, metrics.canvasH);
      ctx.font = `${size}px ${FONT_FAMILY}`;
      ctx.textBaseline = "top";

      for (let y = 0; y < cells.length; y++) {
        const row = cells[y];
        const py = y * metrics.lineH;
        for (let x = 0; x < row.length; x++) {
          const cell = row[x];
          if (cell.ch === " ") continue;
          ctx.fillStyle = cell.color;
          ctx.fillText(cell.ch, x * metrics.charW, py);
        }
      }
    },
    [size, metrics],
  );

  const startMomentum = useCallback(() => {
    cancelAnimationFrame(momentumRaf.current);

    const tick = () => {
      velocity.current *= FRICTION;
      if (Math.abs(velocity.current) < MIN_VELOCITY) {
        velocity.current = 0;
        return;
      }
      setDragAngle((prev) => prev + velocity.current);
      momentumRaf.current = requestAnimationFrame(tick);
    };

    momentumRaf.current = requestAnimationFrame(tick);
  }, []);

  useEffect(() => () => cancelAnimationFrame(momentumRaf.current), []);

  const onMouseDown = useCallback(
    (e: React.MouseEvent) => {
      if (!draggable) return;
      e.preventDefault();
      cancelAnimationFrame(momentumRaf.current);
      velocity.current = 0;
      dragging.current = true;
      setIsDragging(true);
      dragStartX.current = e.clientX;
      dragStartAngle.current = dragAngle;
      lastMoveX.current = e.clientX;
      lastMoveTime.current = performance.now();
    },
    [dragAngle, draggable],
  );

  const onMouseMove = useCallback(
    (e: React.MouseEvent) => {
      if (!draggable) return;
      if (!dragging.current) return;
      const now = performance.now();
      const dt = now - lastMoveTime.current;
      if (dt > 0) {
        velocity.current = -(e.clientX - lastMoveX.current) * DRAG_SENSITIVITY;
      }
      lastMoveX.current = e.clientX;
      lastMoveTime.current = now;

      const deltaX = e.clientX - dragStartX.current;
      setDragAngle(dragStartAngle.current - deltaX * DRAG_SENSITIVITY);
    },
    [draggable],
  );

  const stopDrag = useCallback(() => {
    if (!draggable) return;
    if (!dragging.current) return;
    dragging.current = false;
    setIsDragging(false);

    if (performance.now() - lastMoveTime.current < 50) {
      startMomentum();
    }
  }, [draggable, startMomentum]);

  useEffect(() => {
    if (paused) return;
    if (frames.length <= 1) return;
    const id = setInterval(
      () => setFrame((f) => (f + 1) % frames.length),
      interval,
    );
    return () => clearInterval(id);
  }, [frames.length, interval, paused]);

  useEffect(() => {
    setFrame(0);
  }, [frames]);

  useEffect(() => {
    if (hasDragged) {
      // Keyed so hop variants share every frame outside their hops with the
      // calm loop — otherwise each re-roll would re-render a whole loop live.
      const hopFrame =
        dancing &&
        hopVariant !== undefined &&
        isSpiritHopFrame(hopVariant, frame);
      const cacheKey = hopFrame ? `${hopVariant}:${frame}` : `${frame}`;
      let cells = angleFrames.get(cacheKey);
      if (!cells) {
        const yAngle = animate
          ? (frame / frames.length) * Math.PI * 2 + dragAngle
          : DEFAULT_Y_ANGLE + dragAngle;
        cells = renderCreatureAtAngle(
          userId,
          stage,
          yAngle,
          frame,
          dancing,
          equipped,
          creatureParams,
          cols,
          boomboxConfig,
          hopFrame ? hopVariant : undefined,
        ).cells;
        angleFrames.set(cacheKey, cells);
      }
      drawFrame(cells);
    } else {
      const current = frames[frame] ?? frames[0];
      if (current) drawFrame(current.cells);
    }
  }, [
    frame,
    frames,
    drawFrame,
    dragAngle,
    hasDragged,
    angleFrames,
    userId,
    stage,
    animate,
    dancing,
    equipped,
    creatureParams,
    cols,
    boomboxConfig,
    hopVariant,
  ]);

  return (
    <div
      {...(draggable ? { "data-tauri-drag-region": "false" as const } : {})}
      onMouseDown={onMouseDown}
      onMouseMove={onMouseMove}
      onMouseUp={stopDrag}
      onMouseLeave={stopDrag}
      className={wrapperClassName}
      style={{
        display: "flex",
        justifyContent: "center",
        cursor: draggable ? (isDragging ? "grabbing" : "grab") : "default",
        userSelect: "none",
        ...(draggable ? { WebkitAppRegion: "no-drag" } : {}),
        ...wrapperStyle,
      }}
    >
      <canvas
        ref={canvasRef}
        width={metrics.canvasW}
        height={metrics.canvasH}
        style={{
          position: "relative",
          zIndex: 1,
          width: metrics.canvasW,
          height: metrics.canvasH,
          imageRendering: "pixelated",
        }}
        aria-label={ariaLabel ?? `A stage ${stage} herzie`}
      />
    </div>
  );
}
