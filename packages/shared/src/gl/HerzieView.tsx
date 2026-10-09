"use client";

import {
  type CSSProperties,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import * as THREE from "three";
import {
  type CreatureParams,
  DEFAULT_CAMERA_DISTANCE,
  DEFAULT_CAMERA_TILT_DEG,
  DEFAULT_Y_ANGLE,
  equippedCacheKey,
  SH,
  SW,
} from "../creature-renderer.js";
import { type DangleConfig, DEFAULT_DANGLE_CONFIG } from "../dangle-physics.js";
import type { Equipped } from "../items.js";
import { HerzieModel, MODEL_SCALE } from "./HerzieModel.js";
import { herzieStage } from "./stage.js";

const DRAG_SENSITIVITY = Math.PI / 200; // ~180° per 200px
/** Momentum lost per 60fps frame after a flick. */
const FRICTION = 0.92;
const MIN_VELOCITY = 0.0005;
/** How quickly the camera eases toward a new `zoom`/`offsetY`: the fraction
 * of the way covered per 60fps frame. */
const ZOOM_EASE = 0.18;
/** The old renderer's frame, at the herzie's centre, in world units. */
const FRAME_HEIGHT = 4.5;
const CAMERA_DISTANCE = DEFAULT_CAMERA_DISTANCE * MODEL_SCALE;
const TILT = (DEFAULT_CAMERA_TILT_DEG * Math.PI) / 180;

export type HerzieViewProps = {
  /** The render seed: a herzie's friend code, or an NPC's own seed. */
  userId: string;
  stage?: number;
  /** Size of the box, as the old renderer's character cells: the box is
   * `cols` cells of `size * 0.6` px wide and SH rows of `size * 1.35` px
   * tall, with the herzie framed the same way. */
  size?: number;
  cols?: number;
  /** Music is playing: dance. */
  isPlaying?: boolean;
  /** `false` keeps it still (no dance). */
  animate?: boolean;
  equipped?: Equipped;
  /** Hand-set params instead of the seed's (the boss). */
  creatureParams?: CreatureParams;
  /** Spin physics of dangling items (sandbox / tooling). */
  dangleConfig?: DangleConfig;
  /** Drag to turn it, with momentum. Default: true. */
  draggable?: boolean;
  /** Freeze it (the host is hidden or unfocused). */
  paused?: boolean;
  wrapperStyle?: CSSProperties;
  wrapperClassName?: string;
  ariaLabel?: string;
  /** Turn, in radians, from the default three-quarter view. A new value
   * turns it there (unless it's being dragged). */
  defaultAngle?: number;
  /** Stand it on a floor: feet this many px above the box's bottom edge.
   * Omitted, it's centred. */
  groundInset?: number;
  /** Camera zoom about the herzie's centre (below 1: further back). Eases
   * to a new value. Default 1. */
  zoom?: number;
  /** Draws it this many px lower (negative: higher); eases with `zoom`. */
  offsetY?: number;
  /** Greyed out, 0 to 1 (a herzie waiting to hatch). */
  grey?: number;
  /** See-through, 1 (solid) to 0. */
  opacity?: number;
};

/**
 * A herzie on its own little stage: the real-3D model (as in the Town),
 * framed like the old character-cell renderer framed it, so it drops in
 * where that was. Drawn by the page's one shared WebGL canvas (see
 * herzieStage) into this element's box.
 */
export function HerzieView({
  userId,
  stage = 1,
  size = 5,
  cols = SW,
  isPlaying = false,
  animate,
  equipped,
  creatureParams,
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
  grey = 0,
  opacity = 1,
}: HerzieViewProps) {
  const box = useRef<HTMLDivElement>(null);
  const width = Math.ceil(cols * size * 0.6);
  const height = Math.ceil(SH * size * 1.35);

  // A fresh but identical `equipped` (a state push) must not rebuild it.
  const equippedKey = equippedCacheKey(equipped);
  const paramsKey = creatureParams ? JSON.stringify(creatureParams) : "";
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed on content
  const model = useMemo(
    () =>
      new HerzieModel(
        { seed: userId, stage, equipped, params: creatureParams },
        {
          layoutCols: cols,
          layoutRows: SH,
          anchorScenery: -DEFAULT_Y_ANGLE,
        },
      ),
    [userId, stage, equippedKey, paramsKey, cols],
  );
  useEffect(() => () => model.dispose(), [model]);

  // Everything the frame loop reads, kept current without re-registering.
  const live = useRef({
    paused,
    dancing: false,
    zoom,
    offsetY,
    groundInset,
    dangles: false,
    dangleConfig,
    grey,
    opacity,
  });
  live.current = {
    paused,
    dancing: animate !== false && isPlaying,
    zoom,
    offsetY,
    groundInset,
    dangles: draggable,
    dangleConfig,
    grey,
    opacity,
  };

  /** The turn, in the old renderer's units (added to DEFAULT_Y_ANGLE). */
  const spin = useRef({
    angle: defaultAngle,
    velocity: 0,
    dragging: false,
    startX: 0,
    startAngle: 0,
    lastX: 0,
    lastT: 0,
  });
  const lastDefault = useRef(defaultAngle);
  useEffect(() => {
    if (defaultAngle === lastDefault.current) return;
    lastDefault.current = defaultAngle;
    if (!spin.current.dragging) spin.current.angle = defaultAngle;
  }, [defaultAngle]);

  // The camera as drawn, eased toward the props; starts there.
  const camera = useRef({ zoom, offsetY });

  useLayoutEffect(() => {
    const element = box.current;
    if (!element) return;
    const scene = new THREE.Scene();
    scene.add(model.root);
    const cam = new THREE.PerspectiveCamera(50, 1, 0.05, 100);
    // What was last drawn, to tell when a paused herzie needs drawing again.
    const drawn = { angle: Number.NaN, grey: -1, opacity: -1 };

    return herzieStage.add({
      element,
      scene,
      camera: cam,
      idle() {
        const l = live.current;
        const s = spin.current;
        const c = camera.current;
        return (
          l.paused &&
          !s.dragging &&
          s.velocity === 0 &&
          model.dangleSettled &&
          s.angle === drawn.angle &&
          l.grey === drawn.grey &&
          c.zoom === l.zoom &&
          c.offsetY === l.offsetY
        );
      },
      update(dt, w, h, alpha) {
        const l = live.current;
        const s = spin.current;
        // Faded with the page (a wrapper fading in), on top of its own.
        const opacity = l.opacity * alpha;
        if (l.grey !== drawn.grey || opacity !== drawn.opacity) {
          model.setTint(l.grey, opacity);
          drawn.grey = l.grey;
          drawn.opacity = opacity;
        }
        if (!s.dragging && s.velocity !== 0) {
          s.velocity *= FRICTION ** (dt * 60);
          if (Math.abs(s.velocity) < MIN_VELOCITY) s.velocity = 0;
          s.angle += s.velocity * dt * 60;
        }

        // The old renderer turned the creature by +yAngle in its own space
        // (y down, front −z): seen in the world (y up), that's the other
        // way round.
        model.heading = -(DEFAULT_Y_ANGLE + s.angle);
        drawn.angle = s.angle;
        model.dancing = l.dancing;
        // Anything dangling swings as it's spun, then settles — even with
        // the rest held still.
        model.dangles = l.dangles;
        model.dangleConfig = l.dangleConfig;
        if (!l.paused) model.update(dt, 0);
        else {
          model.swing(dt);
          model.update(0, 0);
        }

        const c = camera.current;
        const t = 1 - (1 - ZOOM_EASE) ** (dt * 60);
        c.zoom += (l.zoom - c.zoom) * t;
        c.offsetY += (l.offsetY - c.offsetY) * t;
        if (Math.abs(l.zoom - c.zoom) < 0.002) c.zoom = l.zoom;
        if (Math.abs(l.offsetY - c.offsetY) < 0.5) c.offsetY = l.offsetY;

        // Framed like the old renderer: a perspective camera a fixed
        // distance from the herzie's centre, tilted down a little, its view
        // FRAME_HEIGHT/zoom tall at the centre.
        const frame = FRAME_HEIGHT / c.zoom;
        const perPx = frame / h;
        cam.fov = THREE.MathUtils.radToDeg(
          2 * Math.atan(frame / 2 / CAMERA_DISTANCE),
        );
        cam.aspect = w / h;
        const targetY =
          (l.groundInset !== undefined
            ? (h / 2 - l.groundInset) * perPx
            : model.centerHeight) +
          c.offsetY * perPx;
        cam.position.set(
          0,
          targetY + CAMERA_DISTANCE * Math.sin(TILT),
          CAMERA_DISTANCE * Math.cos(TILT),
        );
        cam.lookAt(0, targetY, 0);
        cam.updateProjectionMatrix();
      },
    });
  }, [model]);

  const [grabbing, setGrabbing] = useState(false);
  const onPointerDown = (e: React.PointerEvent) => {
    if (!draggable || e.button !== 0) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    const s = spin.current;
    s.dragging = true;
    s.velocity = 0;
    s.startX = s.lastX = e.clientX;
    s.startAngle = s.angle;
    s.lastT = performance.now();
    setGrabbing(true);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const s = spin.current;
    if (!s.dragging) return;
    const now = performance.now();
    const frames = Math.max(1, (now - s.lastT) / (1000 / 60));
    s.velocity = (-(e.clientX - s.lastX) * DRAG_SENSITIVITY) / frames;
    s.lastX = e.clientX;
    s.lastT = now;
    s.angle = s.startAngle - (e.clientX - s.startX) * DRAG_SENSITIVITY;
  };
  const onPointerUp = (e: React.PointerEvent) => {
    const s = spin.current;
    if (!s.dragging) return;
    s.dragging = false;
    setGrabbing(false);
    if (e.currentTarget.hasPointerCapture(e.pointerId))
      e.currentTarget.releasePointerCapture(e.pointerId);
    // Only a flick keeps it spinning; a drag that stopped, stops.
    if (performance.now() - s.lastT > 50) s.velocity = 0;
  };

  return (
    <div
      {...(draggable ? { "data-tauri-drag-region": "false" as const } : {})}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      className={wrapperClassName}
      style={{
        display: "flex",
        justifyContent: "center",
        cursor: draggable ? (grabbing ? "grabbing" : "grab") : "default",
        userSelect: "none",
        touchAction: draggable ? "pan-y" : undefined,
        ...wrapperStyle,
      }}
    >
      <div
        ref={box}
        role="img"
        aria-label={ariaLabel ?? `A stage ${stage} herzie`}
        style={{
          position: "relative",
          zIndex: 1,
          width,
          height,
          flexShrink: 0,
        }}
      />
    </div>
  );
}
