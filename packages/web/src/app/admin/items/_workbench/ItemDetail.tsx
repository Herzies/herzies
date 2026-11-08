"use client";

import { artworkFromIcon } from "@herzies/shared";
import { RotateCcw, Save, Trash2, Undo2 } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { adminFetch } from "../../_components/admin-shared";
import {
  ItemForm,
  type ItemFormState,
  itemFormToPayload,
  itemToForm,
  newItemForm,
} from "../../_components/sections";
import { artRequest, type ItemArtData, postJson } from "./api";
import { CardIllustration } from "./CardIllustration";
import type { ItemRowModel } from "./ItemsWorkbench";
import { PixelCanvas } from "./PixelCanvas";
import { type PixelBuffer, PixelPainter } from "./PixelPainter";

const MAX_NAME = 40;
const MAX_DESCRIPTION = 200;

/** The artwork buffer: saved on its own, or made from the icon as it is. */
function artworkBuffer(
  art: ItemArtData,
  id: string,
  icon: PixelBuffer,
): PixelBuffer {
  const saved = art.artwork[id];
  if (saved) {
    return {
      grid: [...saved.grid],
      palette: [...saved.palette],
      dirty: false,
      derived: false,
    };
  }
  return {
    grid: artworkFromIcon(icon.grid),
    palette: [...icon.palette],
    dirty: false,
    derived: true,
  };
}

