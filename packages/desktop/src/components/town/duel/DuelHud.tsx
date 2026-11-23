import { CLASS_DEFS, isHerzieClass } from "@herzies/shared";
import { isTauri } from "@tauri-apps/api/core";
import { useEffect, useMemo, useState } from "react";
import { useEscape } from "../../../lib/escapeStack";
import { cn } from "../../../lib/utils";
import { herzies } from "../../../tauri-bridge";
import { BOSS_CARD, FoeHealth, observeBossCard } from "../BossHud";
import { leaveCombat } from "../combat/Combat";
import { reducedMotion, useCombat } from "../combat/state";
import { playEmote, useOwnedEmotes } from "../emotes";
import { TitleLine } from "../TitleLine";
import {
  answerInvite,
  askRematch,
  blockInviter,
  cancelChallenge,
  yieldDuel,
} from "./actions";
import { countdownBeat, duelClock, mmss } from "./clock";
import { duelFeel } from "./feel";
import {
  type DuelView,
  dismissResult,
  duel,
  localOf,
  myDuel,
  opponentIn,
  setDuelFriends,
  useDuel,
  type Who,
} from "./store";

/**
 * A duel's screen, over the Town: the challenge waiting on you (or on the
 * herzie you challenged), the countdown, your opponent's card (the boss's
 * card, top right: your own health is your player card's bar), the
 * warnings, and how it ended — with a rematch, or a GG. `me`: your own name
 * and title, for the VS card.
 */
export function DuelHud({
  me,
}: {
  me: { name: string; title?: string | null };
}) {
  useDuel();
  useFriendCodes();
  const mine = myDuel();
  const r = duel.result;
  const busy =
    !!mine || !!duel.invite || !!duel.outgoing || !!r || duel.outUntil !== null;
  const now = useNow(busy);
  const opp = mine ? opponentIn(mine, duel.you) : null;
  const them = mine ? (duel.foe ?? undefined) : undefined;
  return (
    <>
      {mine ? <HurtEdge /> : null}
      {mine && duel.outUntil !== null ? (
        <OutOfBounds until={localOf(duel.outUntil)} now={now} />
      ) : null}
      {mine && opp !== null ? (
        <FoeCard duel={mine} opp={opp} them={them} now={now} />
      ) : null}
      <div className="pointer-events-none absolute top-[calc(var(--hud-top,0px)+0.75rem)] left-1/2 z-30 flex -translate-x-1/2 flex-col items-center gap-2">
        {mine && opp !== null && mine.away.has(opp) ? (
          <div
            role="status"
            className="rounded bg-black/60 px-2.5 py-1 text-ui text-white backdrop-blur-md"
          >
            "{them?.name ?? "They"}" lost connection…{" "}
            <span className="tabular-nums text-white/70">
              {Math.max(
                0,
                Math.ceil((localOf(mine.away.get(opp) ?? 0) - now) / 1000),
              )}
            </span>
          </div>
        ) : null}
        {duel.invite ? <InviteCard now={now} /> : null}
        {duel.outgoing ? <WaitingPill now={now} /> : null}
      </div>
      {mine ? <Countdown duel={mine} me={me} them={them} now={now} /> : null}
      {mine ? <SuddenDeath duel={mine} now={now} /> : null}
      {r && r.why !== "cancelled" ? <ResultBanner now={now} /> : null}
      {r && r.why !== "cancelled" && now - r.at >= PANEL_AT_MS ? (
        <EndPanel now={now} />
      ) : null}
    </>
  );
}

/** When the banner comes in after the end, how long it's up, and when the
 * end panel follows (ms). */
const BANNER_AT_MS = 600;
const BANNER_MS = 2_600;
const PANEL_AT_MS = 2_800;
/** The end panel goes on its own this long after the rematch window. */
const PANEL_LINGER_MS = 4_000;

/** performance.now(), a few times a second while `on`. */
function useNow(on: boolean): number {
  const [now, setNow] = useState(() => performance.now());
  useEffect(() => {
    if (!on) return;
    setNow(performance.now());
    const t = setInterval(() => setNow(performance.now()), 50);
    return () => clearInterval(t);
  }, [on]);
  return on ? now : performance.now();
}

