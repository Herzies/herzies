#!/usr/bin/env node
/**
 * Boss Fight — a narrated test run against the LOCAL Supabase stack.
 *
 * A boss runs Thursday→Sunday on a pg_cron schedule, which is untestable in
 * under a week. This drives the same SQL functions the cron drives
 * (spawn_boss_fight / deal_boss_damage / settle_boss_fight /
 * resolve_boss_fight), just with the clock and the roster under our control,
 * so what you watch here is the real mechanic and not a mock of it.
 *
 *   npx supabase start
 *   node scripts/boss-fight-demo.mjs
 *   node scripts/boss-fight-demo.mjs --escape   # let the timer run out
 *   node scripts/boss-fight-demo.mjs --keep     # leave a live boss to look
 *                                               # at in the desktop app
 *
 * Refuses to run against anything but 127.0.0.1.
 */

const URL = "http://127.0.0.1:54321";
const SERVICE_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU";

if (!URL.includes("127.0.0.1")) {
  console.error("refusing to run against a non-local Supabase");
  process.exit(1);
}

const ESCAPE = process.argv.includes("--escape");
const KEEP = process.argv.includes("--keep");

// "techno" is not one of the 15 GENRES. classifyGenre() maps techno, house,
// edm and dubstep onto "electronic", so that is what the boss must hate.
const HATED = ["electronic"];

const h = {
  apikey: SERVICE_KEY,
  Authorization: `Bearer ${SERVICE_KEY}`,
  "Content-Type": "application/json",
};

