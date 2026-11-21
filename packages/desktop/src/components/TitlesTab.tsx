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
} from "@herzies/shared";
import { useMemo, useState } from "react";
import { notify } from "../lib/notices";
import { earnedOn, heldByLabel, isGrandRarity } from "../lib/titles";
import { cn } from "../lib/utils";
import { herzies } from "../tauri-bridge";
import { List } from "./List";
import { TitleLabel } from "./TitleLabel";

/** The outline the Town's name tags have (see Notices): white text that
 * reads over any sky. */
const TAG_OUTLINE =
  "0 1px 0 #000, 0 -1px 0 #000, 1px 0 0 #000, -1px 0 0 #000, 0 2px 4px rgba(0,0,0,0.6)";

const CATEGORIES = Object.keys(TITLE_CATEGORY_LABELS) as TitleCategory[];

/** A wear refused, in the player's words. */
function wearRefusal(reason: string): string {
  if (reason === "not-earned") return "You haven't earned that title yet";
  if (reason === "unknown") return "That title doesn't exist any more";
  return `Couldn't change your title: ${reason}`;
}

/**
 * The Titles tab: what's worn (as the Town shows it, over your name), and
 * the titles earned, each with its rarity. Titles not yet earned aren't
 * listed: they're found by earning them. One worn at a time, or none.
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
  const [category, setCategory] = useState<TitleCategory | null>(null);
  /** The title being put on, shown worn until the server's said (undefined:
   * nothing on its way). */
  const [wearing, setWearing] = useState<string | null | undefined>(undefined);
  const shownWorn = wearing !== undefined ? wearing : worn;

  const earned = useMemo(
    () => new Map<string, EarnedTitle>(board?.earned.map((t) => [t.id, t])),
    [board],
  );
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

  /** The titles earned, in catalog order (titles this app doesn't know
   * yet are left out); unearned ones aren't shown at all. */
  const rows = TITLES.flatMap((def) => {
    const e = earned.get(def.id);
    return e && (category === null || def.category === category)
      ? [{ def, earned: e }]
      : [];
  });

  return (
    <div className="flex min-h-0 flex-1 cursor-default flex-col gap-1.5 text-ui">
      {/* As the Town shows it: the title (grey, as every worn title is),
          your name under it. */}
      <div className="relative flex h-12 shrink-0 flex-col items-center justify-center overflow-hidden rounded border border-white/10 bg-[linear-gradient(180deg,rgba(80,120,190,0.35),rgba(20,30,60,0.35))]">
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
        <span
          className="text-ui-lg leading-tight font-bold text-white"
          style={{ textShadow: TAG_OUTLINE }}
        >
          {name}
        </span>
        <span className="absolute top-1 right-1.5 text-ui-sm text-text-dim">
          {board ? `${known} earned` : ""}
        </span>
      </div>

      {/* A category (again, and it's off). */}
      <div className="flex shrink-0 flex-wrap items-center gap-1">
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
              {category === null
                ? "No titles yet. They show over your name in Town: earn one by listening, climbing the Tower, or winning duels."
                : "None here yet."}
            </div>
          ) : (
            rows.map(({ def, earned: e }) => (
              <TitleRow
                key={def.id}
                def={def}
                earned={e}
                board={board}
                worn={shownWorn === def.id}
                busy={wearing !== undefined}
                onWear={() => wear(def.id)}
              />
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

function TitleRow({
  def,
  earned,
  board,
  worn,
  busy,
  onWear,
}: {
  def: TitleDef;
  earned: EarnedTitle;
  board: TitlesState;
  worn: boolean;
  busy: boolean;
  onWear: () => void;
}) {
  const colour = RARITY_COLORS[def.rarity];
  // Catalog ids are TitleIds; TitleDef types them as plain strings.
  const holders = board.holders[def.id as TitleId] ?? 0;
  return (
    <div
      className={cn(
        "relative flex items-center gap-2 border-b border-white/10 py-1 pr-0.5 pl-2.5",
        worn && "bg-cyan/5",
      )}
    >
      {/* The rarity, down the left edge. */}
      <span
        aria-hidden="true"
        className="absolute top-1 bottom-1 left-0 w-[3px] rounded-sm"
        style={{ background: colour }}
      />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="truncate font-bold text-white">{def.name}</span>
          {earned.count > 1 && (
            <span className="shrink-0 text-ui-sm text-text-dim">
              ×{earned.count}
            </span>
          )}
          {earned.fresh && (
            <span className="title-new shrink-0 rounded-sm bg-yellow px-1 text-[8px] leading-[11px] font-bold text-bg">
              NEW
            </span>
          )}
          {/* Its rarity, in its colour: the one place a title wears it
              (over a name, every title is grey). */}
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
        <div className="text-ui-sm text-text-dim/80">
          Earned {earnedOn(earned.earnedAt)} ·{" "}
          {heldByLabel(holders, board.herzies)}
          {def.retired && " · No longer obtainable"}
        </div>
      </div>
      <WearButton worn={worn} busy={busy} onWear={onWear} />
    </div>
  );
}