/** Your friends' codes, from the app's state, for "Friends only". */
function useFriendCodes() {
  useEffect(() => {
    if (!isTauri()) return;
    let live = true;
    herzies
      .getState()
      .then((s) => {
        if (live) setDuelFriends(s.herzie?.friendCodes ?? []);
      })
      .catch(() => {});
    const off = herzies.onStateUpdate((s) =>
      setDuelFriends(s.herzie?.friendCodes ?? []),
    );
    return () => {
      live = false;
      off();
    };
  }, []);
}

/** A bar emptying over what's left of `ms`, out of `total`. */
function Drain({
  left,
  total,
  className,
}: {
  left: number;
  total: number;
  className?: string;
}) {
  return (
    <div className="h-[3px] w-full overflow-hidden rounded-full bg-white/10">
      <div
        className={cn("h-full origin-left", className)}
        style={{
          transform: `scaleX(${Math.max(0, Math.min(1, left / total))})`,
        }}
      />
    </div>
  );
}

const CARD =
  "pointer-events-auto rounded-xl border border-white/12 bg-black/55 text-ui text-white shadow-lg backdrop-blur-md motion-safe:animate-[duel-card-in_200ms_ease-out]";

/** Someone challenges you: who, how strong, accept or not. */
function InviteCard({ now }: { now: number }) {
  const invite = duel.invite;
  const aiming = useCombat();
  // Esc turns it down (not in aim mode, where Esc leaves aim mode).
  useEscape(() => answerInvite(false), !!invite && !aiming);
  if (!invite) return null;
  const { who } = invite;
  const cls =
    invite.cls && isHerzieClass(invite.cls)
      ? CLASS_DEFS[invite.cls].name
      : null;
  const about = [
    invite.lv !== undefined ? `Lv ${invite.lv}` : null,
    cls,
  ].filter(Boolean);
  return (
    <div
      role="alertdialog"
      aria-label="Duel challenge"
      className={cn(CARD, "w-[300px] px-3 pt-2.5 pb-2")}
    >
      <div className="leading-4">
        <span className="font-bold">"{who.name}"</span>
        {about.length ? (
          <span className="text-white/70"> ({about.join(" ")})</span>
        ) : null}{" "}
        challenges you to a duel
      </div>
      <TitleLine id={who.title} className="mt-0.5 text-ui-sm" />
      <div className="mt-2 flex gap-2">
        <button
          type="button"
          className="btn flex-1 border-green text-green"
          onClick={() => answerInvite(true)}
        >
          Accept
        </button>
        <button
          type="button"
          className="btn flex-1"
          onClick={() => answerInvite(false)}
        >
          Decline
        </button>
      </div>
      <div className="mt-2">
        <Drain
          left={invite.until - now}
          total={invite.ttl}
          className="bg-yellow"
        />
      </div>
      <button
        type="button"
        className="mt-1.5 cursor-pointer border-0 bg-transparent p-0 text-ui-sm text-text-dim hover:text-white hover:underline"
        onClick={blockInviter}
      >
        Block duels from "{who.name}"
      </button>
    </div>
  );
}

/** Your challenge, waiting on their answer. */
function WaitingPill({ now }: { now: number }) {
  const out = duel.outgoing;
  if (!out) return null;
  return (
    <div role="status" className={cn(CARD, "w-[240px] px-3 py-1.5")}>
      <div className="flex items-center justify-between gap-2">
        <span className="truncate">Waiting for "{out.who.name}"…</span>
        <button
          type="button"
          className="shrink-0 cursor-pointer border-0 bg-transparent p-0 text-ui-sm text-text-dim hover:text-white hover:underline"
          onClick={cancelChallenge}
        >
          Cancel
        </button>
      </div>
      <div className="mt-1.5">
        <Drain left={out.until - now} total={out.ttl} className="bg-cyan" />
      </div>
    </div>
  );
}

/** Your opponent's card, where a boss's goes (top right): its name and
 * title, its health on the boss's bar, the clock beside the numbers, and
 * a way to yield. */
