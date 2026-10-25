import { type GameEvent, visitorName } from "@herzies/shared";
import { VisitorIcon } from "./icons/VisitorIcon";
import { List } from "./List";
import { VISITOR_THEMES } from "./VisitorRowTheme";

/** What kind of thing each event is, as the board's notes say it. */
const KIND: Record<string, string> = {
  song_hunt: "Song hunt",
  merchant: "Visiting merchant",
  treat_trader: "Treat trading",
  boss_fight: "Boss fight",
  tower: "The Tower",
  secret_track: "Secret track",
};

const PLAIN = {
  dim: "#9a9aa8",
  accent: "#e8e8f0",
};

function left(ms: number): string {
  const hours = Math.floor(ms / 3_600_000);
  const days = Math.floor(hours / 24);
  if (days > 0) return `${days}d ${hours % 24}h`;
  if (hours > 0) return `${hours}h`;
  return `${Math.max(1, Math.floor(ms / 60_000))}m`;
}

/** "Thu 20:00", in the reader's own time. */
function when(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** The screen an on-now note opens: the visitor's own (null: nothing to
 * open, e.g. the Tower, which is a portal). Same keys as the Town's cards. */
function openKeyOf(e: GameEvent): string | null {
  if (e.type === "song_hunt") return "song_hunt";
  if (
    e.type === "boss_fight" ||
    e.type === "merchant" ||
    e.type === "treat_trader"
  )
    return e.id;
  return null;
}

/**
 * The Town's bulletin board, up close: what's on now and what's coming in
 * the next seven days, one pinned note each, soonest first.
 */
export function BulletinPanel({
  week,
  onOpen,
}: {
  week: readonly GameEvent[];
  /** Opens an on-now visitor's screen. */
  onOpen: (key: string) => void;
}) {
  const now = Date.now();
  const ongoing = week.filter((e) => new Date(e.startsAt).getTime() <= now);
  const coming = week.filter((e) => new Date(e.startsAt).getTime() > now);
  return (
    <List className="min-h-0 flex-1" contentStyle={{ padding: "8px 12px" }}>
      <Section title="On now" empty="Nothing on right now.">
        {ongoing.map((e) => {
          const key = openKeyOf(e);
          return (
            <Note
              key={e.id}
              event={e}
              line={`ends in ${left(new Date(e.endsAt).getTime() - now)}`}
              onOpen={key ? () => onOpen(key) : undefined}
            />
          );
        })}
      </Section>
      <Section title="This week" empty="Nothing else pinned up this week.">
        {coming.map((e) => (
          <Note
            key={e.id}
            event={e}
            upcoming
            line={`${when(e.startsAt)} · in ${left(new Date(e.startsAt).getTime() - now)}`}
          />
        ))}
      </Section>
    </List>
  );
}

function Section({
  title,
  empty,
  children,
}: {
  title: string;
  empty: string;
  children: React.ReactNode[];
}) {
  return (
    <section className="mb-4">
      <h3 className="mb-1.5 text-[10px] tracking-wider text-text-dim uppercase">
        {title}
      </h3>
      {children.length === 0 ? (
        <div className="text-ui-sm text-text-dim">{empty}</div>
      ) : (
        <div className="flex flex-col gap-1.5">{children}</div>
      )}
    </section>
  );
}

function Note({
  event,
  line,
  upcoming = false,
  onOpen,
}: {
  event: GameEvent;
  line: string;
  /** Not here yet: plain text, no one drawn. */
  upcoming?: boolean;
  onOpen?: () => void;
}) {
  const theme = upcoming ? PLAIN : (VISITOR_THEMES[event.type] ?? PLAIN);
  const name = visitorName(event.type, event.title);
  const kind = KIND[event.type];
  const body = (
    <div className="flex items-center gap-2.5">
      {/* Nothing for the Tower or a secret track (no one to draw), nor for
          anyone not here yet. */}
      {upcoming ? null : (
        <VisitorIcon
          type={event.type}
          seed={event.id}
          inTown
          className="h-8 w-8 shrink-0"
        />
      )}
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline justify-between gap-2">
          <span className="truncate text-ui" style={{ color: theme.accent }}>
            {name}
          </span>
          <span
            className="shrink-0 text-ui-sm tabular-nums"
            style={{ color: theme.dim }}
          >
            {line}
          </span>
        </div>
        {kind && kind !== name ? (
          <div className="text-ui-sm" style={{ color: theme.dim }}>
            {kind}
          </div>
        ) : null}
      </div>
    </div>
  );
  if (!onOpen) {
    return <div className="rounded px-2.5 py-1.5">{body}</div>;
  }
  return (
    <button
      type="button"
      onClick={onOpen}
      className="cursor-pointer rounded border-none bg-transparent px-2.5 py-1.5 text-left transition-colors hover:bg-white/8"
    >
      {body}
    </button>
  );
}
