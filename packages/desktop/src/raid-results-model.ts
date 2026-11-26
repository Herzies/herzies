import {
  type AwardMine,
  type AwardPlace,
  CLASS_DEFS,
  type ClassRole,
  type Equipped,
  type HerzieClass,
} from "@herzies/shared";
import { bossMaxHp } from "@herzies/shared/boss-fight";
import {
  AWARD_ROLES,
  type AwardEntry,
  type Contribution,
  pickAwardWinners,
  rankAwards,
  tankedSeconds,
  tauntPointsPerSecond,
} from "@herzies/shared/combat";
import type { BossResults } from "./components/town/combat/results";

/**
 * Dev only: the fights the raid results preview draws
 * (/raid-results-preview.html), turned into the end screen the server
 * would send — each role ranked by the shared rankAwards, its winner by
 * pickAwardWinners — as seen by one herzie in the roster.
 */

/** What one herzie did over a fight, as the fight counts it. */
export type Fighter = {
  name: string;
  cls: HerzieClass;
  /** Damage to the boss. */
  damage: number;
  /** Damage to its minions. */
  adds: number;
  /** HP healed (Drones, heal bolts, revives). */
  healed: number;
  /** HP a Cymbrella kept off the herzies under it. */
  blocked: number;
  /** Seconds the boss was held with a Taunt. */
  heldSec: number;
};

/** Each role's ranking, keyed by roster index (as a string). */
export type FightRanks = Record<ClassRole, AwardEntry<string>[]>;

export const maxHpFor = (roster: Fighter[]) => bossMaxHp(roster.length);

export const roleOf = (f: Fighter): ClassRole => CLASS_DEFS[f.cls].role;

/** A fighter's work as the fight counts it: its Taunt seconds in points,
 * for a boss of `maxHp` and a roster of `size`. */
function workOf(f: Fighter, maxHp: number, size: number): Contribution {
  return {
    damage: f.damage,
    adds: f.adds,
    healing: f.healed,
    blocked: f.blocked,
    taunt: f.heldSec * tauntPointsPerSecond(maxHp, size),
  };
}

/** Each role ranked on its own points, best first (rankAwards). */
export function rankFight(roster: Fighter[]): FightRanks {
  const maxHp = maxHpFor(roster);
  return rankAwards(
    roster.map((f, i) => [String(i), workOf(f, maxHp, roster.length)] as const),
  );
}

/** Each class's instruments, in hand on the plinth. */
const GEAR: Record<HerzieClass, Equipped> = {
  bard: { main_hand: "lute" },
  record_slinger: { main_hand: "compact-discs" },
  percussionist: { main_hand: "worn-stick", off_hand: "old-cymbal" },
};

/** The end screen as `you` (a roster index) sees it: each award's winner
 * and best three, and your own result, as the server words them. */
export function awardResults(
  roster: Fighter[],
  ranks: FightRanks,
  you: number,
  outcome: BossResults["outcome"],
): Omit<BossResults, "showAt"> {
  const maxHp = maxHpFor(roster);
  const winners = pickAwardWinners(ranks);
  const place = (e: AwardEntry<string>): AwardPlace => {
    const f = roster[Number(e.key)];
    const c = workOf(f, maxHp, roster.length);
    return {
      rank: e.rank,
      name: f.name,
      share: e.share,
      damage: Math.round(f.damage + f.adds),
      healed: Math.round(f.healed),
      blocked: Math.round(f.blocked),
      tanked: Math.round(tankedSeconds(c.taunt ?? 0, maxHp, roster.length)),
    };
  };
  // Your own role: the one you won; else your class's, if you did any of
  // it; else the one where your share is biggest.
  const key = String(you);
  const entryIn = (role: ClassRole) => ranks[role].find((e) => e.key === key);
  const yourClass = roster[you] ? roleOf(roster[you]) : null;
  const byShare = AWARD_ROLES.filter((role) => entryIn(role)).sort(
    (a, b) => (entryIn(b)?.share ?? 0) - (entryIn(a)?.share ?? 0),
  );
  const mineRole: ClassRole | null =
    AWARD_ROLES.find((role) => winners[role]?.key === key) ??
    (yourClass && entryIn(yourClass) ? yourClass : (byShare[0] ?? null));
  const mineEntry = mineRole ? entryIn(mineRole) : undefined;
  const mine: AwardMine | null =
    mineRole && mineEntry
      ? {
          role: mineRole,
          place: place(mineEntry),
          won: winners[mineRole]?.key === key,
        }
      : null;
  return {
    outcome,
    mine,
    awards: AWARD_ROLES.map((role) => {
      const won = winners[role];
      const f = won ? roster[Number(won.key)] : null;
      return {
        role,
        winner:
          won && f
            ? {
                ...place(won),
                look: { seed: f.name, stage: 3, equipped: GEAR[f.cls] },
              }
            : null,
        top: ranks[role].slice(0, 3).map(place),
      };
    }),
  };
}