async function rpc(fn, args = {}) {
  const r = await fetch(`${URL}/rest/v1/rpc/${fn}`, {
    method: "POST",
    headers: h,
    body: JSON.stringify(args),
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`${fn}: ${text}`);
  return text ? JSON.parse(text) : null;
}

async function rest(path, init = {}) {
  const r = await fetch(`${URL}/rest/v1/${path}`, { headers: h, ...init });
  const text = await r.text();
  if (!r.ok) throw new Error(`${path}: ${text}`);
  return text ? JSON.parse(text) : null;
}

const C = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  cyan: (s) => `\x1b[36m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
};

/** The 40-segment bar the events screen will use (HomeView.tsx:428). */
function bar(frac, colour) {
  const filled = Math.round(Math.max(0, Math.min(1, frac)) * 40);
  return colour("█".repeat(filled)) + C.dim("░".repeat(40 - filled));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function reset() {
  await rest("event_claims?id=not.is.null", { method: "DELETE" });
  await rest("events?id=not.is.null", { method: "DELETE" });
  await rest("herzies?user_id=not.is.null", { method: "DELETE" });
  const { users } = await (
    await fetch(`${URL}/auth/v1/admin/users?per_page=200`, { headers: h })
  ).json();
  for (const u of users ?? []) {
    if (u.email?.endsWith("@herzies.demo")) {
      await fetch(`${URL}/auth/v1/admin/users/${u.id}`, {
        method: "DELETE",
        headers: h,
      });
    }
  }
}

async function makeHerzie(name) {
  const r = await fetch(`${URL}/auth/v1/admin/users`, {
    method: "POST",
    headers: h,
    body: JSON.stringify({
      email: `${name.toLowerCase()}-${Date.now()}@herzies.demo`,
      password: "demo-password-123",
      email_confirm: true,
    }),
  });
  const user = await r.json();
  await rest("herzies", {
    method: "POST",
    body: JSON.stringify({
      user_id: user.id,
      name,
      friend_code: `DEMO-${Math.random().toString(36).slice(2, 8).toUpperCase()}`,
      appearance: {},
      xp: 0,
      level: 1,
      stage: 3,
      total_minutes_listened: 0,
      genre_minutes: {},
      friend_codes: [],
      inventory_v2: {},
      currency: 0,
      last_synced_at: new Date().toISOString(),
    }),
  });
  return { id: user.id, name };
}

// What each herzie is playing. Only the electronic-family tags hurt the boss;
// the others are here to prove the genre gate actually gates.
const ROSTER = [
  { name: "herzie1", tags: ["techno"], minutes: 9 },
  { name: "herzie2", tags: ["deep house"], minutes: 7 },
  { name: "herzie3", tags: ["dubstep"], minutes: 6 },
  { name: "herzie4", tags: ["black metal"], minutes: 10 },
  { name: "herzie5", tags: ["bossa nova"], minutes: 8 },
];

/** Mirrors classifyGenre() in packages/shared/src/genres.ts. */
function classify(tags) {
  const GENRES = [
    "pop", "rock", "hip-hop", "electronic", "jazz", "classical", "r&b",
    "country", "metal", "indie", "latin", "folk", "blues", "punk", "soul",
  ];
  const out = new Set();
  for (const raw of tags) {
    const l = raw.toLowerCase();
    for (const g of GENRES) if (l.includes(g) || g.includes(l)) out.add(g);
    if (/edm|house|techno|dubstep/.test(l)) out.add("electronic");
    if (/hardcore|death|thrash/.test(l)) out.add("metal");
    if (/rap|trap|drill/.test(l)) out.add("hip-hop");
  }
  return out.size ? [...out] : ["pop"];
}

async function main() {
  console.log(C.bold("\n  cleaning up any previous demo run…"));
  await reset();

  const players = [];
  for (const r of ROSTER) players.push({ ...r, ...(await makeHerzie(r.name)) });

  // Small HP so the run finishes while you watch. The real spawner computes
  // clamp(active_herzies * 35, 900, 50000) over a four-day window.
  // --keep uses a real-ish pool and a real-ish window so the desktop panel
  // shows a boss mid-fight rather than one about to die.
  const HP = KEEP ? 900 : 120;
  const endsAt = new Date(
    Date.now() + (ESCAPE ? 4000 : KEEP ? 3 * 86_400_000 : 3_600_000),
  );
  const eventId = await rpc("spawn_boss_fight", {
    p_hated_genres: HATED,
    p_hp: HP,
    p_ends_at: endsAt.toISOString(),
    p_title: "Nohoot Henry",
  });

  console.log(C.bold("\n" + "═".repeat(58)));
  console.log(C.bold("  BOSS FIGHT") + C.dim("   Nohoot Henry"));
  console.log(C.bold("═".repeat(58)));
  console.log(`  Completion reward: ${C.yellow('"Obsidian Fang"')}`);
  console.log(`  Hates: ${C.cyan(HATED.join(" · "))}  ${C.dim("(techno, house, edm, dubstep all classify here)")}`);
  console.log(`  HP: ${HP}\n`);

  console.log(C.dim("  who's listening to what:"));
  for (const p of players) {
    const cls = classify(p.tags);
    const hurts = cls.some((g) => HATED.includes(g));
    console.log(
      `    ${p.name.padEnd(9)} ${p.tags[0].padEnd(12)} -> ${cls.join(",").padEnd(12)} ` +
        (hurts ? C.green("HURTS IT") : C.dim("no effect")),
    );
  }

  if (ESCAPE) {
    console.log(C.bold("\n  --escape: nobody shows up. waiting for the timer…\n"));
    await sleep(5000);
    const n = await rpc("resolve_boss_fight", {});
    const st = (await rest(`boss_state?event_id=eq.${eventId}`))[0];
    console.log(`  ${bar(st.hp / st.max_hp, C.red)}  ${st.hp}/${st.max_hp}`);
    console.log(C.red(C.bold("\n  THE BOSS ESCAPED")));
    console.log(`  resolved: ${n}   escaped=${st.escaped} killed=${st.killed}`);
    console.log(C.dim("  No reward granted. It will return.\n"));
    return;
  }

  console.log(C.bold("\n  fight:\n"));
  let round = 0;
  const maxRounds = KEEP ? 4 : 12;
  let state = (await rest(`boss_state?event_id=eq.${eventId}`))[0];

  while (!state.killed && round < maxRounds) {
    round++;
    // Everyone syncs at once — the real hot path, and the reason HP moves
    // through a locking RPC rather than a read-modify-write.
    const hits = await Promise.all(
      players.map(async (p) => {
        const cls = classify(p.tags);
        if (!cls.some((g) => HATED.includes(g))) return null;
        const res = await rpc("deal_boss_damage", {
          p_event_id: eventId,
          p_user_id: p.id,
          p_damage: p.minutes,
        });
        return { p, res: res?.[0] };
      }),
    );

    state = (await rest(`boss_state?event_id=eq.${eventId}`))[0];
    const landed = hits
      .filter(Boolean)
      .filter((x) => x.res)
      .map((x) => `${x.p.name} ${C.red(`-${x.p.minutes}`)}`)
      .join("  ");

    console.log(
      `  ${C.dim(`round ${String(round).padStart(2)}`)}  ${bar(state.hp / state.max_hp, C.red)} ` +
        `${String(Math.round(state.hp)).padStart(4)}/${state.max_hp}`,
    );
    if (landed) console.log(`            ${C.dim(landed)}`);

    const killer = hits.find((x) => x?.res?.is_killing_blow);
    if (killer) {
      console.log(C.bold(C.red(`\n  ${killer.p.name} lands the killing blow.`)));
    }
    await sleep(260);
  }

  if (KEEP) {
    console.log(
      C.bold(
        C.green(
          `\n  boss left standing at ${Math.round(state.hp)}/${state.max_hp} HP.`,
        ),
      ),
    );
    console.log(
      C.dim(
        "  open the desktop app (scripts/desktop-local.sh) and hit the Events tab.\n" +
          "  log in as any of: " +
          players.map((p) => p.name).join(", ") +
          "  /  password: demo-password-123\n",
      ),
    );
    return;
  }

  console.log(C.bold(C.green("\n  BOSS DEFEATED\n")));

  // The kill did NOT hand out loot — the settle job does, on its own cron.
  console.log(C.dim("  settle job runs (every minute in production)…"));
  const paid = await rpc("settle_boss_fight", { p_event_id: eventId });
  console.log(C.dim(`  paid ${paid} herzies\n`));

  const board = await rpc("boss_leaderboard", {
    p_event_id: eventId,
    p_limit: 5,
  });
  console.log(C.bold("  Top damage dealers:"));
  for (const row of board) {
    const inv = (
      await rest(`herzies?user_id=eq.${row.user_id}&select=inventory_v2`)
    )[0].inventory_v2;
    const count = Object.values(inv).reduce((a, b) => a + b, 0);
    const tier = row.rank <= 3 ? C.yellow("  + gold variant") : "";
    console.log(
      `    ${row.rank}  ${row.name.padEnd(9)} ${String(Math.round(row.damage)).padStart(4)}` +
        `   ${C.dim(`${count}x item`)}${tier}`,
    );
  }

  const idle = players.filter(
    (p) => !classify(p.tags).some((g) => HATED.includes(g)),
  );
  console.log(
    C.dim(
      `\n  ${idle.map((p) => p.name).join(" and ")} dealt no damage and got nothing — ` +
        `they weren't listening to anything it hates.`,
    ),
  );

  console.log(C.dim("\n  re-running the settle job (proving it's idempotent)…"));
  const again = await rpc("settle_boss_fight", { p_event_id: eventId });
  console.log(C.dim(`  paid ${again} herzies on the second run\n`));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
