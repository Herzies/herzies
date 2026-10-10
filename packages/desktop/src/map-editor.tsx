// Dev only (not in the build's inputs): paint the Town's home island.
// `pnpm map-editor`. The left is the map, cell by cell; the right is the
// real 3D Town drawn from it, live, to walk around in. Saving writes
// src/components/town/maps/home.json (via the dev server — see
// vite.config.ts), which is what the app builds the island from.
import "./globals.css";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import type { EventCard } from "./components/TownScene";
import { benchFacing } from "./components/town/Benches";
import { localHours } from "./components/town/DayCycle";
import {
  cellCenter,
  EIGHTH,
  facingAt,
  ISLAND_RADIUS,
  inland,
  isSunk,
  MAP_SIZE,
  OBJECTS,
  OFF,
  objectAt,
  objectJitter,
  onIsland,
  type Point,
  parseMap,
  pruneFacing,
  SPOT_NAMES,
  TERRAIN,
  type TownMap,
  WORLD_RADIUS,
  withFacing,
} from "./components/town/map";
import { HOME_MAP, spotsOf, type TownSpot } from "./components/town/runtime";
import TownCanvas, { PIXEL_SCALE } from "./components/town/TownCanvas";

const HALF = MAP_SIZE / 2;

type Layer = "terrain" | "objects";
type Paint = { layer: Layer; ch: string; name: string; color: string };
const PALETTE: Paint[] = [
  ...(["g", ".", "~", "="] as const).map((ch) => ({
    layer: "terrain" as const,
    ch,
    ...TERRAIN[ch],
  })),
  ...(
    ["T", "R", "S", "v", "*", "m", "H", "$", "C", "@", "B", "L", "_"] as const
  ).map((ch) => ({
    layer: "objects" as const,
    ch,
    ...OBJECTS[ch],
  })),
  { layer: "objects", ch: ".", name: "Clear", color: "#000000" },
];
/** Each palette entry's key, in order (clear last): the number row, then
 * K (shop, "kiosk"), C (cave), U (bush), L (lamp post) and N (bench).
 * Clear of the 3D preview's keys (WASD, arrows, E) and the tools' (B, R,
 * F, P). */
const KEYS = [..."1234567890-", "k", "c", "=", "u", "l", "n", "x"];
type Tool = "brush" | "rect" | "fill";
const TOOLS: { tool: Tool; key: string; name: string }[] = [
  { tool: "brush", key: "b", name: "Brush" },
  { tool: "rect", key: "r", name: "Rectangle" },
  { tool: "fill", key: "f", name: "Fill" },
];
const BRUSH_SIZES = [1, 3, 5, 9];

/** A marker you can drag: a visitor's spot, a spare spot, or the spawn. */
type MarkerId =
  | { kind: "spot"; key: string }
  | { kind: "spare"; i: number }
  | { kind: "spawn" };

/** The grids as rows of chars, to paint into. */
type Draft = { terrain: string[][]; objects: string[][] };
const toDraft = (m: TownMap): Draft => ({
  terrain: m.terrain.map((r) => [...r]),
  objects: m.objects.map((r) => [...r]),
});
const fromDraft = (m: TownMap, d: Draft): TownMap =>
  pruneFacing({
    ...m,
    terrain: d.terrain.map((r) => r.join("")),
    objects: d.objects.map((r) => r.join("")),
  });

/** Which way an object faces now, in eighths of a turn: as turned, else
 * its own way (a bench toward the path, a statue toward town, anything
 * else as it fell), to the nearest eighth. */
function eighthsAt(map: TownMap, col: number, row: number): number {
  const o = objectAt(map, col, row);
  const [x, z] = cellCenter(col, row);
  const yaw =
    facingAt(map, col, row) ??
    (o === "_"
      ? benchFacing(map, col, row)
      : o === "@"
        ? Math.atan2(-x, -z)
        : objectJitter(col, row).yaw);
  return Math.round(yaw / EIGHTH);
}

/** Paint one cell, keeping the map valid: water only inland, nothing
 * standing in water. */