const f = (
  name: string,
  cls: HerzieClass,
  s: Partial<Omit<Fighter, "name" | "cls">>,
): Fighter => ({
  name,
  cls,
  damage: 0,
  adds: 0,
  healed: 0,
  blocked: 0,
  heldSec: 0,
  ...s,
});

/** Fights to look at: damage sums to about the boss's health (less in a
 * defeat), each class at its usual rate (boss-fight.ts: 350-850 a second,
 * about 6.5 minutes). */
export const SCENARIOS: {
  id: string;
  label: string;
  outcome: BossResults["outcome"];
  /** Whose screen it is, by roster index. */
  you: number;
  roster: Fighter[];
}[] = [
  {
    id: "balanced",
    label: "Balanced five",
    outcome: "victory",
    you: 2,
    roster: [
      f("Vinyl Vex", "record_slinger", { damage: 312_000, adds: 18_000 }),
      f("Lo-Fi Lou", "record_slinger", { damage: 268_000, adds: 22_000 }),
      f("Thump", "percussionist", {
        damage: 148_000,
        adds: 9_000,
        heldSec: 255,
        blocked: 4_100,
      }),
      f("Lullaby", "bard", { damage: 74_000, healed: 13_800 }),
      f("Mossy", "bard", { damage: 93_000, healed: 5_200 }),
    ],
  },
  {
    id: "lone-tank",
    label: "One tank holds eight",
    outcome: "victory",
    you: 5,
    roster: [
      f("Disco Dan", "record_slinger", { damage: 248_000, adds: 14_000 }),
      f("Scratch", "record_slinger", { damage: 231_000, adds: 20_000 }),
      f("B-Side", "record_slinger", { damage: 219_000, adds: 8_000 }),
      f("Wax", "record_slinger", { damage: 204_000, adds: 11_000 }),
      f("Groove", "record_slinger", { damage: 176_000, adds: 6_000 }),
      f("Boomer", "percussionist", {
        damage: 118_000,
        heldSec: 320,
        blocked: 6_000,
      }),
      f("Snare", "percussionist", {
        damage: 121_000,
        heldSec: 20,
        blocked: 800,
      }),
      f("Hymn", "bard", { damage: 48_000, healed: 16_000 }),
    ],
  },
  {
    id: "two-tanks",
    label: "Two tanks trade",
    outcome: "victory",
    you: 0,
    roster: [
      f("Clang", "percussionist", {
        damage: 132_000,
        heldSec: 190,
        blocked: 3_800,
      }),
      f("Rimshot Ray", "percussionist", {
        damage: 140_000,
        heldSec: 170,
        blocked: 5_100,
      }),
      f("Spinner", "record_slinger", { damage: 270_000, adds: 12_000 }),
      f("Platter", "record_slinger", { damage: 245_000, adds: 9_000 }),
      f("Needle", "record_slinger", { damage: 215_000, adds: 15_000 }),
      f("Chord", "bard", { damage: 51_000, healed: 15_200 }),
    ],
  },
  {
    id: "healers",
    label: "Three healers",
    outcome: "victory",
    you: 2,
    roster: [
      f("Aria", "bard", { damage: 40_000, healed: 12_000 }),
      f("Ballad", "bard", { damage: 55_000, healed: 9_500 }),
      f("Coda", "bard", { damage: 90_000, healed: 4_000 }),
      f("Flip", "record_slinger", { damage: 330_000, adds: 16_000 }),
      f("Pressing", "record_slinger", { damage: 300_000, adds: 10_000 }),
      f("Kettle", "percussionist", {
        damage: 238_000,
        heldSec: 280,
        blocked: 2_500,
      }),
    ],
  },
  {
    id: "duo",
    label: "Duo",
    outcome: "victory",
    you: 1,
    roster: [
      f("Sleeve", "record_slinger", { damage: 300_000, adds: 6_000 }),
      f("Hum", "bard", { damage: 92_000, healed: 6_000 }),
    ],
  },
  {
    id: "big",
    label: "Twelve, you're far down",
    outcome: "victory",
    you: 11,
    roster: [
      f("Turntable Tia", "record_slinger", { damage: 260_000, adds: 18_000 }),
      f("Mixtape", "record_slinger", { damage: 245_000, adds: 12_000 }),
      f("Crate Digger", "record_slinger", { damage: 238_000, adds: 9_000 }),
      f("Stylus", "record_slinger", { damage: 226_000, adds: 14_000 }),
      f("Lacquer", "record_slinger", { damage: 214_000, adds: 7_000 }),
      f("Shellac", "record_slinger", { damage: 190_000, adds: 5_000 }),
      f("Dub", "record_slinger", { damage: 152_000, adds: 3_000 }),
      f("Gong", "percussionist", {
        damage: 140_000,
        heldSec: 260,
        blocked: 4_400,
      }),
      f("Tom", "percussionist", {
        damage: 98_000,
        heldSec: 80,
        blocked: 1_500,
      }),
      f("Psalm", "bard", { damage: 72_000, healed: 14_000 }),
      f("Carol", "bard", { damage: 61_000, healed: 8_000 }),
      f("Wren", "bard", { damage: 67_000, healed: 2_500 }),
    ],
  },
  {
    id: "wipe",
    label: "Wipe (defeat)",
    outcome: "defeat",
    you: 3,
    roster: [
      f("Hiss", "record_slinger", { damage: 180_000, adds: 22_000 }),
      f("Crackle", "record_slinger", { damage: 150_000, adds: 18_000 }),
      f("Bongo", "percussionist", {
        damage: 90_000,
        heldSec: 200,
        blocked: 6_000,
      }),
      f("Requiem", "bard", { damage: 60_000, healed: 18_000 }),
      f("Murmur", "bard", { damage: 57_000, healed: 3_000 }),
    ],
  },
  {
    id: "long-names",
    label: "Long names",
    outcome: "victory",
    you: 3,
    roster: [
      f("Sir Reginald Thumpington III", "percussionist", {
        damage: 160_000,
        heldSec: 240,
        blocked: 3_000,
      }),
      f("The Unbearable Lightness of Bass", "record_slinger", {
        damage: 300_000,
        adds: 10_000,
      }),
      f("xXx_DiscJockeyDestroyer_xXx", "record_slinger", {
        damage: 205_000,
        adds: 6_000,
      }),
      f("Mmmmmmmmmmmmmmmmmmmmmmmm", "bard", {
        damage: 50_000,
        healed: 11_000,
      }),
    ],
  },
  {
    id: "double",
    label: "A tank tops the damage too",
    outcome: "victory",
    you: 1,
    roster: [
      f("Big Kahuna", "percussionist", {
        damage: 290_000,
        adds: 20_000,
        heldSec: 300,
        blocked: 5_000,
      }),
      f("Pebble", "record_slinger", { damage: 240_000, adds: 8_000 }),
      f("Quartz", "record_slinger", { damage: 220_000, adds: 12_000 }),
      f("Cantor", "bard", { damage: 60_000, healed: 12_000 }),
    ],
  },
  {
    id: "no-tank",
    label: "No tank",
    outcome: "victory",
    you: 2,
    roster: [
      f("Riff", "record_slinger", { damage: 290_000, adds: 14_000 }),
      f("Loop", "record_slinger", { damage: 255_000, adds: 9_000 }),
      f("Shanty", "bard", { damage: 70_000, healed: 17_000 }),
      f("Tune", "bard", { damage: 80_000, healed: 6_000 }),
    ],
  },
];