function FoeCard({
  duel: d,
  opp,
  them,
  now,
}: {
  duel: DuelView;
  opp: number;
  them: Who | undefined;
  now: number;
}) {
  const [yielding, setYielding] = useState(false);
  const name = them?.name ?? "Opponent";
  const h = d.health.get(opp);
  const startsAt = localOf(d.startsAt);
  const clock = duelClock(
    { startsAt, suddenAt: localOf(d.suddenAt), endsAt: localOf(d.endsAt) },
    now,
  );
  const time =
    now < startsAt ? (
      "Get ready"
    ) : (
      <span
        className={cn(
          clock.sudden && "font-medium text-[#ffae3a]",
          clock.shown &&
            clock.ms <= 10_000 &&
            "text-white motion-safe:animate-[duel-pulse_1s_ease-in-out_infinite]",
        )}
      >
        {clock.sudden ? `Sudden death ${mmss(clock.ms)}` : mmss(clock.ms)}
      </span>
    );
  return (
    <section
      ref={observeBossCard}
      className={BOSS_CARD}
      aria-label={`Duel with "${name}"`}
    >
      <div className="flex h-5 items-center">
        <span className="block min-w-0 truncate text-ui-lg font-bold">
          {name}
        </span>
      </div>
      <TitleLine
        id={them?.title}
        className="-mt-0.5 mb-0.5 text-[10px] font-medium leading-3"
      />
      <FoeHealth
        label={name}
        hp={h?.hp ?? 1}
        maxHp={h?.maxHp ?? 1}
        right={time}
      />
      <div className="pointer-events-auto mt-1 text-[10px] leading-3 text-white/60">
        {yielding ? (
          <>
            Yield the duel?{" "}
            <button
              type="button"
              className="cursor-pointer border-0 bg-transparent p-0 text-red hover:underline"
              onClick={() => {
                setYielding(false);
                yieldDuel();
              }}
            >
              Yield
            </button>
            {" · "}
            <button
              type="button"
              className="cursor-pointer border-0 bg-transparent p-0 text-white/80 hover:underline"
              onClick={() => setYielding(false)}
            >
              Keep fighting
            </button>
          </>
        ) : (
          <button
            type="button"
            className="cursor-pointer border-0 bg-transparent p-0 text-white/50 hover:text-white hover:underline"
            onClick={() => setYielding(true)}
          >
            Yield
          </button>
        )}
      </div>
    </section>
  );
}

/** A red edge when a hit lands on you. */
function HurtEdge() {
  const at = duelFeel.hurtAt;
  if (performance.now() - at > 300) return null;
  return (
    <div
      key={at}
      aria-hidden
      className="pointer-events-none absolute inset-0 z-20 animate-[hurt_0.3s_ease-out_forwards]"
      style={{ boxShadow: "inset 0 0 80px 18px rgba(220,38,38,0.5)" }}
    />
  );
}

/** Outside the ring: back in, or you've yielded. */
function OutOfBounds({ until, now }: { until: number; now: number }) {
  const left = Math.max(0, Math.ceil((until - now) / 1000));
  return (
    <>
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 z-20"
        style={{ boxShadow: "inset 0 0 120px 30px rgba(220,38,38,0.3)" }}
      />
      <div
        role="alert"
        className="pointer-events-none absolute inset-x-0 top-[30%] z-30 flex flex-col items-center text-center [text-shadow:0_2px_0_#000,0_0_14px_rgba(0,0,0,0.85)]"
      >
        <div className="text-2xl font-black text-white">Back to the ring!</div>
        <div
          key={left}
          className="text-5xl font-black text-red-300 tabular-nums motion-safe:animate-[duel-count_1s_ease-out_forwards]"
        >
          {left}
        </div>
      </div>
    </>
  );
}

