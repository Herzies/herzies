import {
  type EarnedTitle,
  getTitle,
  RARITY_COLORS,
  RARITY_LABELS,
  TITLE_CATEGORY_LABELS,
  TITLES,
  type TitleCategory,
  type TitleDef,
  type TitleId,
  type TitlesState,
  titleProgress,
  titleProgressLabel,
} from "@herzies/shared";
import { useMemo, useState } from "react";
import { notify } from "../lib/notices";
import {
  earnedOn,
  heldByLabel,
  isGrandRarity,
  shownRungs,
  titleFamilies,
} from "../lib/titles";
import { cn } from "../lib/utils";
import { herzies } from "../tauri-bridge";
import { List } from "./List";
import { TitleLabel } from "./TitleLabel";

/** The outline the Town's name tags have (see Notices): white text that
 * reads over any sky. */
const TAG_OUTLINE =
  "0 1px 0 #000, 0 -1px 0 #000, 1px 0 0 #000, -1px 0 0 #000, 0 2px 4px rgba(0,0,0,0.6)";

type Show = "all" | "earned";

const CATEGORIES = Object.keys(TITLE_CATEGORY_LABELS) as TitleCategory[];

/** Families by category, worked out once: the catalog doesn't change. */
const FAMILIES = titleFamilies();

/** A wear refused, in the player's words. */
function wearRefusal(reason: string): string {
  if (reason === "not-earned") return "You haven't earned that title yet";
  if (reason === "unknown") return "That title doesn't exist any more";
  return `Couldn't change your title: ${reason}`;
}

/**
 * The Titles tab: what's worn (as the Town shows it, under your name), and
 * every title, earned or not. Ladders fold to the highest rung earned and
 * the next one to go for. One worn at a time, or none.
 */
