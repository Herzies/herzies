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
  type Cell,
  type CreatureParams,
  DEFAULT_Y_ANGLE,
  generateDanceFrames,
  generateIdleFrames,
  generateRotationFrames,
  renderCreatureAtAngle,
  SH,
  SW,
} from "./creature-renderer.js";

const FONT_FAMILY = "'SF Mono', 'Menlo', monospace";
const DRAG_SENSITIVITY = Math.PI / 200; // ~180° per 200px
const FRICTION = 0.92;
const MIN_VELOCITY = 0.0005;

interface Props {
  userId: string;
  stage?: number;
  /** Font size in px for each character cell. */
  size?: number;
  /** Enable continuous Y-axis rotation. Default: false (idle breathing only). */
  animate?: boolean;
  /** Music is playing — switches to dance animation. No effect when animate is false. */
  isPlaying?: boolean;
  /** Active wearable IDs to render on the creature (e.g. ["headphones"]). */
  wearables?: string[];
  /** Override procedural params derived from userId (sandbox / tooling). */
  creatureParams?: CreatureParams;
  /** Enable click-drag rotation with momentum. Default: true. */
  draggable?: boolean;
  /** Stop the frame timer to save CPU while the host is hidden / unfocused. */
  paused?: boolean;
  /** Wrapper around the canvas. Consumer controls width/positioning. */
  wrapperStyle?: CSSProperties;
  wrapperClassName?: string;
  ariaLabel?: string;
  /** Angle in radians for the herzie. */
  defaultAngle?: number;
}

export function Herzie3D({
  userId,
  stage = 1,
  size = 5,
  animate,
  isPlaying = false,
  wearables,
  creatureParams,
  draggable = true,
  paused = false,
  wrapperStyle,
  wrapperClassName,
  ariaLabel,
  defaultAngle = 0,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [frame, setFrame] = useState(0);
  const [dragAngle, setDragAngle] = useState(defaultAngle);
  const [hasDragged, setHasDragged] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [dancing, setDancing] = useState(false);
  const dragging = useRef(false);
  const dragStartX = useRef(0);
  const dragStartAngle = useRef(0);
  const lastMoveX = useRef(0);
  const lastMoveTime = useRef(0);
  const velocity = useRef(0);
  const momentumRaf = useRef(0);

  const wantsDancing = animate !== false && isPlaying;

  useEffect(() => {
    if (frame === 0 && dancing !== wantsDancing) {
      setDancing(wantsDancing);
    }
  }, [frame, dancing, wantsDancing]);

  const frames = useMemo(() => {
    if (dancing)
      return generateDanceFrames(userId, stage, wearables, creatureParams);
    if (animate)
      return generateRotationFrames(
        userId,
        stage,
        undefined,
        wearables,
        creatureParams,
      );
    return generateIdleFrames(userId, stage, wearables, creatureParams);
  }, [userId, stage, animate, dancing, wearables, creatureParams]);

  const interval = dancing ? 65 : animate ? 80 : 50;

  const metrics = useMemo(() => {
    const charW = size * 0.6;
    const lineH = size * 1.35;
    return {
      charW,
      lineH,
      canvasW: Math.ceil(SW * charW),
      canvasH: Math.ceil(SH * lineH),
    };
  }, [size]);

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
      setHasDragged(true);
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
      const yAngle = animate
        ? (frame / frames.length) * Math.PI * 2 + dragAngle
        : DEFAULT_Y_ANGLE + dragAngle;
      const data = renderCreatureAtAngle(
        userId,
        stage,
        yAngle,
        frame,
        dancing,
        wearables,
        creatureParams,
      );
      drawFrame(data.cells);
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
    userId,
    stage,
    animate,
    dancing,
    wearables,
    creatureParams,
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
