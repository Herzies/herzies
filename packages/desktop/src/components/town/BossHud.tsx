import { BOSS_PHASE_AT, IN_TUNE, MINION_THRESHOLDS } from "@herzies/shared";
import { useEffect, useState } from "react";
import { cn } from "../../lib/utils";
import { clock } from "./cave";
import {
  bossFight,
  mobsLeft,
  type RaidView,
  useBossFight,
  useBossHp,
} from "./combat/fight";
import { type Banner, useBanner } from "./combat/moments";
import { buffOn, useSkills } from "./combat/skills";

/** The boss's card: top right, clear of your own (top left), as wide as
 * the space beside it allows. */
const BOSS_CARD =
  "pointer-events-none absolute top-3 right-3 z-30 w-[min(15rem,calc(100%-174px-2.25rem))] rounded-xl border border-white/12 bg-black/45 px-2 pt-1 pb-2 text-white backdrop-blur-md";

/**
 * What the boss room shows over the world. The boss has a card of its own,
 * top right: its name, and in the lobby how long until it wakes; in the
 * fight its health (its phases and minion calls marked, a chip of what was
 * just lost), the phase, how many still stand, the taunt, the enrage; the
 * raid's big moments across the screen (RaidBanner); once it's over, what
 * happened and
 * how long until the room closes. A flash of red when you're hit. In the
 * Tower: the floor, at the top. (Your music's bonus sits under your own
 * now-playing box: MusicBonus. The door's and the room's little messages
 * are notices: lib/notices.ts.)
 */
export function BossHud({ name }: { name: string }) {
  useBossFight();
  useBossHp();
  const { on, hp, maxHp, closing, victory, youHitAt, tower } = bossFight;
  const [now, setNow] = useState(() => performance.now());
  // Ticks while something counts down: the room closing, the lobby or the
  // enrage, or a Tower floor's enrage.
  const raid = bossFight.raid;
  const counting = !!closing || (!!tower?.enrageAt && !tower.cleared) || !!raid;
  useEffect(() => {
    if (!counting) return;
    const t = setInterval(() => setNow(performance.now()), 500);
    return () => clearInterval(t);
  }, [counting]);

  const frac = maxHp > 0 ? Math.max(0, Math.min(1, hp / maxHp)) : 0;
  const closes = closing ? Math.max(0, closing.at - now) : 0;
  return (
    <>
      {on && tower ? (
        <div
          role="status"
          className="pointer-events-none absolute top-2 left-1/2 z-30 -translate-x-1/2 whitespace-nowrap rounded bg-black/35 px-2.5 py-1 text-center text-ui text-white backdrop-blur-md"
        >
          <span className="font-medium">Floor {tower.floor}</span>
          <span className="text-text-dim">
            {" · "}
            {tower.cleared ? "cleared" : `${mobsLeft()} left`}
          </span>
          <EnrageTag tower={tower} now={now} />
        </div>
      ) : on ? (
        <section className={BOSS_CARD} aria-label={name}>
          <div className="flex h-5 items-center">
            <span className="block min-w-0 truncate text-ui-lg font-bold">
              {name}
            </span>
          </div>
          {raid?.stage === "lobby" ? (
            <div className="text-[11px] text-white/80">
              Wakes in{" "}
              <span className="tabular-nums font-medium text-white">
                {clock(Math.max(0, raid.startsAt - now))}
              </span>
              <span className="text-white/60">
                {" · "}
                {raid.roster} {raid.roster === 1 ? "herzie" : "herzies"} here
              </span>
            </div>
          ) : (
            <>
              <div
                className="mt-0.5"
                role="progressbar"
                aria-label={`${name} health`}
                aria-valuemin={0}
                aria-valuemax={maxHp}
                aria-valuenow={Math.round(hp)}
              >
                <div className="relative h-2 overflow-hidden rounded-sm bg-black/60 ring-1 ring-white/25">
                  {/* The chip: what was just lost, in white, catching up
                      a moment later so each burst of damage reads. */}
                  <div
                    className="absolute inset-y-0 left-0 bg-white/70 transition-[width] duration-500 ease-out motion-reduce:transition-none"
                    style={{
                      width: `${frac * 100}%`,
                      transitionDelay: "350ms",
                    }}
                  />
                  <div
                    className="relative h-full bg-red-500 transition-[width] duration-100"
                    style={{ width: `${frac * 100}%` }}
                  />
                  {/* Where it changes gear (solid), and where it calls
                      its minions (dotted). */}
                  {BOSS_PHASE_AT.map((p) => (
                    <span
                      key={`p${p}`}
                      className="absolute top-0 h-full w-px bg-white/60"
                      style={{ left: `${p * 100}%` }}
                    />
                  ))}
                  {MINION_THRESHOLDS.map((p) => (
                    <span
                      key={`m${p}`}
                      className="absolute top-0 h-full w-px border-l border-dotted border-[#9be36b]/80"
                      style={{ left: `${p * 100}%` }}
                    />
                  ))}
                </div>
                <div className="mt-0.5 flex text-[10px] leading-3 tabular-nums text-white/60">
                  <span>
                    {Math.ceil(hp).toLocaleString()} / {maxHp.toLocaleString()}
                  </span>
                  <span className="ml-auto">Phase {bossFight.phase}</span>
                </div>
              </div>
              {closing ? (
                <div role="status" className="mt-1 text-[11px] leading-4">
                  <div className="font-medium">
                    {victory
                      ? "The boss has fallen!"
                      : closing.why === "wiped"
                        ? "Everyone's down. The boss won."
                        : "The boss is slipping away…"}
                  </div>
                  <div className="tabular-nums text-white/60">
                    Back to town in {clock(closes)}
                  </div>
                </div>
              ) : raid ? (
                <RaidLine raid={raid} now={now} />
              ) : null}
            </>
          )}
        </section>
      ) : null}
      {closing && tower ? (
        <div
          role="status"
          className="pointer-events-none absolute top-12 left-1/2 z-30 -translate-x-1/2 rounded bg-black/70 px-3 py-1.5 text-center text-ui text-white"
        >
          The Tower is closing…{" "}
          <span className="text-white/60 tabular-nums">
            Back to town in {clock(closes)}
          </span>
        </div>
      ) : null}
      {on && !tower ? <RaidBanner /> : null}
      {on && performance.now() - youHitAt < 450 ? (
        <div
          key={youHitAt}
          aria-hidden
          className="pointer-events-none absolute inset-0 z-20 motion-safe:animate-[hurt_0.45s_ease-out_forwards]"
          style={{ boxShadow: "inset 0 0 90px 20px rgba(220,38,38,0.55)" }}
        />
      ) : null}
    </>
  );
}

