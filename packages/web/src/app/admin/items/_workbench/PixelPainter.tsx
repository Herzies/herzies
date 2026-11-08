"use client";

import { Eraser, Wand2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { PixelCanvas } from "./PixelCanvas";
import {
  colorForChar,
  dims,
  EMPTY_PIXEL,
  MAX_PALETTE,
  type PixelArt,
} from "./pixel";

export type PixelBuffer = PixelArt & {
  dirty: boolean;
  /** Card artwork still made from the icon (not saved on its own). */
  derived?: boolean;
};

/**
 * Paints a pixel grid: click or drag with the picked colour (added to the
 * palette when new) or the eraser. The previews show it at its real size
 * and enlarged, tinted the way the app tints it.
 */
export function PixelPainter({
  buffer,
  onChange,
  gradient,
  autoColor,
  previewScale,
  previewLabel,
}: {
  buffer: PixelBuffer;
  onChange: (next: PixelBuffer) => void;
  gradient: string[] | null;
  autoColor: string;
  /** The enlarged preview: 4x for icons, 6x (the card's window) for artwork. */
  previewScale: number;
  previewLabel: string;
}) {
  const [paintColor, setPaintColor] = useState(buffer.palette[0] ?? autoColor);
  const [erasing, setErasing] = useState(false);
  const [warning, setWarning] = useState<string | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  // The latest buffer, for a drag that outlives a render.
  const latest = useRef(buffer);
  latest.current = buffer;
  const stroke = useRef<string | null>(null);

  const { w, h } = dims(buffer.grid);
  // Wider grids get smaller cells so the editor stays about the same size.
  const cellPx = w > 24 ? 16 : w > 16 ? 20 : 24;

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    canvas.width = w * cellPx;
    canvas.height = h * cellPx;
    ctx.fillStyle = "#1c1f2b";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        ctx.fillStyle =
          colorForChar(buffer.grid[y][x], buffer.palette) ?? EMPTY_PIXEL;
        ctx.fillRect(x * cellPx, y * cellPx, cellPx - 1, cellPx - 1);
      }
    }
  }, [buffer, w, h, cellPx]);

  /** The character to paint with: a palette digit, or "." for the eraser.
   * Adds a new colour to the palette first; null when it's full. */
  const charToPaintWith = (): { ch: string; palette: string[] } | null => {
    const { palette } = latest.current;
    if (erasing) return { ch: ".", palette };
    const wanted = paintColor.toLowerCase();
    const idx = palette.findIndex((c) => c.toLowerCase() === wanted);
    if (idx >= 0) return { ch: idx.toString(16), palette };
    if (palette.length >= MAX_PALETTE) {
      setWarning(
        `Palette full (${MAX_PALETTE} colours): pick an existing swatch.`,
      );
      return null;
    }
    return {
      ch: palette.length.toString(16),
      palette: [...palette, paintColor],
    };
  };

  const paintAt = (
    clientX: number,
    clientY: number,
    ch: string,
    palette: string[],
  ) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const x = Math.floor(((clientX - rect.left) / rect.width) * w);
    const y = Math.floor(((clientY - rect.top) / rect.height) * h);
    if (x < 0 || y < 0 || x >= w || y >= h) return;
    const cur = latest.current;
    if (cur.grid[y][x] === ch && cur.palette === palette) return;
    const grid = [...cur.grid];
    grid[y] = grid[y].slice(0, x) + ch + grid[y].slice(x + 1);
    const next = { ...cur, grid, palette, dirty: true };
    latest.current = next;
    onChange(next);
  };

  const pick = (color: string) => {
    setErasing(false);
    setPaintColor(color);
    setWarning(null);
  };

  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-start gap-6">
        <canvas
          ref={canvasRef}
          className="cursor-crosshair touch-none rounded-sm border"
          style={{ width: w * cellPx, height: h * cellPx }}
          onPointerDown={(e) => {
            const paint = charToPaintWith();
            if (!paint) return;
            stroke.current = paint.ch;
            e.currentTarget.setPointerCapture(e.pointerId);
            paintAt(e.clientX, e.clientY, paint.ch, paint.palette);
          }}
          onPointerMove={(e) => {
            if (stroke.current === null) return;
            paintAt(
              e.clientX,
              e.clientY,
              stroke.current,
              latest.current.palette,
            );
          }}
          onPointerUp={() => {
            stroke.current = null;
          }}
          onPointerCancel={() => {
            stroke.current = null;
          }}
        />
        <div className="grid justify-items-center gap-3 text-center text-xs text-muted-foreground">
          <span>{previewLabel}</span>
          <PixelCanvas art={buffer} gradient={gradient} />
          <PixelCanvas
            art={buffer}
            gradient={gradient}
            scale={previewScale}
            className="rounded-sm border"
          />
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <label className="flex items-center gap-2 text-sm">
          <span className="text-muted-foreground">Colour</span>
          <input
            type="color"
            value={paintColor}
            onChange={(e) => pick(e.target.value)}
            className="h-8 w-10 cursor-pointer rounded border bg-transparent"
          />
        </label>
        <Button variant="outline" size="sm" onClick={() => pick(autoColor)}>
          <Wand2 />
          Auto colour
        </Button>
        <Button
          variant={erasing ? "secondary" : "outline"}
          size="sm"
          onClick={() => setErasing((v) => !v)}
        >
          <Eraser />
          Eraser
        </Button>
        <div className="flex flex-wrap gap-1">
          {buffer.palette.map((color) => (
            <button
              key={color}
              type="button"
              title={color}
              onClick={() => pick(color)}
              className={cn(
                "size-6 rounded border",
                !erasing &&
                  color.toLowerCase() === paintColor.toLowerCase() &&
                  "ring-2 ring-ring ring-offset-2 ring-offset-background",
              )}
              style={{ background: color }}
            />
          ))}
        </div>
      </div>
      {gradient && gradient.length > 0 && (
        <p className="text-xs text-muted-foreground">
          This item is in a set with a shared gradient: the app tints it with
          that, keeping only the lightness of what you paint here.
        </p>
      )}
      {warning && <p className="text-xs text-destructive">{warning}</p>}
    </div>
  );
}
