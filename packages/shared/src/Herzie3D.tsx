"use client";

import {
  type CSSProperties,
  useCallback,
  useEffect,
  useLayoutEffect,
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
  hasDangleEquipped,
  hasSpiritEquipped,
  isSpiritHopFrame,
  ROTATION_FRAME_MS,
  renderCreatureAtAngle,
  rotationLoopDangle,
  SH,
  SPIRIT_DANCE_HOP_VARIANT_COUNT,
  SW,
} from "./creature-renderer.js";
import {
  combineDangle,
  createDangleSim,
  type DangleConfig,
  type DangleSim,
  type DangleState,
  DEFAULT_DANGLE_CONFIG,
  dangleState,
  isDangleSettled,
  stepDangle,
} from "./dangle-physics.js";
import type { Equipped } from "./items.js";

const FONT_FAMILY = "'SF Mono', 'Menlo', monospace";
const DRAG_SENSITIVITY = Math.PI / 200; // ~180° per 200px
const FRICTION = 0.92;
const MIN_VELOCITY = 0.0005;
/** Chance that a dance loop (1.56s) with a Greedy Spirit plays without a
 * hop — roughly one hop every 4s. */
const SPIRIT_CALM_LOOP_CHANCE = 0.6;
/** How quickly the camera eases toward a new `zoom`: the fraction of the
 * remaining distance covered per 60fps frame. */
