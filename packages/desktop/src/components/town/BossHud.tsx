import { IN_TUNE } from "@herzies/shared";
import { useEffect, useState } from "react";
import { cn } from "../../lib/utils";
import { clock } from "./cave";
import {
  bossFight,
  mobsLeft,
  type RaidView,
  useBossFight,
} from "./combat/fight";
import { buffOn, useSkills } from "./combat/skills";

/** The boss's card: top right, clear of your own (top left), as wide as
 * the space beside it allows. */
const BOSS_CARD =
  "pointer-events-none absolute top-3 right-3 z-30 w-[min(15rem,calc(100%-174px-2.25rem))] rounded-xl border border-white/12 bg-black/45 px-2 pt-1 pb-2 text-white backdrop-blur-md";

/**
 * What the boss room shows over the world. The boss has a card of its own,
 * top right: its name, and in the lobby how long until it wakes; in the
 * fight its health (with its phases marked), how many still stand, the
 * raid's revives, the taunt, the enrage; once it's over, what happened and
 * how long until the room closes. A flash of red when you're hit. In the
 * Tower: the floor, at the top. (Your music's bonus sits under your own
 * now-playing box: MusicBonus. The door's and the room's little messages
 * are notices: lib/notices.ts.)
 */
export function BossHud({ name }: { name: string }) {
  useBossFight();
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
            <div role="status" className="text-[11px] text-white/80">
              Wakes in{" "}
              <span className="tabular-nums font-medium text-white">
                {clock(Math.max(0, raid.startsAt - now))}
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
                  <div
                    className="h-full bg-red-500 transition-[width] duration-200"
                    style={{ width: `${frac * 100}%` }}
                  />
                  {/* Where it changes gear. */}
                  {[0.66, 0.33].map((p) => (
                    <span
                      key={p}
                      className="absolute top-0 h-full w-px bg-white/50"
                      style={{ left: `${p * 100}%` }}
                    />
                  ))}
                </div>
                <div className="mt-0.5 text-[10px] leading-3 tabular-nums text-white/60">
                  {Math.ceil(hp).toLocaleString()} / {maxHp.toLocaleString()}
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