function paintCell(d: Draft, col: number, row: number, p: Paint): void {
  if (!onIsland(col, row)) return;
  if (p.layer === "terrain") {
    if (isSunk(p.ch) && !inland(col, row)) return;
    d.terrain[row][col] = p.ch;
    if (isSunk(p.ch)) d.objects[row][col] = ".";
  } else {
    if (p.ch !== "." && isSunk(d.terrain[row][col])) return;
    d.objects[row][col] = p.ch;
  }
}

function eraser(layer: Layer): Paint {
  return layer === "terrain"
    ? { layer, ch: ".", name: "Grass", color: TERRAIN["."].color }
    : { layer, ch: ".", name: "Clear", color: "" };
}

/** Flood-fill the region of same-char cells around (col, row) on the
 * paint's layer. */
function fill(d: Draft, col: number, row: number, p: Paint): void {
  const grid = d[p.layer];
  const from = grid[row]?.[col];
  if (from === undefined || from === OFF || from === p.ch) return;
  const stack: [number, number][] = [[col, row]];
  const seen = new Set<number>();
  while (stack.length > 0) {
    const [c, r] = stack.pop() as [number, number];
    const k = r * MAP_SIZE + c;
    if (seen.has(k) || grid[r]?.[c] !== from) continue;
    seen.add(k);
    paintCell(d, c, r, p);
    stack.push([c + 1, r], [c - 1, r], [c, r + 1], [c, r - 1]);
  }
}

const snap = (v: number) => Math.round(v * 2) / 2;
function clampToWorld([x, z]: Point): Point {
  const r = Math.hypot(x, z);
  if (r <= WORLD_RADIUS) return [snap(x), snap(z)];
  const s = (WORLD_RADIUS - 0.5) / r;
  return [snap(x * s), snap(z * s)];
}

function withMarker(m: TownMap, id: MarkerId, at: Point): TownMap {
  if (id.kind === "spot") return { ...m, spots: { ...m.spots, [id.key]: at } };
  if (id.kind === "spare") {
    return { ...m, spare: m.spare.map((p, i) => (i === id.i ? at : p)) };
  }
  return { ...m, spawn: { ...m.spawn, at } };
}
function markers(m: TownMap): { id: MarkerId; label: string; at: Point }[] {
  return [
    ...Object.entries(m.spots).map(([key, at]) => ({
      id: { kind: "spot" as const, key },
      label: SPOT_NAMES[key] ?? key,
      at,
    })),
    ...m.spare.map((at, i) => ({
      id: { kind: "spare" as const, i },
      label: `spare ${i + 1}`,
      at,
    })),
    { id: { kind: "spawn" as const }, label: "you", at: m.spawn.at },
  ];
}

/** The map, every visitor kind given a spot (new ones start mid-plaza). */
function withAllSpots(m: TownMap): TownMap {
  const spots = { ...m.spots };
  for (const key of Object.keys(SPOT_NAMES)) spots[key] ??= [0, 0];
  return { ...m, spots };
}