/** The VS card, then 3 · 2 · 1, then FIGHT!, on the room's clock. */
function Countdown({
  duel: d,
  me,
  them,
  now,
}: {
  duel: DuelView;
  me: { name: string; title?: string | null };
  them: Who | undefined;
  now: number;
}) {
  const startsAt = localOf(d.startsAt);
  const { beat, since } = countdownBeat(localOf(d.at), startsAt, d.intro, now);
  if (beat === "fight" && since > FIGHT_MS) return null;
  return (
    <div
      aria-live="assertive"
      className="pointer-events-none absolute inset-x-0 top-[24%] z-30 flex flex-col items-center text-center [text-shadow:0_2px_0_#000,0_0_18px_rgba(0,0,0,0.85)]"
    >
      {beat === "vs" ? (
        <div className="flex items-center gap-5">
          <div className="flex flex-col items-end motion-safe:animate-[duel-vs-left_250ms_ease-out]">
            <div className="text-2xl font-black text-white">{me.name}</div>
            <TitleLine id={me.title} className="text-ui" />
          </div>
          <div className="text-3xl font-black text-[#ffd84a]">VS</div>
          <div className="flex flex-col items-start motion-safe:animate-[duel-vs-right_250ms_ease-out]">
            <div className="text-2xl font-black text-white">
              {them?.name ?? "Opponent"}
            </div>
            <TitleLine id={them?.title} className="text-ui" />
          </div>
        </div>
      ) : beat === "fight" ? (
        <div className="text-5xl font-black tracking-wide text-[#ffd84a] animate-[duel-fight_600ms_ease-out_forwards]">
          FIGHT!
        </div>
      ) : (
        <div
          key={beat}
          className="text-6xl font-black text-white tabular-nums animate-[duel-count_800ms_ease-out_forwards]"
        >
          {beat}
        </div>
      )}
    </div>
  );
}

/** How long FIGHT! is up (ms). */
const FIGHT_MS = 600;
/** How long SUDDEN DEATH is up (ms). */
const SUDDEN_MS = 1_400;

/** The banner as sudden death begins. */
function SuddenDeath({ duel: d, now }: { duel: DuelView; now: number }) {
  const since = now - localOf(d.suddenAt);
  if (since < 0 || since > SUDDEN_MS) return null;
  return (
    <div
      aria-live="assertive"
      className="pointer-events-none absolute inset-x-0 top-[24%] z-30 flex flex-col items-center text-center [text-shadow:0_2px_0_#000,0_0_18px_rgba(0,0,0,0.85)]"
    >
      <div className="text-4xl font-black tracking-wide text-[#ffae3a] animate-[duel-fight_1400ms_ease-out_forwards]">
        SUDDEN DEATH
      </div>
      <div className="mt-1 text-ui font-medium text-white/90">
        Hits land harder, healing weakens
      </div>
    </div>
  );
}

/** Why it ended, in a few words, as the winner and the loser see it. */
function reason(why: string, won: boolean | null): string | null {
  switch (why) {
    case "yield":
      return won ? "They yielded" : "You yielded";
    case "bounds":
      return won ? "They left the ring" : "Out of the ring too long";
    case "left":
      return won ? "They left" : "You left";
    case "time":
      return "Time! Most health left wins";
    default:
      return null;
  }
}