export function TitlesTab({
  name,
  worn,
  board,
  failed,
  onRetry,
  onLog,
}: {
  /** The herzie's name, for the preview. */
  name: string;
  /** The title worn, as the app last heard. */
  worn: string | null;
  board: TitlesState | null;
  /** The last fetch failed (and nothing's loaded). */
  failed: boolean;
  onRetry: () => void;
  onLog?: (msg: string) => void;
}) {
  const [show, setShow] = useState<Show>("all");
  const [category, setCategory] = useState<TitleCategory | null>(null);
  /** Ladders unfolded, by family key. */
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  /** The title being put on, shown worn until the server's said (undefined:
   * nothing on its way). */
  const [wearing, setWearing] = useState<string | null | undefined>(undefined);
  const shownWorn = wearing !== undefined ? wearing : worn;

  const earned = useMemo(
    () => new Map<string, EarnedTitle>(board?.earned.map((t) => [t.id, t])),
    [board],
  );
  const earnedIds = useMemo(() => new Set(earned.keys()), [earned]);
  const known = board?.earned.filter((t) => getTitle(t.id)).length ?? 0;

  const wear = (id: string | null) => {
    if (wearing !== undefined || id === shownWorn) return;
    setWearing(id);
    herzies.wearTitle(id).then(
      ({ worn: now }) => {
        setWearing(undefined);
        const def = getTitle(now);
        onLog?.(def ? `Now wearing "${def.name}"` : "Took your title off");
      },
      (e: unknown) => {
        setWearing(undefined);
        notify(wearRefusal(e instanceof Error ? e.message : String(e)));
      },
    );
  };

  const families = FAMILIES.filter(
    (f) => category === null || f.rungs[0].category === category,
  );
  /** The rows shown, each ladder's last one carrying its fold (rungs left
   * out while folded, or null when there's nothing to fold). */
  const rows: {
    family: string;
    def: TitleDef;
    fold: { open: boolean; hidden: number } | null;
  }[] = [];
  for (const family of families) {
    const unfolded = open.has(family.key);
    const rungs =
      show === "earned"
        ? family.rungs.filter((r) => earnedIds.has(r.id))
        : shownRungs(family, earnedIds, unfolded);
    const foldable = show === "all" && family.rungs.length > 2;
    rungs.forEach((def, i) => {
      rows.push({
        family: family.key,
        def,
        fold:
          foldable && i === rungs.length - 1
            ? { open: unfolded, hidden: family.rungs.length - rungs.length }
            : null,
      });
    });
  }

  const toggle = (key: string) =>
    setOpen((s) => {
      const next = new Set(s);
      if (!next.delete(key)) next.add(key);
      return next;
    });

  return (
    <div className="flex min-h-0 flex-1 cursor-default flex-col gap-1.5 text-ui">
      {/* As the Town shows it: your name, the title under it. */}
      <div className="relative flex h-12 shrink-0 flex-col items-center justify-center overflow-hidden rounded border border-white/10 bg-[linear-gradient(180deg,rgba(80,120,190,0.35),rgba(20,30,60,0.35))]">
        <span
          className="text-ui-lg leading-tight font-bold text-white"
          style={{ textShadow: TAG_OUTLINE }}
        >
          {name}
        </span>
        {shownWorn ? (
          <TitleLabel
            key={shownWorn}
            id={shownWorn}
            className="title-pop text-ui-sm leading-tight font-bold"
          />
        ) : (
          <span className="text-ui-sm leading-tight text-white/45">
            No title
          </span>
        )}
        <span className="absolute top-1 right-1.5 text-ui-sm text-text-dim">
          {board ? `${known} / ${TITLES.length} earned` : ""}
        </span>
      </div>

      {/* All or only earned, then a category (again, and it's off). */}
      <div className="flex shrink-0 flex-wrap items-center gap-1">
        <div className="flex overflow-hidden rounded-full border border-white/15">
          {(["all", "earned"] as const).map((s) => (
            <button
              key={s}
              type="button"
              aria-pressed={show === s}
              onClick={() => setShow(s)}
              className={cn(
                "cursor-pointer border-none px-1.5 py-px text-[10px] leading-tight transition-colors",
                show === s
                  ? "bg-cyan/20 font-bold text-cyan"
                  : "bg-transparent text-text-dim hover:text-text",
              )}
            >
              {s === "all" ? "All" : "Earned"}
            </button>
          ))}
        </div>
        {CATEGORIES.map((c) => (
          <Chip
            key={c}
            on={category === c}
            onClick={() => setCategory(category === c ? null : c)}
          >
            {TITLE_CATEGORY_LABELS[c]}
          </Chip>
        ))}
      </div>

      {/* Room for about five titles where the window grows to fit it;
          shrinks (and scrolls) where it can't. */}
      <div className="flex min-h-0 flex-col" style={{ flex: "1 1 15rem" }}>
        <List className="-mx-1 h-full px-1">
          <NoTitleRow worn={shownWorn === null} onWear={() => wear(null)} />
          {!board ? (
            <div className="py-4 text-center text-text-dim">
              {failed ? (
                <>
                  Couldn't load titles.{" "}
                  <button
                    type="button"
                    onClick={onRetry}
                    className="cursor-pointer border-none bg-transparent p-0 text-cyan hover:underline"
                  >
                    Try again
                  </button>
                </>
              ) : (
                "Loading…"
              )}
            </div>
          ) : rows.length === 0 ? (
            <div className="px-2 py-4 text-center text-ui-sm leading-relaxed text-text-dim">
              {show === "earned" && category === null
                ? "No titles yet. They show under your name in Town: earn one by listening, climbing the Tower, or winning duels."
                : "None here yet."}
            </div>
          ) : (
            rows.map(({ family, def, fold }) => (
              <div key={def.id}>
                <TitleRow
                  def={def}
                  earned={earned.get(def.id)}
                  board={board}
                  worn={shownWorn === def.id}
                  busy={wearing !== undefined}
                  onWear={() => wear(def.id)}
                />
                {fold && (
                  <FoldButton {...fold} onClick={() => toggle(family)} />
                )}
              </div>
            ))
          )}
        </List>
      </div>
    </div>
  );
}

function Chip({
  on,
  onClick,
  children,
}: {
  on: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={on}
      className={cn(
        "cursor-pointer rounded-full border px-1.5 py-px text-[10px] leading-tight transition-colors",
        on
          ? "border-cyan/70 bg-cyan/15 text-cyan"
          : "border-white/15 bg-transparent text-text-dim hover:border-white/40 hover:text-text",
      )}
    >
      {children}
    </button>
  );
}

/** "No title": always first, so taking a title off is one click. */
function NoTitleRow({ worn, onWear }: { worn: boolean; onWear: () => void }) {
  return (
    <div className="flex items-center gap-2 border-b border-white/10 py-1 pr-0.5 pl-2.5">
      <span className="flex-1 text-text-dim italic">No title</span>
      <WearButton worn={worn} onWear={onWear} />
    </div>
  );
}