function drawMap(
  ctx: CanvasRenderingContext2D,
  map: TownMap,
  zoom: number,
  rect: { a: [number, number]; b: [number, number]; p: Paint } | null,
  hover: [number, number] | null,
  brush: number,
  tool: Tool,
) {
  const size = MAP_SIZE * zoom;
  ctx.clearRect(0, 0, size, size);
  ctx.fillStyle = "#0b0f1c";
  ctx.fillRect(0, 0, size, size);
  for (let r = 0; r < MAP_SIZE; r++) {
    for (let c = 0; c < MAP_SIZE; c++) {
      const t = map.terrain[r][c];
      if (t === OFF) continue;
      ctx.fillStyle = TERRAIN[t as keyof typeof TERRAIN]?.color ?? "#f0f";
      ctx.fillRect(c * zoom, r * zoom, zoom, zoom);
      if (t === "=") {
        // Plank lines, so a bridge reads as one.
        ctx.fillStyle = "#00000040";
        ctx.fillRect(c * zoom, r * zoom + zoom / 2, zoom, 1);
      }
      const o = map.objects[r][c];
      if (o !== "." && o !== OFF) {
        ctx.fillStyle = OBJECTS[o as keyof typeof OBJECTS]?.color ?? "#f0f";
        const cx = (c + 0.5) * zoom;
        const cy = (r + 0.5) * zoom;
        ctx.beginPath();
        if (o === "T") ctx.arc(cx, cy, zoom * 0.42, 0, Math.PI * 2);
        else if (o === "R")
          ctx.rect(
            cx - zoom * 0.33,
            cy - zoom * 0.28,
            zoom * 0.66,
            zoom * 0.56,
          );
        else if (o === "H" || o === "$" || o === "C") {
          // Whole cells, so a patch reads as one building.
          ctx.rect(c * zoom, r * zoom, zoom, zoom);
        } else if (o === "v") {
          // Tufts: a few upright strokes.
          for (const dx of [-0.25, 0, 0.25]) {
            ctx.rect(
              cx + dx * zoom,
              cy - zoom * 0.3,
              Math.max(1, zoom * 0.1),
              zoom * 0.55,
            );
          }
        } else if (o === "*") {
          for (const [dx, dy] of [
            [-0.22, -0.18],
            [0.2, -0.1],
            [-0.05, 0.22],
          ]) {
            ctx.moveTo(cx + dx * zoom, cy + dy * zoom);
            ctx.arc(
              cx + dx * zoom,
              cy + dy * zoom,
              zoom * 0.13,
              0,
              Math.PI * 2,
            );
          }
        } else if (o === "B") {
          // A round clump, with a lighter top.
          ctx.arc(cx, cy, zoom * 0.4, 0, Math.PI * 2);
          ctx.fill();
          ctx.beginPath();
          ctx.fillStyle = "#5c9a48";
          ctx.arc(
            cx - zoom * 0.08,
            cy - zoom * 0.1,
            zoom * 0.2,
            0,
            Math.PI * 2,
          );
        } else if (o === "@") {
          ctx.rect(cx - zoom * 0.4, cy - zoom * 0.4, zoom * 0.8, zoom * 0.8);
          ctx.fill();
          ctx.beginPath();
          ctx.fillStyle = "#5b5850";
          ctx.arc(cx, cy, zoom * 0.22, 0, Math.PI * 2);
        } else ctx.arc(cx, cy, zoom * 0.26, 0, Math.PI * 2);
        ctx.fill();
        if (o === "H" || o === "$" || o === "C") {
          // A darker edge where the building meets open ground.
          ctx.fillStyle = { H: "#8a3b2e", $: "#2c559f", C: "#4e463c" }[o];
          const edge = Math.max(1, zoom * 0.15);
          if (map.objects[r - 1]?.[c] !== o)
            ctx.fillRect(c * zoom, r * zoom, zoom, edge);
          if (map.objects[r + 1]?.[c] !== o)
            ctx.fillRect(c * zoom, (r + 1) * zoom - edge, zoom, edge);
          if (map.objects[r][c - 1] !== o)
            ctx.fillRect(c * zoom, r * zoom, edge, zoom);
          if (map.objects[r][c + 1] !== o)
            ctx.fillRect((c + 1) * zoom - edge, r * zoom, edge, zoom);
        }
      }
    }
  }
  // Light gridlines once cells are big enough to see them.
  if (zoom >= 10) {
    ctx.strokeStyle = "#ffffff12";
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let i = 0; i <= MAP_SIZE; i++) {
      ctx.moveTo(i * zoom + 0.5, 0);
      ctx.lineTo(i * zoom + 0.5, size);
      ctx.moveTo(0, i * zoom + 0.5);
      ctx.lineTo(size, i * zoom + 0.5);
    }
    ctx.stroke();
  }
  // The island's edge, and how far you can walk.
  const mid = HALF * zoom;
  ctx.strokeStyle = "#ffffff50";
  ctx.beginPath();
  ctx.arc(mid, mid, ISLAND_RADIUS * zoom, 0, Math.PI * 2);
  ctx.stroke();
  ctx.setLineDash([4, 4]);
  ctx.strokeStyle = "#ffffff30";
  ctx.beginPath();
  ctx.arc(mid, mid, WORLD_RADIUS * zoom, 0, Math.PI * 2);
  ctx.stroke();
  ctx.setLineDash([]);

  // What a click would paint.
  ctx.strokeStyle = "#ffffffc0";
  if (rect) {
    const [c0, c1] = [
      Math.min(rect.a[0], rect.b[0]),
      Math.max(rect.a[0], rect.b[0]),
    ];
    const [r0, r1] = [
      Math.min(rect.a[1], rect.b[1]),
      Math.max(rect.a[1], rect.b[1]),
    ];
    ctx.strokeRect(
      c0 * zoom + 0.5,
      r0 * zoom + 0.5,
      (c1 - c0 + 1) * zoom - 1,
      (r1 - r0 + 1) * zoom - 1,
    );
  } else if (hover) {
    const span = tool === "brush" ? brush : 1;
    const lo = Math.floor(span / 2);
    ctx.strokeRect(
      (hover[0] - lo) * zoom + 0.5,
      (hover[1] - lo) * zoom + 0.5,
      span * zoom - 1,
      span * zoom - 1,
    );
  }

  // Which way turned objects face: a tick from the middle of the cell.
  ctx.strokeStyle = "#ffffffd0";
  ctx.lineWidth = Math.max(1, zoom / 6);
  for (const k of Object.keys(map.facing ?? {})) {
    const [c, r] = k.split(",").map(Number);
    const yaw = facingAt(map, c, r) ?? 0;
    const cx = (c + 0.5) * zoom;
    const cy = (r + 0.5) * zoom;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(
      cx + Math.sin(yaw) * zoom * 0.6,
      cy + Math.cos(yaw) * zoom * 0.6,
    );
    ctx.stroke();
  }
  ctx.lineWidth = 1;

  // Markers.
  ctx.font = `bold ${Math.max(10, zoom * 1.2)}px ui-monospace, monospace`;
  ctx.textAlign = "center";
  for (const m of markers(map)) {
    const x = (m.at[0] + HALF) * zoom;
    const y = (m.at[1] + HALF) * zoom;
    const spawn = m.id.kind === "spawn";
    ctx.fillStyle = spawn
      ? "#ffd84a"
      : m.id.kind === "spare"
        ? "#9aa3c0"
        : "#ff7ad9";
    ctx.strokeStyle = "#000";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(x, y, zoom * 0.8, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    if (spawn) {
      // Facing: forward is (sin, cos) in (x, z), and z is down here.
      const h = map.spawn.heading;
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x + Math.sin(h) * zoom * 2, y + Math.cos(h) * zoom * 2);
      ctx.stroke();
    }
    ctx.lineWidth = 3;
    ctx.strokeText(m.label, x, y - zoom * 1.2);
    ctx.fillStyle = "#fff";
    ctx.fillText(m.label, x, y - zoom * 1.2);
  }
  ctx.lineWidth = 1;
}

