"use client";

import { useEffect, useRef } from "react";
import { cn } from "@/lib/utils";
import { dims, drawGrid, type PixelArt } from "./pixel";

/** A pixel grid drawn hard-edged at `scale` CSS px per pixel. */
export function PixelCanvas({
  art,
  gradient,
  scale = 1,
  className,
}: {
  art: PixelArt;
  gradient?: string[] | null;
  scale?: number;
  className?: string;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    if (ref.current) drawGrid(ref.current, art, gradient);
  }, [art, gradient]);
  const { w, h } = dims(art.grid);
  return (
    <canvas
      ref={ref}
      className={cn("[image-rendering:pixelated] shrink-0", className)}
      style={{ width: w * scale, height: h * scale }}
    />
  );
}