const BANNER_TONE: Record<Banner["tone"], string> = {
  count: "text-white text-6xl",
  fight: "text-[#ffd84a] text-5xl",
  phase: "text-[#ff9a6a] text-4xl",
  enrage: "text-red-400 text-4xl",
  wipe: "text-white/80 text-4xl",
};

/** The raid's big moments in words across the screen (moments.ts): the
 * countdown, FIGHT!, a new phase, the enrage, a wipe. Pops in, fades. */
function RaidBanner() {
  const b = useBanner();
  const [, setTick] = useState(0);
  // Drop it once its time is up.
  useEffect(() => {
    if (!b) return;
    const t = setTimeout(
      () => setTick((n) => n + 1),
      Math.max(0, b.at + b.ms - performance.now()) + 20,
    );
    return () => clearTimeout(t);
  }, [b]);
  if (!b || performance.now() > b.at + b.ms) return null;
  return (
    <div
      key={b.at}
      aria-live="assertive"
      className="pointer-events-none absolute inset-x-0 top-[22%] z-30 flex flex-col items-center text-center"
      style={{ animation: `raid-banner ${b.ms}ms ease-out forwards` }}
    >
      <style>{`@keyframes raid-banner{0%{opacity:0;transform:scale(1.6)}8%{opacity:1;transform:scale(0.96)}14%{transform:scale(1)}75%{opacity:1}100%{opacity:0;transform:scale(1)}}@media (prefers-reduced-motion: reduce){@keyframes raid-banner{0%{opacity:0}8%{opacity:1}75%{opacity:1}100%{opacity:0}}}`}</style>
      <div
        className={cn(
          "font-black tracking-wide [text-shadow:0_2px_0_#000,0_0_18px_rgba(0,0,0,0.85)]",
          BANNER_TONE[b.tone],
        )}
      >
        {b.text}
      </div>
      {b.sub ? (
        <div className="mt-1 text-ui font-medium text-white/90 [text-shadow:0_1px_2px_#000,0_0_8px_#000]">
          {b.sub}
        </div>
      ) : null}
    </div>
  );
}