const card = (type: string, title: string): EventCard => ({
  type,
  title,
  description: null,
  status: "live",
  at: null,
  openKey: null,
  eventId: `map-editor-${type}`,
});

const PLAYER = {
  seed: "map-editor",
  stage: 3,
  equipped: { color: "prism", head: "headphones" },
};

/** How the preview's time of day runs: the real clock, held where you set
 * it, or running this many times faster than real. */
type TimeMode = "clock" | "set" | number;
const TIME_MODES: { mode: TimeMode; label: string; title: string }[] = [
  { mode: "clock", label: "now", title: "Follow the real clock" },
  { mode: "set", label: "❚❚", title: "Hold the time (drag the slider)" },
  { mode: 60, label: "60×", title: "An hour a minute" },
  { mode: 600, label: "600×", title: "An hour every 6 seconds" },
  { mode: 3600, label: "3600×", title: "An hour a second" },
];

const clockText = (h: number) =>
  `${Math.floor(h)}:${String(Math.floor((h % 1) * 60)).padStart(2, "0")}`;

function MapEditor() {
  const [map, setMap] = useState<TownMap>(() => withAllSpots(HOME_MAP));
  const [undo, setUndo] = useState<TownMap[]>([]);
  const [redo, setRedo] = useState<TownMap[]>([]);
  const [saved, setSaved] = useState<TownMap>(map);
  const [status, setStatus] = useState("");
  const [paint, setPaint] = useState<Paint>(PALETTE[0]);
  const [tool, setTool] = useState<Tool>("brush");
  const [brush, setBrush] = useState(3);
  const [zoom, setZoom] = useState(8);
  const [hover, setHover] = useState<[number, number] | null>(null);
  const [rect, setRect] = useState<{
    a: [number, number];
    b: [number, number];
    p: Paint;
  } | null>(null);
  const [respawn, setRespawn] = useState(0);
  // The preview's resolution, as screen pixels per drawn pixel: whole
  // ones, so every pixel comes out the same size.
  const [pixelSize, setPixelSize] = useState(() =>
    Math.round(window.devicePixelRatio / PIXEL_SCALE),
  );
  const pixelScale = window.devicePixelRatio / pixelSize;
  // The preview's time of day: the real clock, a time you set, or time
  // running fast so you can watch the day go by. `?time=21.5` starts at a
  // set time. The hour lives in a ref the preview reads every frame, so
  // fast-forwarding doesn't re-render anything; the label catches up a few
  // times a second.
  const [timeMode, setTimeMode] = useState<TimeMode>(() =>
    new URLSearchParams(location.search).has("time") ? "set" : "clock",
  );
  const hourRef = useRef(
    Number(new URLSearchParams(location.search).get("time") ?? localHours()),
  );
  const [shownHour, setShownHour] = useState(hourRef.current);
  const readHour = useCallback(() => hourRef.current, []);
  const setHour = (h: number) => {
    hourRef.current = ((h % 24) + 24) % 24;
    setShownHour(hourRef.current);
  };
  useEffect(() => {
    if (typeof timeMode !== "number") return;
    let last = performance.now();
    let frame = requestAnimationFrame(function tick(now) {
      hourRef.current =
        (hourRef.current + (((now - last) / 1000) * timeMode) / 3600) % 24;
      last = now;
      frame = requestAnimationFrame(tick);
    });
    const label = setInterval(() => setShownHour(hourRef.current), 200);
    return () => {
      cancelAnimationFrame(frame);
      clearInterval(label);
    };
  }, [timeMode]);
  const canvas = useRef<HTMLCanvasElement>(null);
  /** The stroke under way: its draft and what it paints, or a marker
   * being dragged. */
  const stroke = useRef<
    { draft: Draft; p: Paint } | { marker: MarkerId } | null
  >(null);
  const mapRef = useRef(map);
  // The cell under the pointer, for the keyboard (Q turns what's there).
  const hoverRef = useRef(hover);
  hoverRef.current = hover;
  mapRef.current = map;

  const dirty = map !== saved;

  /** Record the map before a change, for undo. */
  const checkpoint = useCallback(() => {
    setUndo((u) => [...u.slice(-199), mapRef.current]);
    setRedo([]);
  }, []);

  useEffect(() => {
    const ctx = canvas.current?.getContext("2d");
    if (ctx) drawMap(ctx, map, zoom, rect, hover, brush, tool);
  }, [map, zoom, rect, hover, brush, tool]);

  // The 3D preview follows the map a beat behind, so painting a stroke
  // doesn't rebuild the world on every cell.
  const [preview, setPreview] = useState(map);
  useEffect(() => {
    const t = setTimeout(() => setPreview(map), 250);
    return () => clearTimeout(t);
  }, [map]);
  const spots = useMemo<TownSpot[]>(() => {
    const { spots: at } = spotsOf(preview);
    return Object.entries(at).map(([type, p]) => ({
      // Keyed on where, so a moved visitor is placed afresh.
      key: `${type}@${p.x},${p.z}`,
      card: card(type, SPOT_NAMES[type] ?? type),
      at: p,
      standing: true,
      status: "in town",
    }));
  }, [preview]);

  const cellOf = (e: React.PointerEvent): [number, number] => {
    const box = (e.target as HTMLCanvasElement).getBoundingClientRect();
    return [
      Math.floor((e.clientX - box.left) / zoom),
      Math.floor((e.clientY - box.top) / zoom),
    ];
  };
  const worldOf = (e: React.PointerEvent): Point => {
    const box = (e.target as HTMLCanvasElement).getBoundingClientRect();
    return [
      (e.clientX - box.left) / zoom - HALF,
      (e.clientY - box.top) / zoom - HALF,
    ];
  };

  const brushAt = (d: Draft, [c, r]: [number, number], p: Paint) => {
    const lo = Math.floor(brush / 2);
    for (let dr = 0; dr < brush; dr++) {
      for (let dc = 0; dc < brush; dc++)
        paintCell(d, c - lo + dc, r - lo + dr, p);
    }
  };

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    const [wx, wz] = worldOf(e);
    // A marker under the pointer is dragged rather than painted over.
    const hit = markers(map).find(
      (m) => Math.hypot(m.at[0] - wx, m.at[1] - wz) < Math.max(0.9, 8 / zoom),
    );
    if (hit && e.button === 0) {
      checkpoint();
      stroke.current = { marker: hit.id };
      return;
    }
    const p = e.button === 2 ? eraser(paint.layer) : paint;
    const cell = cellOf(e);
    if (tool === "rect") {
      setRect({ a: cell, b: cell, p });
      return;
    }
    checkpoint();
    const draft = toDraft(map);
    if (tool === "fill") {
      fill(draft, cell[0], cell[1], p);
      setMap(fromDraft(map, draft));
      return;
    }
    brushAt(draft, cell, p);
    stroke.current = { draft, p };
    setMap(fromDraft(map, draft));
  };

  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const cell = cellOf(e);
    setHover(cell);
    const s = stroke.current;
    if (rect) {
      setRect({ ...rect, b: cell });
    } else if (s && "marker" in s) {
      setMap((m) => withMarker(m, s.marker, clampToWorld(worldOf(e))));
    } else if (s) {
      brushAt(s.draft, cell, s.p);
      setMap((m) => fromDraft(m, s.draft));
    }
  };

  const onPointerUp = () => {
    if (rect) {
      checkpoint();
      const draft = toDraft(map);
      const [c0, c1] = [
        Math.min(rect.a[0], rect.b[0]),
        Math.max(rect.a[0], rect.b[0]),
      ];
      const [r0, r1] = [
        Math.min(rect.a[1], rect.b[1]),
        Math.max(rect.a[1], rect.b[1]),
      ];
      for (let r = r0; r <= r1; r++)
        for (let c = c0; c <= c1; c++) paintCell(draft, c, r, rect.p);
      setMap(fromDraft(map, draft));
      setRect(null);
    }
    stroke.current = null;
  };

  const turnSpawn = (by: number) => {
    checkpoint();
    setMap((m) => ({
      ...m,
      spawn: {
        ...m.spawn,
        heading:
          Math.round(
            ((m.spawn.heading + by + Math.PI * 4) % (Math.PI * 2)) * 1e4,
          ) / 1e4,
      },
    }));
  };

  const save = useCallback(async () => {
    const m = mapRef.current;
    try {
      parseMap(m);
      const res = await fetch("/__town-map", {
        method: "PUT",
        body: JSON.stringify(m),
      });
      if (!res.ok) throw new Error(await res.text());
      setSaved(m);
      setStatus(`Saved ${new Date().toLocaleTimeString()}`);
    } catch (e) {
      setStatus(`Not saved: ${e instanceof Error ? e.message : e}`);
    }
  }, []);

  const doUndo = useCallback(() => {
    setUndo((u) => {
      if (u.length === 0) return u;
      setRedo((r) => [...r, mapRef.current]);
      setMap(u[u.length - 1]);
      return u.slice(0, -1);
    });
  }, []);
  const doRedo = useCallback(() => {
    setRedo((r) => {
      if (r.length === 0) return r;
      setUndo((u) => [...u, mapRef.current]);
      setMap(r[r.length - 1]);
      return r.slice(0, -1);
    });
  }, []);

  // Shortcuts. The 3D preview listens to the whole window too, so these
  // stay off its keys (WASD, arrows, E).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key === "s") {
        e.preventDefault();
        save();
      } else if (mod && e.key.toLowerCase() === "z") {
        e.preventDefault();
        if (e.shiftKey) doRedo();
        else doUndo();
      } else if (mod) {
        return;
      } else if (KEYS.includes(e.key) && e.key !== "") {
        setPaint(PALETTE[KEYS.indexOf(e.key)]);
      } else if (e.key === "[" || e.key === "]") {
        setBrush((b) => {
          const i = BRUSH_SIZES.indexOf(b) + (e.key === "]" ? 1 : -1);
          return BRUSH_SIZES[Math.max(0, Math.min(BRUSH_SIZES.length - 1, i))];
        });
      } else if (e.key === "p") {
        setRespawn((n) => n + 1);
      } else if (e.key.toLowerCase() === "q") {
        // Turn what's under the pointer an eighth: clockwise, or back with
        // shift.
        const at = hoverRef.current;
        const m = mapRef.current;
        if (
          !at ||
          objectAt(m, at[0], at[1]) === "." ||
          objectAt(m, at[0], at[1]) === OFF
        )
          return;
        checkpoint();
        const step = e.shiftKey ? 1 : -1;
        setMap(withFacing(m, at[0], at[1], eighthsAt(m, at[0], at[1]) + step));
      } else {
        const t = TOOLS.find((t) => t.key === e.key);
        if (t) setTool(t.tool);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [save, doUndo, doRedo, checkpoint]);

  // Don't lose unsaved work to a stray reload.
  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  const btn = (on: boolean): React.CSSProperties => ({
    padding: "4px 8px",
    border: `1px solid ${on ? "#8b93c9" : "#2a2f45"}`,
    background: on ? "#262c48" : "#141827",
    color: "#e6e6e6",
    borderRadius: 4,
    font: "inherit",
    cursor: "pointer",
  });

  return (
    <div
      style={{
        display: "flex",
        height: "100vh",
        background: "#0b0d14",
        color: "#e6e6e6",
        fontFamily: "ui-monospace, monospace",
        fontSize: 12,
      }}
    >
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          minWidth: 0,
          // Fits the map at its default zoom; the toolbars wrap within it,
          // and a zoomed-in map scrolls.
          flex: "0 0 auto",
          width: "min(720px, 55vw)",
        }}
      >
        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            gap: 6,
            padding: 8,
            borderBottom: "1px solid #2a2d3a",
            alignItems: "center",
          }}
        >
          {PALETTE.map((p, i) => (
            <button
              key={`${p.layer}${p.ch}`}
              type="button"
              style={btn(p === paint)}
              onClick={() => setPaint(p)}
              title={`${p.name} (${KEYS[i]})`}
            >
              <span
                style={{
                  display: "inline-block",
                  width: 10,
                  height: 10,
                  marginRight: 5,
                  background: p.color,
                  border: "1px solid #0006",
                  verticalAlign: -1,
                }}
              />
              {p.name}
              <span style={{ color: "#6b7090", marginLeft: 4 }}>
                {KEYS[i].toUpperCase()}
              </span>
            </button>
          ))}
        </div>
        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            gap: 6,
            padding: 8,
            borderBottom: "1px solid #2a2d3a",
            alignItems: "center",
          }}
        >
          {TOOLS.map((t) => (
            <button
              key={t.tool}
              type="button"
              style={btn(t.tool === tool)}
              onClick={() => setTool(t.tool)}
            >
              {t.name}{" "}
              <span style={{ color: "#6b7090" }}>{t.key.toUpperCase()}</span>
            </button>
          ))}
          <span style={{ marginLeft: 6, color: "#8b8fa3" }}>
            Q turn (shift: back)
          </span>
          <span style={{ marginLeft: 6, color: "#8b8fa3" }}>size [ ]</span>
          {BRUSH_SIZES.map((b) => (
            <button
              key={b}
              type="button"
              style={btn(b === brush)}
              onClick={() => setBrush(b)}
            >
              {b}
            </button>
          ))}
          <span style={{ marginLeft: 6, color: "#8b8fa3" }}>zoom</span>
          <button
            type="button"
            style={btn(false)}
            onClick={() => setZoom((z) => Math.max(4, z - 2))}
          >
            −
          </button>
          <button
            type="button"
            style={btn(false)}
            onClick={() => setZoom((z) => Math.min(24, z + 2))}
          >
            +
          </button>
        </div>
        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            gap: 6,
            padding: 8,
            borderBottom: "1px solid #2a2d3a",
            alignItems: "center",
          }}
        >
          <span style={{ color: "#8b8fa3" }}>spawn facing</span>
          <button
            type="button"
            style={btn(false)}
            onClick={() => turnSpawn(-Math.PI / 4)}
          >
            ⟲
          </button>
          <button
            type="button"
            style={btn(false)}
            onClick={() => turnSpawn(Math.PI / 4)}
          >
            ⟳
          </button>
          <button
            type="button"
            style={btn(false)}
            onClick={() => setRespawn((n) => n + 1)}
            title="Put the preview's player at the spawn (P)"
          >
            Respawn <span style={{ color: "#6b7090" }}>P</span>
          </button>
          <button
            type="button"
            style={btn(false)}
            disabled={undo.length === 0}
            onClick={doUndo}
          >
            Undo
          </button>
          <button
            type="button"
            style={btn(false)}
            disabled={redo.length === 0}
            onClick={doRedo}
          >
            Redo
          </button>
          <button
            type="button"
            style={{ ...btn(dirty), marginLeft: "auto" }}
            onClick={save}
          >
            Save{dirty ? " •" : ""} <span style={{ color: "#6b7090" }}>⌘S</span>
          </button>
        </div>
        <div style={{ overflow: "auto", flex: 1, padding: 8 }}>
          <canvas
            ref={canvas}
            width={MAP_SIZE * zoom}
            height={MAP_SIZE * zoom}
            style={{
              display: "block",
              cursor: "crosshair",
              imageRendering: "pixelated",
            }}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerLeave={() => setHover(null)}
            onContextMenu={(e) => e.preventDefault()}
          />
        </div>
        <div
          style={{
            padding: "6px 8px",
            borderTop: "1px solid #2a2d3a",
            color: "#8b8fa3",
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
        >
          {status ||
            "Left paints, right erases its layer. Drag markers to move visitors and your spawn. Water only inland; painting water clears what stood there."}
        </div>
      </div>
      <div
        style={{
          flex: 1,
          minWidth: 0,
          position: "relative",
          borderLeft: "1px solid #2a2d3a",
        }}
      >
        <TownCanvas
          map={preview}
          spots={spots}
          player={PLAYER}
          paused={false}
          respawn={respawn}
          hour={timeMode === "clock" ? null : readHour}
          pixelScale={pixelScale}
          onOpen={() => {}}
          onNearChange={() => {}}
        />
        <div
          style={{
            position: "absolute",
            left: 8,
            bottom: 8,
            color: "#ffffffa0",
            pointerEvents: "none",
          }}
        >
          WASD walk · drag to look · P respawn
        </div>
        <div
          style={{
            position: "absolute",
            right: 8,
            bottom: 8,
            display: "flex",
            alignItems: "center",
            gap: 4,
            color: "#ffffffc0",
            background: "#0008",
            padding: "4px 6px",
            borderRadius: 4,
          }}
        >
          {TIME_MODES.map(({ mode, label, title }) => (
            <button
              key={String(mode)}
              type="button"
              title={title}
              style={{ ...btn(timeMode === mode), padding: "2px 6px" }}
              onClick={() => {
                // Leaving the clock: start from now.
                if (timeMode === "clock" && mode !== "clock") {
                  setHour(localHours());
                }
                setTimeMode(mode);
              }}
            >
              {label}
            </button>
          ))}
          <input
            type="range"
            min={0}
            max={24}
            step={0.05}
            disabled={timeMode === "clock"}
            value={timeMode === "clock" ? localHours() : shownHour}
            onChange={(e) => setHour(Number(e.target.value))}
          />
          <span style={{ width: 40, textAlign: "right" }}>
            {timeMode === "clock" ? "now" : clockText(shownHour)}
          </span>
        </div>
        <div
          style={{
            position: "absolute",
            right: 8,
            bottom: 44,
            display: "flex",
            alignItems: "center",
            gap: 6,
            color: "#ffffffc0",
            background: "#0008",
            padding: "4px 6px",
            borderRadius: 4,
          }}
          title="Screen pixels per Town pixel. The game uses PIXEL_SCALE in TownCanvas."
        >
          Resolution
          <input
            type="range"
            // Fine on the left, chunky on the right.
            min={1}
            max={10}
            step={1}
            value={pixelSize}
            onChange={(e) => setPixelSize(Number(e.target.value))}
          />
          <span style={{ width: 110, textAlign: "right" }}>
            {pixelSize}px · scale {pixelScale.toFixed(2)}
          </span>
        </div>
      </div>
    </div>
  );
}

const root = document.getElementById("root");
if (root) createRoot(root).render(<MapEditor />);
