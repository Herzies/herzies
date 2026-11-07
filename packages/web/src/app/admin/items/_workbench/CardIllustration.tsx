"use client";

import { ImageUp, RotateCcw, Save, Trash2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import { artRequest, type CardArtEntry, loadOriginal } from "./api";
import {
  type ArtSettings,
  CARD_ART_H,
  CARD_ART_W,
  cropRect,
  MAX_ZOOM,
  renderCardArt,
  settingsFromEntry,
} from "./card-render";
import { drawGrid, type PixelArt } from "./pixel";

/**
 * The art on an item's collector card. The artist's original is kept as
 * uploaded; the card shows a finished 4:3 image rendered here, framed and
 * optionally filtered, saved with the settings that made it.
 */
export function CardIllustration({
  secret,
  itemId,
  itemName,
  entry,
  artwork,
  gradient,
  onEntry,
  onDirty,
}: {
  secret: string;
  itemId: string;
  itemName: string;
  entry: CardArtEntry | undefined;
  /** What the card shows without an illustration: its pixel artwork. */
  artwork: PixelArt;
  gradient: string[] | null;
  onEntry: (entry: CardArtEntry | null) => void;
  onDirty: (dirty: boolean) => void;
}) {
  const [source, setSource] = useState<HTMLImageElement | null>(null);
  const [settings, setSettings] = useState<ArtSettings>(() =>
    settingsFromEntry(entry),
  );
  const [dirty, setDirtyState] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [over, setOver] = useState(false);
  const bigRef = useRef<HTMLCanvasElement>(null);
  const actualRef = useRef<HTMLCanvasElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const drag = useRef<{ x: number; y: number } | null>(null);

  const setDirty = useCallback(
    (v: boolean) => {
      setDirtyState(v);
      onDirty(v);
    },
    [onDirty],
  );

  // The original of this item (re-fetched when a new one is uploaded).
  const sourceName = entry?.source;
  useEffect(() => {
    let cancelled = false;
    setSource(null);
    if (!sourceName) return;
    loadOriginal(secret, sourceName)
      .then((img) => {
        if (!cancelled) setSource(img);
      })
      .catch((e: Error) => {
        if (!cancelled) setError(e.message);
      });
    return () => {
      cancelled = true;
    };
  }, [secret, sourceName]);

  // Both previews; without an original, the card's pixel artwork.
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      const canvases = [actualRef.current, bigRef.current].filter(
        (c): c is HTMLCanvasElement => !!c,
      );
      let image: CanvasImageSource;
      if (source) {
        image = renderCardArt(source, settings);
      } else {
        const pixels = document.createElement("canvas");
        drawGrid(pixels, artwork, gradient);
        image = pixels;
      }
      for (const canvas of canvases) {
        const ctx = canvas.getContext("2d");
        if (!ctx) continue;
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.imageSmoothingEnabled = !!source;
        ctx.imageSmoothingQuality = "high";
        ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [source, settings, artwork, gradient]);

  const change = (mutate: (s: ArtSettings) => ArtSettings) => {
    if (!source) return;
    setSettings(mutate);
    setDirty(true);
  };

  const save = async (img = source, s = settings) => {
    if (!img) return;
    setBusy(true);
    setError(null);
    try {
      const canvas = renderCardArt(img, s);
      // WebP keeps paintings small; PNG if the browser can't encode it.
      let blob = await new Promise<Blob | null>((r) =>
        canvas.toBlob(r, "image/webp", 0.9),
      );
      if (!blob || blob.type !== "image/webp") {
        blob = await new Promise<Blob | null>((r) =>
          canvas.toBlob(r, "image/png"),
        );
      }
      if (!blob) throw new Error("Couldn't encode the image");
      const query = encodeURIComponent(JSON.stringify(s));
      const res = await artRequest<{ entry: CardArtEntry }>(
        secret,
        `/${encodeURIComponent(itemId)}/card-art/render?settings=${query}`,
        { method: "PUT", body: blob },
      );
      onEntry(res.entry);
      setDirty(false);
      toast.success(`Saved ${itemName}'s card image`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save");
    } finally {
      setBusy(false);
    }
  };

  const upload = async (file: File | undefined) => {
    if (!file) return;
    if (dirty && !confirm("Replace the original and discard unsaved framing?"))
      return;
    setBusy(true);
    setError(null);
    try {
      const res = await artRequest<{ entry: CardArtEntry }>(
        secret,
        `/${encodeURIComponent(itemId)}/card-art/source`,
        { method: "PUT", body: file },
      );
      // Straight to a card image at the default framing, so the card has
      // art right away; re-frame and save again from here.
      const img = await loadOriginal(secret, res.entry.source ?? "");
      const fresh = settingsFromEntry(res.entry);
      setSettings(fresh);
      setSource(img);
      onEntry(res.entry);
      await save(img, fresh);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Upload failed");
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (
      !confirm(
        `Remove ${itemName}'s card illustration? The original and the card image are both deleted.`,
      )
    )
      return;
    setBusy(true);
    try {
      await artRequest(secret, `/${encodeURIComponent(itemId)}/card-art`, {
        method: "DELETE",
      });
      setSource(null);
      setSettings(settingsFromEntry(undefined));
      setDirty(false);
      onEntry(null);
      toast.success("Removed: the card shows its pixel artwork again");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to remove");
    } finally {
      setBusy(false);
    }
  };

  const setZoom = (zoom: number) =>
    change((s) => ({
      ...s,
      crop: { ...s.crop, zoom: Math.min(MAX_ZOOM, Math.max(1, zoom)) },
    }));

  // Mouse wheel zooms the big preview (needs a non-passive listener).
  useEffect(() => {
    const canvas = bigRef.current;
    if (!canvas || !source) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      setSettings((s) => ({
        ...s,
        crop: {
          ...s.crop,
          zoom: Math.min(
            MAX_ZOOM,
            Math.max(1, s.crop.zoom * Math.exp(-e.deltaY * 0.0015)),
          ),
        },
      }));
      setDirty(true);
    };
    canvas.addEventListener("wheel", onWheel, { passive: false });
    return () => canvas.removeEventListener("wheel", onWheel);
  }, [source, setDirty]);

  const shown = source ? Math.round(cropRect(source, settings.crop).sw) : 0;
  const zoomPct = Math.round(settings.crop.zoom * 100);

  return (
    <div className="flex flex-wrap gap-6">
      <div className="grid gap-3 text-xs text-muted-foreground">
        <span>Actual size, as on the card</span>
        <canvas
          ref={actualRef}
          width={CARD_ART_W}
          height={CARD_ART_H}
          className="rounded-sm border"
          style={{ width: 192, height: 144 }}
        />
        <span>Drag to move, scroll to zoom</span>
        <canvas
          ref={bigRef}
          width={CARD_ART_W}
          height={CARD_ART_H}
          className={cn(
            "max-w-full touch-none rounded-sm border",
            source ? "cursor-grab active:cursor-grabbing" : "opacity-60",
            !source && "[image-rendering:pixelated]",
          )}
          style={{ width: 480, height: 360 }}
          onPointerDown={(e) => {
            if (!source) return;
            drag.current = { x: e.clientX, y: e.clientY };
            e.currentTarget.setPointerCapture(e.pointerId);
          }}
          onPointerMove={(e) => {
            if (!drag.current || !source) return;
            const dx = e.clientX - drag.current.x;
            const dy = e.clientY - drag.current.y;
            drag.current = { x: e.clientX, y: e.clientY };
            const width = e.currentTarget.clientWidth;
            change((s) => {
              const w = source.naturalWidth;
              const h = source.naturalHeight;
              const { sw, sh } = cropRect(source, s.crop);
              // Screen px to original px at this zoom, then to % of slack.
              const scale = sw / width;
              const crop = { ...s.crop };
              if (w - sw > 0.5)
                crop.x = Math.min(
                  100,
                  Math.max(0, crop.x - ((dx * scale) / (w - sw)) * 100),
                );
              if (h - sh > 0.5)
                crop.y = Math.min(
                  100,
                  Math.max(0, crop.y - ((dy * scale) / (h - sh)) * 100),
                );
              return { ...s, crop };
            });
          }}
          onPointerUp={() => {
            drag.current = null;
          }}
          onPointerCancel={() => {
            drag.current = null;
          }}
        />
      </div>

      <div className="grid min-w-64 max-w-sm flex-1 content-start gap-4">
        <button
          type="button"
          disabled={busy}
          onClick={() => fileRef.current?.click()}
          onDragOver={(e) => {
            e.preventDefault();
            setOver(true);
          }}
          onDragLeave={() => setOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            setOver(false);
            upload(e.dataTransfer.files[0]);
          }}
          className={cn(
            "grid place-items-center gap-2 rounded-lg border border-dashed p-6 text-sm text-muted-foreground transition-colors hover:bg-accent",
            over && "border-primary bg-accent",
          )}
        >
          <ImageUp className="size-5" />
          {source
            ? "Drop a new original here, or click to replace it"
            : "Drop an image here, or click to choose one"}
        </button>
        <input
          ref={fileRef}
          type="file"
          hidden
          accept="image/png,image/jpeg,image/webp,image/gif,image/avif"
          onChange={(e) => {
            upload(e.target.files?.[0]);
            e.target.value = "";
          }}
        />

        <div className="text-xs text-muted-foreground">
          {!source && !entry?.source && (
            <p>No illustration: the card shows its pixel artwork.</p>
          )}
          {source && entry?.source && (
            <p>
              Original: {entry.source}, {source.naturalWidth}x
              {source.naturalHeight}px
            </p>
          )}
          {source &&
            shown < 384 &&
            !settings.pixelated &&
            settings.filter.type === "none" && (
              <p className="text-yellow">
                Showing {shown}px of its width: it will look soft on high-DPI
                screens. Zoom out, use a bigger original, or tick Pixel art.
              </p>
            )}
          {source && !entry?.file && (
            <p className="text-yellow">Not saved as a card image yet.</p>
          )}
        </div>

        <fieldset disabled={!source || busy} className="grid gap-4">
          <div className="grid gap-2">
            <div className="flex items-center justify-between">
              <Label htmlFor="art-zoom">Zoom</Label>
              <span className="font-mono text-xs text-muted-foreground">
                {zoomPct}%
              </span>
            </div>
            <div className="flex items-center gap-2">
              <input
                id="art-zoom"
                type="range"
                min={100}
                max={MAX_ZOOM * 100}
                value={zoomPct}
                onChange={(e) => setZoom(Number(e.target.value) / 100)}
                className="flex-1 accent-primary"
              />
              <Button
                variant="ghost"
                size="sm"
                onClick={() =>
                  change((s) => ({ ...s, crop: { zoom: 1, x: 50, y: 50 } }))
                }
              >
                Reset
              </Button>
            </div>
          </div>

          <div className="grid gap-2">
            <Label>Filter</Label>
            <div className="flex gap-2">
              {(["none", "lofi"] as const).map((type) => (
                <Button
                  key={type}
                  size="sm"
                  variant={
                    settings.filter.type === type ? "secondary" : "outline"
                  }
                  onClick={() =>
                    change((s) => ({ ...s, filter: { ...s.filter, type } }))
                  }
                >
                  {type === "none" ? "None" : "Lo-fi"}
                </Button>
              ))}
            </div>
            {settings.filter.type === "lofi" && (
              <div className="flex items-center gap-2">
                <input
                  type="range"
                  min={0}
                  max={100}
                  value={settings.filter.detail}
                  onChange={(e) =>
                    change((s) => ({
                      ...s,
                      filter: { ...s.filter, detail: Number(e.target.value) },
                    }))
                  }
                  className="flex-1 accent-primary"
                />
                <span className="w-16 text-right font-mono text-xs text-muted-foreground">
                  detail {Math.round(settings.filter.detail)}
                </span>
              </div>
            )}
          </div>

          <div className="grid gap-2">
            <Label htmlFor="art-artist">Artist credit</Label>
            <Input
              id="art-artist"
              maxLength={60}
              placeholder="e.g. Jane Doe"
              value={settings.artist}
              onChange={(e) =>
                change((s) => ({ ...s, artist: e.target.value }))
              }
            />
          </div>

          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={settings.pixelated}
              onChange={(e) =>
                change((s) => ({ ...s, pixelated: e.target.checked }))
              }
              className="accent-primary"
            />
            Pixel art (scale without smoothing)
          </label>

          <div className="flex flex-wrap gap-2">
            <Button onClick={() => save()}>
              <Save />
              Save card image
            </Button>
            <Button
              variant="outline"
              disabled={!dirty}
              onClick={() => {
                setSettings(settingsFromEntry(entry));
                setDirty(false);
              }}
            >
              <RotateCcw />
              Revert
            </Button>
            <Button
              variant="ghost"
              className="text-destructive"
              onClick={remove}
            >
              <Trash2 />
              Remove
            </Button>
          </div>
        </fieldset>
        {error && <p className="text-xs text-destructive">{error}</p>}
      </div>
    </div>
  );
}