export function ItemDetail({
  row,
  art,
  setArt,
  local,
  secret,
  onDbChange,
  onDirty,
}: {
  row: ItemRowModel;
  art: ItemArtData | null;
  setArt: React.Dispatch<React.SetStateAction<ItemArtData | null>>;
  local: boolean;
  secret: string;
  onDbChange: () => Promise<void>;
  onDirty: (dirty: boolean) => void;
}) {
  const { id, db, art: artItem } = row;
  const stored = art?.grids[id];
  const [icon, setIcon] = useState<PixelBuffer | null>(() =>
    stored ? { ...stored, grid: [...stored.grid], dirty: false } : null,
  );
  const [artwork, setArtwork] = useState<PixelBuffer | null>(() =>
    art && icon && artItem?.isItem ? artworkBuffer(art, id, icon) : null,
  );
  const [illustrationDirty, setIllustrationDirty] = useState(false);
  const [textDirty, setTextDirty] = useState(false);
  const [busy, setBusy] = useState(false);

  // Art arrives after the database list on first load.
  useEffect(() => {
    if (!icon && stored) {
      const fresh = { ...stored, grid: [...stored.grid], dirty: false };
      setIcon(fresh);
      if (art && artItem?.isItem) setArtwork(artworkBuffer(art, id, fresh));
    }
  }, [icon, stored, art, artItem, id]);

  // Artwork made from the icon follows it until it's edited on its own.
  useEffect(() => {
    if (icon && artwork?.derived && !artwork.dirty) {
      setArtwork({
        grid: artworkFromIcon(icon.grid),
        palette: [...icon.palette],
        dirty: false,
        derived: true,
      });
    }
  }, [icon, artwork?.derived, artwork?.dirty]);

  useEffect(() => {
    onDirty(
      !!icon?.dirty || !!artwork?.dirty || illustrationDirty || textDirty,
    );
  }, [icon?.dirty, artwork?.dirty, illustrationDirty, textDirty, onDirty]);

  const name = artItem?.name ?? db?.name ?? id;
  const hasArt = local && !!art && !!artItem && !!icon;
  const hasCard = hasArt && !!artItem?.isItem && !!artwork;

  const saveIcon = async () => {
    if (!icon) return;
    setBusy(true);
    try {
      await postJson(secret, `/${encodeURIComponent(id)}/icon`, {
        grid: icon.grid,
        palette: icon.palette,
      });
      setIcon({ ...icon, dirty: false });
      setArt((a) =>
        a
          ? {
              ...a,
              grids: {
                ...a.grids,
                [id]: { grid: icon.grid, palette: icon.palette },
              },
              items: a.items.map((i) =>
                i.id === id ? { ...i, unpainted: false } : i,
              ),
            }
          : a,
      );
      toast.success(`Saved ${name}'s icon`, {
        description: "Shared rebuilt: the app picks it up automatically.",
      });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to save");
    } finally {
      setBusy(false);
    }
  };

  const saveArtwork = async () => {
    if (!artwork) return;
    setBusy(true);
    try {
      await postJson(secret, `/${encodeURIComponent(id)}/artwork`, {
        grid: artwork.grid,
        palette: artwork.palette,
      });
      setArtwork({ ...artwork, dirty: false, derived: false });
      setArt((a) =>
        a
          ? {
              ...a,
              artwork: {
                ...a.artwork,
                [id]: { grid: artwork.grid, palette: artwork.palette },
              },
            }
          : a,
      );
      toast.success(`Saved ${name}'s card artwork`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to save");
    } finally {
      setBusy(false);
    }
  };

  /** Drops the artwork's own edits: back to being made from the icon. */
  const resetArtwork = async () => {
    if (!art || !icon) return;
    if (art.artwork[id]) {
      if (
        !confirm(
          "Delete this card's own artwork and go back to making it from the icon?",
        )
      )
        return;
      setBusy(true);
      try {
        await artRequest(secret, `/${encodeURIComponent(id)}/artwork`, {
          method: "DELETE",
        });
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Failed to reset");
        setBusy(false);
        return;
      }
      setBusy(false);
    }
    const { [id]: _dropped, ...rest } = art.artwork;
    setArt({ ...art, artwork: rest });
    setArtwork({
      grid: artworkFromIcon(icon.grid),
      palette: [...icon.palette],
      dirty: false,
      derived: true,
    });
    toast.success("Back to the icon's artwork");
  };

  const iconPreview = icon ?? (stored ? { ...stored, dirty: false } : null);

  return (
    <div className="grid gap-6">
      <div className="flex items-center gap-4">
        {iconPreview ? (
          <PixelCanvas
            art={iconPreview}
            gradient={artItem?.gradient}
            scale={2}
            className="rounded-md border p-1"
          />
        ) : null}
        <div className="min-w-0">
          <h2 className="truncate text-lg font-semibold">{name}</h2>
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <span className="font-mono">{id}</span>
            {db && <Badge variant="outline">{db.rarity}</Badge>}
            {local && art && !db && (
              <Badge variant="destructive">not in database</Badge>
            )}
            {local && art && !artItem && (
              <Badge variant="outline">not in items.ts</Badge>
            )}
          </div>
        </div>
      </div>

      <Tabs defaultValue="details">
        <TabsList>
          <TabsTrigger value="details">Details</TabsTrigger>
          {hasArt && <TabsTrigger value="icon">Icon</TabsTrigger>}
          {hasCard && <TabsTrigger value="artwork">Card artwork</TabsTrigger>}
          {hasCard && (
            <TabsTrigger value="illustration">Illustration</TabsTrigger>
          )}
        </TabsList>

        <TabsContent value="details" className="grid gap-4 pt-2">
          {local && artItem?.editableText && (
            <GameText
              key={`${artItem.name}|${artItem.description}`}
              id={id}
              secret={secret}
              name={artItem.name}
              description={artItem.description}
              dbName={db?.name}
              dbDescription={db?.description}
              onDirty={setTextDirty}
              onSaved={(next) =>
                setArt((a) =>
                  a
                    ? {
                        ...a,
                        items: a.items.map((i) =>
                          i.id === id ? { ...i, ...next } : i,
                        ),
                      }
                    : a,
                )
              }
            />
          )}
          <DatabaseCard
            key={db ? JSON.stringify(db) : "none"}
            row={row}
            secret={secret}
            onChange={onDbChange}
          />
          {!local && (
            <p className="text-xs text-muted-foreground">
              Icons, card art and game text are edited in the local control
              panel (`pnpm studio`): they're saved into the repo.
            </p>
          )}
        </TabsContent>

        {hasArt && icon && (
          <TabsContent value="icon" className="grid gap-4 pt-2">
            <p className="text-xs text-muted-foreground">
              The item&apos;s icon: bag tiles, deck boxes, the store, and
              everywhere else at 24px.
            </p>
            <PixelPainter
              buffer={icon}
              onChange={setIcon}
              gradient={artItem?.gradient ?? null}
              autoColor={artItem?.autoColor ?? "#ffffff"}
              previewScale={4}
              previewLabel="Actual size, and 4x"
            />
            <PaintActions
              busy={busy}
              dirty={icon.dirty}
              onSave={saveIcon}
              onRevert={() =>
                stored &&
                setIcon({ ...stored, grid: [...stored.grid], dirty: false })
              }
            />
          </TabsContent>
        )}

        {hasCard && artwork && (
          <TabsContent value="artwork" className="grid gap-4 pt-2">
            <p className="text-xs text-muted-foreground">
              {artwork.derived
                ? "The card's artwork, made from the icon with its frame removed. It follows the icon until you save it here."
                : "The card's artwork, edited on its own. Reset to icon to make it follow the icon again."}
              {art?.cardArt[id]?.file && (
                <span className="block text-yellow">
                  This card shows its illustration instead; the artwork only
                  shows without one.
                </span>
              )}
            </p>
            <PixelPainter
              buffer={artwork}
              onChange={setArtwork}
              gradient={artItem?.gradient ?? null}
              autoColor={artItem?.autoColor ?? "#ffffff"}
              previewScale={6}
              previewLabel="Actual size, and as on the card (6x)"
            />
            <PaintActions
              busy={busy}
              dirty={artwork.dirty}
              onSave={saveArtwork}
              onRevert={() =>
                art && icon && setArtwork(artworkBuffer(art, id, icon))
              }
              extra={
                <Button
                  variant="ghost"
                  disabled={busy || (artwork.derived && !artwork.dirty)}
                  onClick={resetArtwork}
                >
                  <Undo2 />
                  Reset to icon
                </Button>
              }
            />
          </TabsContent>
        )}

        {hasCard && artwork && art && (
          <TabsContent value="illustration" className="pt-2">
            <CardIllustration
              secret={secret}
              itemId={id}
              itemName={name}
              entry={art.cardArt[id]}
              artwork={artwork}
              gradient={artItem?.gradient ?? null}
              onDirty={setIllustrationDirty}
              onEntry={(entry) =>
                setArt((a) => {
                  if (!a) return a;
                  const cardArt = { ...a.cardArt };
                  if (entry) cardArt[id] = entry;
                  else delete cardArt[id];
                  return { ...a, cardArt };
                })
              }
            />
          </TabsContent>
        )}
      </Tabs>
    </div>
  );
}

function PaintActions({
  busy,
  dirty,
  onSave,
  onRevert,
  extra,
}: {
  busy: boolean;
  dirty: boolean;
  onSave: () => void;
  onRevert: () => void;
  extra?: React.ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button disabled={busy || !dirty} onClick={onSave}>
        <Save />
        {busy ? "Saving and rebuilding..." : "Save"}
      </Button>
      <Button variant="outline" disabled={busy || !dirty} onClick={onRevert}>
        <RotateCcw />
        Revert
      </Button>
      {extra}
      {dirty && (
        <span className="text-xs text-muted-foreground">Unsaved changes</span>
      )}
    </div>
  );
}

/** The name and description the apps show, in shared/src/items.ts. */
function GameText({
  id,
  secret,
  name,
  description,
  dbName,
  dbDescription,
  onDirty,
  onSaved,
}: {
  id: string;
  secret: string;
  name: string;
  description: string;
  dbName?: string;
  dbDescription?: string;
  onDirty: (dirty: boolean) => void;
  onSaved: (next: { name: string; description: string }) => void;
}) {
  const [form, setForm] = useState({ name, description });
  const [busy, setBusy] = useState(false);
  const dirty = form.name !== name || form.description !== description;

  useEffect(() => {
    onDirty(dirty);
  }, [dirty, onDirty]);

  const differs =
    dbName !== undefined &&
    (dbName !== name || (dbDescription ?? "") !== description);

  const save = async () => {
    setBusy(true);
    try {
      const res = await postJson<{ name: string; description: string }>(
        secret,
        `/${encodeURIComponent(id)}/text`,
        form,
      );
      onSaved({ name: res.name, description: res.description });
      toast.success("Saved to items.ts", {
        description: "Shared and the edge functions' copy rebuilt.",
      });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to save");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Game text</CardTitle>
        <CardDescription>
          What the apps show, from shared/src/items.ts. Ships with the next
          release.
        </CardDescription>
        {differs && (
          <CardAction>
            <Badge variant="outline" className="text-yellow">
              differs from database
            </Badge>
          </CardAction>
        )}
      </CardHeader>
      <CardContent className="grid gap-4">
        <div className="grid gap-2">
          <Label htmlFor="game-name">Name</Label>
          <Input
            id="game-name"
            maxLength={MAX_NAME}
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
          />
        </div>
        <div className="grid gap-2">
          <div className="flex items-center justify-between">
            <Label htmlFor="game-description">Description</Label>
            <span className="font-mono text-xs text-muted-foreground">
              {form.description.length}/{MAX_DESCRIPTION}
            </span>
          </div>
          <Textarea
            id="game-description"
            maxLength={MAX_DESCRIPTION}
            value={form.description}
            onChange={(e) => setForm({ ...form, description: e.target.value })}
          />
        </div>
        <div className="flex flex-wrap gap-2">
          <Button disabled={!dirty || busy} onClick={save}>
            <Save />
            {busy ? "Saving and rebuilding..." : "Save to items.ts"}
          </Button>
          <Button
            variant="outline"
            disabled={!dirty || busy}
            onClick={() => setForm({ name, description })}
          >
            <RotateCcw />
            Revert
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

/** The item's row in the database: what the server sells, drops and equips. */
function DatabaseCard({
  row,
  secret,
  onChange,
}: {
  row: ItemRowModel;
  secret: string;
  onChange: () => Promise<void>;
}) {
  const { db, art } = row;
  const [form, setForm] = useState<ItemFormState>(() =>
    db
      ? itemToForm(db)
      : newItemForm({
          id: row.id,
          name: art?.name ?? "",
          description: art?.description ?? "",
        }),
  );
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const sellPrice = form.sellPrice.trim();
    if (
      sellPrice !== "" &&
      (Number.isNaN(Number(sellPrice)) || Number(sellPrice) < 0)
    ) {
      setError("Sell price must be a non-negative number");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await adminFetch("/api/admin/items", secret, {
        method: "POST",
        body: JSON.stringify(itemFormToPayload(form)),
      });
      toast.success(db ? "Saved to the database" : "Added to the database");
      setAdding(false);
      await onChange();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (
      !db ||
      !confirm(`Delete item "${db.name}" (${db.id}) from the database?`)
    )
      return;
    setBusy(true);
    try {
      await adminFetch(
        `/api/admin/items?id=${encodeURIComponent(db.id)}`,
        secret,
        {
          method: "DELETE",
        },
      );
      toast.success("Deleted from the database");
      await onChange();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Database</CardTitle>
        <CardDescription>
          The items table: rarity, sell price, stacking and equip slot. Live as
          soon as it's saved.
        </CardDescription>
        {db && (
          <CardAction>
            <Button
              variant="ghost"
              size="sm"
              className="text-destructive"
              disabled={busy}
              onClick={remove}
            >
              <Trash2 />
              Delete
            </Button>
          </CardAction>
        )}
      </CardHeader>
      <CardContent>
        {db || adding ? (
          <ItemForm
            form={form}
            setForm={setForm}
            onSubmit={submit}
            onCancel={
              db ? () => setForm(itemToForm(db)) : () => setAdding(false)
            }
            submitLabel={db ? "save changes" : "add to database"}
            disabled={busy}
            idReadonly
          />
        ) : (
          <div className="flex items-center justify-between gap-4 text-sm text-muted-foreground">
            <span>This item has no row in the database.</span>
            <Button variant="outline" onClick={() => setAdding(true)}>
              Add to database
            </Button>
          </div>
        )}
        {error && <p className="mt-2 text-xs text-destructive">{error}</p>}
      </CardContent>
    </Card>
  );
}