const ZOOM_EASE = 0.18;

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
  /** Override the spin physics of dangling items (sandbox / tooling). */
  dangleConfig?: DangleConfig;
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
  /** Stand the herzie on a floor: draw it so its feet (the lowest row of its
   * resting pose) sit this many px above the canvas's bottom edge. Omitted,
   * the creature stays vertically centred in the canvas. */
  groundInset?: number;
  /** Camera zoom about the herzie's centre: below 1 the camera sees more of
   * the scene through the same cells (the herzie draws smaller at the same
   * resolution). Eases to a new value when it changes. Default: 1. */
  zoom?: number;
  /** Camera pan: draws the scene this many px lower (negative: higher),
   * easing along with `zoom`. Default: 0. */
  offsetY?: number;
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
    else if (id === "gold-chain" || id === "pearl-necklace" || id === "bowtie")
      out.body = id;
    else if (id === "witch-hat") out.head = id;
    else if (id === "fangs") out.face = id;
    else if (id === "blood-moon") out.scenery = id;
    else if (id === "pumpkin-spice") out.color = id;
    else if (id === "jack-o-lantern" || id === "ghost") {
      if (!out.ground_left) out.ground_left = id;
      else out.ground_right = id;
    } else if (id === "boombox") {
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
  dangleConfig = DEFAULT_DANGLE_CONFIG,
  draggable = true,
  paused = false,
  wrapperStyle,
  wrapperClassName,
  ariaLabel,
  defaultAngle = 0,
  groundInset,
  zoom = 1,
  offsetY = 0,
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

  // A new `defaultAngle` turns the herzie to it (a host turning it, e.g. the
  // website's herzie facing whoever it stands beside), unless it's being
  // dragged right now. Hosts that never change it are unaffected.
  const lastDefaultAngle = useRef(defaultAngle);
  useEffect(() => {
    if (defaultAngle === lastDefaultAngle.current) return;
    lastDefaultAngle.current = defaultAngle;
    if (!dragging.current) setDragAngle(defaultAngle);
  }, [defaultAngle]);

  const hasDragged = dragAngle !== 0;

  // --- Spin physics for dangling items (the chain, the pearls) ---
  // A damped spring tied to dragAngle (see dangle-physics.ts), stepped on its
  // own rAF loop for as long as anything is still moving. `dangle` is null at
  // rest, which is what lets rendering fall back to the per-angle cache.
  const [dangle, setDangle] = useState<DangleState | null>(null);
  const dangleSim = useRef<DangleSim | null>(null);
  const dangleRaf = useRef(0);
  const dragAngleRef = useRef(dragAngle);
  dragAngleRef.current = dragAngle;
  // The angle the body last rested at, so a new sim starts from where the
  // chain actually was rather than one drag step behind it.
  const restAngle = useRef(dragAngle);
  const dangleConfigRef = useRef(dangleConfig);
  dangleConfigRef.current = dangleConfig;
  const dangles = hasDangleEquipped(equipped);

  // biome-ignore lint/correctness/useExhaustiveDependencies: dragAngle is the trigger — the loop reads it through dragAngleRef
  useEffect(() => {
    if (!dangles) {
      restAngle.current = dragAngleRef.current;
      return;
    }
    if (dangleRaf.current) return;
    dangleSim.current ??= createDangleSim(restAngle.current);
    let last = performance.now();
    const tick = (now: number) => {
      const sim = dangleSim.current;
      if (!sim) return;
      const body = dragAngleRef.current;
      stepDangle(sim, body, (now - last) / 1000, dangleConfigRef.current);
      last = now;
      if (isDangleSettled(sim, body)) {
        dangleSim.current = null;
        dangleRaf.current = 0;
        restAngle.current = body;
        setDangle(null);
        return;
      }
      setDangle(dangleState(sim, body, dangleConfigRef.current));
      dangleRaf.current = requestAnimationFrame(tick);
    };
    dangleRaf.current = requestAnimationFrame(tick);
  }, [dragAngle, dangles]);

  useEffect(
    () => () => {
      cancelAnimationFrame(dangleRaf.current);
      dangleRaf.current = 0;
    },
    [],
  );
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
        zoom,
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
        zoom,
      );
    return generateIdleFrames(
      userId,
      stage,
      equipped,
      creatureParams,
      cols,
      boomboxConfig,
      zoom,
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
    zoom,
  ]);

  // The camera being drawn right now, eased toward the `zoom` and
  // `offsetY` props together. While the zoom is between values, frames are
  // rendered live at it (like a drag); once it lands, the cached frames at
  // the new zoom take over. The offset is only a draw shift. Starts at the
  // props so mounting doesn't animate, and jumps straight there when the
  // herzie was paused (hidden) as they changed — nobody saw it move. A layout
  // effect, so that jump lands before the first paint.
  const [camera, setCamera] = useState({ zoom, offsetY });
  const liveZoom = camera.zoom;
  const zooming = liveZoom !== zoom;
  const cameraRef = useRef(camera);
  cameraRef.current = camera;
  const wasPaused = useRef(paused);
  useLayoutEffect(() => {
    const from = cameraRef.current;
    if (from.zoom === zoom && from.offsetY === offsetY) return;
    if (wasPaused.current) {
      setCamera({ zoom, offsetY });
      return;
    }
    let raf = 0;
    let last = performance.now();
    const tick = (now: number) => {
      const current = cameraRef.current;
      const dz = zoom - current.zoom;
      const dy = offsetY - current.offsetY;
      if (Math.abs(dz) < 0.002 && Math.abs(dy) < 0.5) {
        setCamera({ zoom, offsetY });
        return;
      }
      const t = 1 - (1 - ZOOM_EASE) ** ((now - last) / (1000 / 60));
      last = now;
      setCamera({
        zoom: current.zoom + dz * t,
        offsetY: current.offsetY + dy * t,
      });
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [zoom, offsetY]);
  // After the camera effect, so it sees whether the herzie was paused before
  // this commit, not after.
  useLayoutEffect(() => {
    wasPaused.current = paused;
  }, [paused]);

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

  const interval = dancing ? 65 : animate ? ROTATION_FRAME_MS : 50;

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
      zoom,
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

  // How far down to draw everything so the feet land groundInset px above the
  // canvas bottom. Measured on the idle loop's resting frame, not the current
  // one, so bobbing, dancing and spinning never move the floor — and without
  // the ground slots, whose props (boombox, Jack) sit in front of the herzie
  // and reach a little lower than its feet, so equipping one would otherwise
  // lift the herzie.
  const groundShift = useMemo(() => {
    if (groundInset === undefined) return 0;
    const rest = generateIdleFrames(
      userId,
      stage,
      equipped && {
        ...equipped,
        ground_left: undefined,
        ground_right: undefined,
      },
      creatureParams,
      cols,
      boomboxConfig,
    )[0]?.cells;
    if (!rest) return 0;
    let feetRow = -1;
    rest.forEach((row, y) => {
      if (row.some((c) => c.ch !== " ")) feetRow = y;
    });
    if (feetRow < 0) return 0;
    return Math.round(
      metrics.canvasH - groundInset - (feetRow + 1) * metrics.lineH,
    );
  }, [
    groundInset,
    userId,
    stage,
    equipped,
    creatureParams,
    cols,
    boomboxConfig,
    metrics,
  ]);

  // Whole pixels, so the glyphs stay crisp mid-pan.
  const cameraShift = Math.round(camera.offsetY);

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
        const py = y * metrics.lineH + groundShift + cameraShift;
        for (let x = 0; x < row.length; x++) {
          const cell = row[x];
          if (cell.ch === " ") continue;
          ctx.fillStyle = cell.color;
          ctx.fillText(cell.ch, x * metrics.charW, py);
        }
      }
    },
    [size, metrics, groundShift, cameraShift],
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

  // A new loop starts from its first frame — except when only the zoom moved,
  // which is the same loop seen from further back and must not jump.
  const framesZoom = useRef(zoom);
  // biome-ignore lint/correctness/useExhaustiveDependencies: frames is the trigger; zoom is read to tell a zoom change apart
  useEffect(() => {
    if (framesZoom.current !== zoom) {
      framesZoom.current = zoom;
      return;
    }
    setFrame(0);
  }, [frames]);

  useEffect(() => {
    if (hasDragged || zooming) {
      // Keyed so hop variants share every frame outside their hops with the
      // calm loop — otherwise each re-roll would re-render a whole loop live.
      const hopFrame =
        dancing &&
        hopVariant !== undefined &&
        isSpiritHopFrame(hopVariant, frame);
      const cacheKey = hopFrame ? `${hopVariant}:${frame}` : `${frame}`;
      // A swinging chain is a new pose every frame: render it live and keep it
      // out of the cache, which only holds the at-rest pose.
      let cells = dangle || zooming ? undefined : angleFrames.get(cacheKey);
      if (!cells) {
        const yAngle = animate
          ? (frame / frames.length) * Math.PI * 2 + dragAngle
          : DEFAULT_Y_ANGLE + dragAngle;
        const pose = combineDangle(
          animate && dangles ? rotationLoopDangle(frames.length) : undefined,
          dangle,
        );
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
          pose,
          liveZoom,
        ).cells;
        if (!dangle && !zooming) angleFrames.set(cacheKey, cells);
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
    dangle,
    dangles,
    zooming,
    liveZoom,
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
