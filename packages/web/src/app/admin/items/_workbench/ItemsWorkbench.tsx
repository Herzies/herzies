"use client";

import { ICON_GRID_JSON } from "@herzies/shared";
import { Plus, Search } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { useAdminData } from "../../_components/admin-data";
import { adminFetch, type CatalogItem } from "../../_components/admin-shared";
import {
  ItemForm,
  type ItemFormState,
  itemFormToPayload,
  newItemForm,
} from "../../_components/sections";
import { type ArtItem, artRequest, type ItemArtData } from "./api";
import { ItemDetail } from "./ItemDetail";
import { PixelCanvas } from "./PixelCanvas";
import type { PixelArt } from "./pixel";

/** One row of the list: an item in the database, in the art files, or both. */
export type ItemRowModel = {
  id: string;
  name: string;
  db?: CatalogItem;
  art?: ArtItem;
};

const BUNDLED_ICONS = ICON_GRID_JSON as Record<string, PixelArt>;

/**
 * Every item in one place: its database row (rarity, price, slot) and, on
 * this machine, its game text, icon, card artwork and illustration, which
 * are written into @herzies/shared.
 */
export function ItemsWorkbench({ local }: { local: boolean }) {
  const { secret, ready, needsSecret, items: dbItems, load } = useAdminData();
  const [art, setArt] = useState<ItemArtData | null>(null);
  const [artError, setArtError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  /** Unsaved edits in the open item, so switching asks first. */
  const dirty = useRef(false);

  const loadArt = useCallback(async () => {
    if (!local || !ready || needsSecret) return;
    try {
      setArt(await artRequest<ItemArtData>(secret, ""));
      setArtError(null);
    } catch (e) {
      setArtError(e instanceof Error ? e.message : "Couldn't load item art");
    }
  }, [local, ready, needsSecret, secret]);

  useEffect(() => {
    loadArt();
  }, [loadArt]);

  const rows = useMemo<ItemRowModel[]>(() => {
    const byId = new Map<string, ItemRowModel>();
    for (const a of art?.items ?? [])
      byId.set(a.id, { id: a.id, name: a.name, art: a });
    for (const db of dbItems) {
      const row = byId.get(db.id);
      if (row) row.db = db;
      else byId.set(db.id, { id: db.id, name: db.name, db });
    }
    return [...byId.values()];
  }, [art, dbItems]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter(
      (r) => r.name.toLowerCase().includes(q) || r.id.toLowerCase().includes(q),
    );
  }, [rows, query]);

  useEffect(() => {
    if (!selectedId && rows.length > 0) setSelectedId(rows[0].id);
  }, [rows, selectedId]);

  const select = (id: string) => {
    if (id === selectedId) return;
    if (dirty.current && !confirm("Discard unsaved changes to this item?"))
      return;
    dirty.current = false;
    setSelectedId(id);
  };

  const iconFor = (row: ItemRowModel): PixelArt | undefined =>
    art?.grids[row.id] ?? BUNDLED_ICONS[row.id];

  const selected = rows.find((r) => r.id === selectedId);

  return (
    <div className="grid gap-4 lg:grid-cols-[18rem_1fr] lg:gap-6">
      <div className="grid content-start gap-3 lg:sticky lg:top-4 lg:max-h-[calc(100dvh-6.5rem)] lg:grid-rows-[auto_1fr]">
        <div className="flex gap-2">
          <div className="relative flex-1">
            <Search className="absolute left-2.5 top-2.5 size-4 text-muted-foreground" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={`Search ${rows.length} items`}
              className="pl-8"
            />
          </div>
          <Button
            size="icon"
            variant="outline"
            title="New item"
            onClick={() => setCreating(true)}
          >
            <Plus />
          </Button>
        </div>
        <div className="min-h-0 overflow-y-auto rounded-lg border">
          {filtered.map((row) => {
            const icon = iconFor(row);
            return (
              <button
                key={row.id}
                type="button"
                onClick={() => select(row.id)}
                className={cn(
                  "flex w-full items-center gap-3 border-b px-3 py-2 text-left text-sm last:border-b-0 hover:bg-accent",
                  row.id === selectedId && "bg-accent",
                )}
              >
                {icon ? (
                  <PixelCanvas art={icon} gradient={row.art?.gradient} />
                ) : (
                  <span className="size-6 shrink-0 rounded bg-muted" />
                )}
                <span className="min-w-0 flex-1 truncate">{row.name}</span>
                {art?.cardArt[row.id] && (
                  <Badge variant="secondary" className="text-[10px]">
                    art
                  </Badge>
                )}
                {local && art && !row.db && (
                  <Badge variant="outline" className="text-[10px]">
                    no db
                  </Badge>
                )}
              </button>
            );
          })}
          {filtered.length === 0 && (
            <p className="p-4 text-sm text-muted-foreground">No items match.</p>
          )}
        </div>
      </div>

      <div className="min-w-0">
        {artError && (
          <p className="mb-4 text-xs text-destructive">{artError}</p>
        )}
        {selected ? (
          <ItemDetail
            key={selected.id}
            row={selected}
            art={art}
            setArt={setArt}
            local={local}
            secret={secret}
            onDbChange={load}
            onDirty={(d) => {
              dirty.current = d;
            }}
          />
        ) : (
          <p className="text-sm text-muted-foreground">
            {rows.length === 0 ? "Loading items..." : "Pick an item."}
          </p>
        )}
      </div>

      <NewItemDialog
        open={creating}
        onOpenChange={setCreating}
        secret={secret}
        onCreated={async (id) => {
          await load();
          setSelectedId(id);
        }}
      />
    </div>
  );
}

function NewItemDialog({
  open,
  onOpenChange,
  secret,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  secret: string;
  onCreated: (id: string) => void;
}) {
  const [form, setForm] = useState<ItemFormState>(() => newItemForm());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await adminFetch("/api/admin/items", secret, {
        method: "POST",
        body: JSON.stringify(itemFormToPayload(form)),
      });
      toast.success(`Created "${form.name}"`);
      onOpenChange(false);
      onCreated(form.id);
      setForm(newItemForm());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>New item</DialogTitle>
          <DialogDescription>
            Adds the item to the database. Its icon and card art are painted
            here once it's also in the shared catalog (items.ts).
          </DialogDescription>
        </DialogHeader>
        <ItemForm
          form={form}
          setForm={setForm}
          onSubmit={submit}
          onCancel={() => onOpenChange(false)}
          submitLabel="create item"
          disabled={busy}
        />
        {error && <p className="text-xs text-destructive">{error}</p>}
      </DialogContent>
    </Dialog>
  );
}