/** VICTORY, DEFEAT or DRAW, a beat after the end. */
function ResultBanner({ now }: { now: number }) {
  const r = duel.result;
  const confetti = useMemo(
    () =>
      Array.from({ length: 12 }, (_, i) => {
        const a = (i / 12) * Math.PI * 2 + Math.random() * 0.4;
        const d = 70 + Math.random() * 60;
        return {
          dx: `${Math.cos(a) * d}px`,
          dy: `${Math.sin(a) * d * 0.6 + 30}px`,
          r: `${Math.round(Math.random() * 540 - 270)}deg`,
          color: ["#ffd84a", "#7dff8a", "#9fe8ff", "#ff8ad8"][i % 4],
        };
      }),
    [],
  );
  if (!r) return null;
  const since = now - r.at - BANNER_AT_MS;
  if (since < 0 || since > BANNER_MS) return null;
  const word = r.won === true ? "VICTORY" : r.won === false ? "DEFEAT" : "DRAW";
  const why = reason(r.why, r.won);
  return (
    <div
      aria-live="assertive"
      className="pointer-events-none absolute inset-x-0 top-[22%] z-30 flex flex-col items-center text-center"
      style={{
        animation: `${r.won && !reducedMotion() ? "duel-banner-pop" : "duel-banner-fade"} ${BANNER_MS}ms ease-out forwards`,
      }}
    >
      <div className="relative">
        {r.won
          ? confetti.map((c, i) => (
              <span
                // biome-ignore lint/suspicious/noArrayIndexKey: a fixed burst
                key={i}
                className="duel-confetti absolute top-1/2 left-1/2 h-2 w-1 rounded-[1px] animate-[duel-confetti_1100ms_ease-out_forwards]"
                style={
                  {
                    background: c.color,
                    "--dx": c.dx,
                    "--dy": c.dy,
                    "--r": c.r,
                  } as React.CSSProperties
                }
              />
            ))
          : null}
        <div
          className={cn(
            "text-6xl font-black tracking-wider [text-shadow:0_3px_0_#000,0_0_22px_rgba(0,0,0,0.85)]",
            r.won === true
              ? "text-[#ffd84a]"
              : r.won === false
                ? "text-[#8fb4e8]"
                : "text-white/75",
          )}
        >
          {word}
        </div>
      </div>
      <div className="mt-1 text-ui-lg font-medium text-white/90 [text-shadow:0_1px_2px_#000,0_0_8px_#000]">
        vs "{r.who.name}" · {mmss(r.ms)} · {r.hits}{" "}
        {r.hits === 1 ? "hit" : "hits"}
      </div>
      {why ? (
        <div className="text-ui text-white/70 [text-shadow:0_1px_2px_#000]">
          {why}
        </div>
      ) : null}
    </div>
  );
}

/** After the banner: a rematch (both have to ask), or GG. */
function EndPanel({ now }: { now: number }) {
  const r = duel.result;
  const owned = useOwnedEmotes();
  // The fight's over: the mouse is yours again, to click.
  useEffect(() => {
    leaveCombat();
  }, []);
  const until = r?.rematchUntil === null || !r ? null : localOf(r.rematchUntil);
  // Gone once the rematch window's long past (or there never was one).
  const closesAt = r
    ? (until ?? r.at + PANEL_AT_MS) + PANEL_LINGER_MS
    : Number.POSITIVE_INFINITY;
  useEffect(() => {
    if (!Number.isFinite(closesAt)) return;
    const t = setTimeout(
      dismissResult,
      Math.max(0, closesAt - performance.now()),
    );
    return () => clearTimeout(t);
  }, [closesAt]);
  if (!r) return null;
  const canRematch = until !== null && now < until && r.why !== "left";
  const gg = () => {
    const emote =
      owned.find((e) => e === "cheer") ?? owned.find((e) => e === "wave");
    if (emote) playEmote(emote);
    dismissResult();
  };
  return (
    <div className="pointer-events-none absolute inset-x-0 top-[36%] z-30 flex justify-center">
      <div
        className={cn(
          CARD,
          "flex w-[260px] flex-col items-center gap-2 px-3 py-2.5",
        )}
      >
        {r.rematchBy && !r.rematchAsked && canRematch ? (
          <div className="text-ui font-medium text-[#ffd84a] motion-safe:animate-[duel-pulse_1s_ease-in-out_infinite]">
            "{r.who.name}" wants a rematch
          </div>
        ) : null}
        <div className="flex w-full gap-2">
          {canRematch ? (
            <button
              type="button"
              className="btn flex-1 border-yellow text-yellow disabled:opacity-60"
              disabled={r.rematchAsked}
              onClick={askRematch}
            >
              {r.rematchAsked ? "Asked…" : "Rematch"}
            </button>
          ) : null}
          <button type="button" className="btn flex-1" onClick={gg}>
            GG
          </button>
        </div>
        {canRematch && until !== null ? (
          <Drain
            left={until - now}
            total={Math.max(1, until - r.at)}
            className="bg-yellow"
          />
        ) : null}
      </div>
    </div>
  );
}