/** How long until a Tower floor's mobs enrage, once it's close (the last
 * 20 seconds), then that they have. */
function EnrageTag({
  tower,
  now,
}: {
  tower: { enrageAt: number | null; cleared: boolean };
  now: number;
}) {
  if (tower.cleared || tower.enrageAt === null) return null;
  const left = Math.max(0, tower.enrageAt - now);
  if (left > 20_000) return null;
  return (
    <span className={cn("font-medium", left > 0 ? "text-orange" : "text-red")}>
      {" · "}
      {left > 0 ? `enrage in ${Math.ceil(left / 1000)}s` : "enraged!"}
    </span>
  );
}

/** Under the boss's health: who still stands, whether the
 * boss is on you, and the enrage once it's near. */
function RaidLine({ raid, now }: { raid: RaidView; now: number }) {
  useSkills();
  const taunt = buffOn(bossFight.you, "taunt", now);
  const enrage = raid.enrageAt;
  const hard = raid.hardAt;
  const rage =
    hard !== null && now >= hard
      ? { text: "It's ending the fight!", tone: "text-red" }
      : enrage !== null && now >= enrage
        ? {
            text: `Enraged · ends in ${clock(Math.max(0, (hard ?? now) - now))}`,
            tone: "text-red",
          }
        : enrage !== null && enrage - now < 120_000
          ? { text: `Enrage in ${clock(enrage - now)}`, tone: "text-orange" }
          : null;
  return (
    <div className="mt-1 flex flex-wrap gap-x-2 text-[11px] leading-4 text-white/85">
      <span className="tabular-nums" title="Still standing / in the fight">
        {raid.standing}/{raid.roster} standing
      </span>
      {taunt ? (
        <span className="font-medium text-red">
          The boss is on you · {Math.ceil((taunt.until - now) / 1000)}s
        </span>
      ) : null}
      {rage ? (
        <span className={cn("font-medium", rage.tone)}>{rage.text}</span>
      ) : null}
      {bossFight.tally && raid.you === "in" ? (
        <span
          className="tabular-nums text-white/70"
          title="Your damage, plus healing and blocking (×10), so far"
        >
          You: {bossFight.tally.score.toLocaleString()} · #
          {bossFight.tally.rank}
        </span>
      ) : null}
      {raid.you !== "in" ? (
        <span className="text-white/60">
          {raid.you === "out" ? "You're out of this fight" : "Watching"}
        </span>
      ) : null}
    </div>
  );
}

/** Under your now-playing box in the boss room, while your music is
 * getting to the boss: your class's bonus ("Healing: +30%"). */
export function MusicBonus() {
  useBossFight();
  useSkills();
  const [now, setNow] = useState(() => performance.now());
  const inRaid = bossFight.on && !!bossFight.raid && !bossFight.closing;
  useEffect(() => {
    if (!inRaid) return;
    const t = setInterval(() => setNow(performance.now()), 500);
    return () => clearInterval(t);
  }, [inRaid]);
  if (!inRaid) return null;
  const tuned = buffOn(bossFight.you, "in_tune", now);
  const bonus =
    tuned?.kind === "def"
      ? `Defense: +${Math.round(IN_TUNE.def * 100)}%`
      : tuned?.kind === "heal"
        ? `Healing: +${Math.round((IN_TUNE.heal - 1) * 100)}%`
        : tuned?.kind === "damage"
          ? `Damage: +${Math.round((IN_TUNE.damage - 1) * 100)}%`
          : null;
  if (!bonus) return null;
  return (
    <div
      role="status"
      title="The boss hates music: yours makes you stronger"
      className="pointer-events-none self-start px-0.5 text-ui font-bold text-[#ffd84a] [text-shadow:0_1px_2px_#000,0_0_6px_#000]"
    >
      ♪ {bonus}
    </div>
  );
}