function WearButton({
  worn,
  busy = false,
  onWear,
}: {
  worn: boolean;
  busy?: boolean;
  onWear: () => void;
}) {
  return worn ? (
    <span className="flex h-[18px] w-12 items-center justify-center text-ui-sm font-bold text-cyan">
      Worn
    </span>
  ) : (
    <button
      type="button"
      disabled={busy}
      onClick={onWear}
      className="btn h-[18px] w-12 px-0 text-ui-sm"
    >
      Wear
    </button>
  );
}

function FoldButton({
  open,
  hidden,
  onClick,
}: {
  open: boolean;
  hidden: number;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-expanded={open}
      onClick={onClick}
      className="flex w-full cursor-pointer items-center gap-1 border-none bg-transparent py-0.5 pl-2.5 text-left text-ui-sm text-text-dim hover:text-cyan"
    >
      {open ? "▾ Fold this ladder" : `▸ ${hidden} more on this ladder`}
    </button>
  );
}

function TitleRow({
  def,
  earned,
  board,
  worn,
  busy,
  onWear,
}: {
  def: TitleDef;
  earned: EarnedTitle | undefined;
  board: TitlesState;
  worn: boolean;
  busy: boolean;
  onWear: () => void;
}) {
  const colour = RARITY_COLORS[def.rarity];
  const progress = earned ? null : titleProgress(def, board.metrics);
  const progressLabel = earned ? null : titleProgressLabel(def, board.metrics);
  // Catalog ids are TitleIds; TitleDef types them as plain strings.
  const holders = board.holders[def.id as TitleId] ?? 0;
  return (
    <div
      className={cn(
        "relative flex items-center gap-2 border-b border-white/10 py-1 pr-0.5 pl-2.5",
        worn && "bg-cyan/5",
      )}
    >
      {/* The rarity, down the left edge: full for earned, faint for not. */}
      <span
        aria-hidden="true"
        className="absolute top-1 bottom-1 left-0 w-[3px] rounded-sm"
        style={{ background: colour, opacity: earned ? 1 : 0.35 }}
      />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          {earned ? (
            <TitleLabel id={def.id} className="truncate font-bold" />
          ) : (
            <span
              className="truncate font-bold opacity-55"
              style={{ color: colour }}
            >
              {def.name}
            </span>
          )}
          {earned && earned.count > 1 && (
            <span className="shrink-0 text-ui-sm text-text-dim">
              ×{earned.count}
            </span>
          )}
          {earned?.fresh && (
            <span className="title-new shrink-0 rounded-sm bg-yellow px-1 text-[8px] leading-[11px] font-bold text-bg">
              NEW
            </span>
          )}
          <span
            className={cn(
              "ml-auto shrink-0 text-ui-sm",
              isGrandRarity(def.rarity) && "font-bold",
            )}
            style={{ color: colour }}
          >
            {RARITY_LABELS[def.rarity]}
          </span>
        </div>
        <div className="truncate text-ui-sm text-text-dim">
          {def.description}
        </div>
        {earned ? (
          <div className="text-ui-sm text-text-dim/80">
            Earned {earnedOn(earned.earnedAt)} · {heldByLabel(holders)}
          </div>
        ) : def.retired ? (
          <div className="text-ui-sm text-text-dim/80 italic">
            No longer obtainable · {heldByLabel(holders)}
          </div>
        ) : progress !== null ? (
          <div className="mt-0.5 flex items-center gap-1.5">
            <div className="h-1 min-w-0 flex-1 overflow-hidden rounded-full bg-white/10">
              <div
                className="h-full rounded-full"
                style={{
                  width: `${progress * 100}%`,
                  background: colour,
                  opacity: 0.8,
                }}
              />
            </div>
            <span className="shrink-0 text-ui-sm text-text-dim tabular-nums">
              {progressLabel}
            </span>
          </div>
        ) : (
          <div className="text-ui-sm text-text-dim/80">
            {heldByLabel(holders)}
          </div>
        )}
      </div>
      {earned ? (
        <WearButton worn={worn} busy={busy} onWear={onWear} />
      ) : (
        <span className="w-12 shrink-0" />
      )}
    </div>
  );
}
