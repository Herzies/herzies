/**
 * Headless background daemon that polls for music and accumulates XP
 * without requiring an open terminal window.
 *
 * Spawned by `herzies start`, stopped by `herzies stop`.
 *
 * The daemon sends observations to the game server, which is the
 * authority for XP calculation, leveling, and event triggers.
 */

import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import {
  applyXp,
  calculateXpGain,
  classifyGenre,
  type EventNotification,
  getDailyCraving,
  type Herzie,
  matchesCraving,
  recordGenreMinutes,
} from "@herzies/shared";
import { getNowPlaying } from "../music/nowplaying.js";
import { apiSync, isLoggedIn } from "../storage/api.js";
import { clearPid, loadPid, writePid } from "../storage/pid.js";
import {
  loadHerzie,
  saveHerzie,
  saveMultipliers,
  saveNotifications,
  savePendingTrade,
} from "../storage/state.js";

const POLL_INTERVAL = 3000;
const SYNC_INTERVAL = 10000;
const VERSION_CHECK_INTERVAL = 30000;

let lastPollTime = Date.now();
let lastTrackTitle = "";
let currentNowPlaying: {
  title: string;
  artist: string;
  genre?: string;
} | null = null;
let currentGenres: string[] = [];

/** Minutes accumulated since last sync — sent to server as observations */
let pendingMinutes = 0;

function log(msg: string) {
  const ts = new Date().toISOString();
  process.stderr.write(`[${ts}] ${msg}\n`);
}

async function poll(herzie: Herzie): Promise<void> {
  const np = await getNowPlaying();

  if (!np || !np.isPlaying || !np.title || np.volume === 0) {
    currentNowPlaying = null;
    currentGenres = [];
    lastPollTime = Date.now();
    return;
  }

  currentNowPlaying = { title: np.title, artist: np.artist, genre: np.genre };
  currentGenres = np.genre ? [np.genre] : [];

  const now = Date.now();
  const minutesSinceLastPoll = (now - lastPollTime) / 60000;
  lastPollTime = now;
  const minutes = Math.min(minutesSinceLastPoll, 1);

  const trackKey = `${np.title}-${np.artist}`;
  if (trackKey !== lastTrackTitle) {
    lastTrackTitle = trackKey;
    log(`♪ ${np.title} — ${np.artist}`);
  }

  if (minutes > 0.01) {
    pendingMinutes += minutes;

    // Also apply XP locally for responsive UI (server is authoritative on sync)
    const genreList = np.genre ? [np.genre] : [];
    const genres =
      genreList.length > 0 ? classifyGenre(genreList) : classifyGenre(["pop"]);
    const craving = getDailyCraving(herzie.id);
    const isCraving =
      genreList.length > 0 && matchesCraving(genreList, craving);

    // Re-read from disk to pick up changes from other commands
    const fresh = loadHerzie();
    if (fresh) {
      herzie.friendCodes = fresh.friendCodes;
      herzie.friendCode = fresh.friendCode;
      herzie.name = fresh.name;
      herzie.boostUntil = fresh.boostUntil;
    }

    const xp = calculateXpGain(
      minutes,
      herzie.friendCodes.length,
      isCraving,
      [],
    );
    const events = applyXp(herzie, xp);
    herzie.totalMinutesListened += minutes;
    recordGenreMinutes(herzie.genreMinutes, genres, minutes);
    saveHerzie(herzie);

    if (events.leveledUp) {
      log(`⬆ LEVEL UP! ${herzie.name} is now level ${herzie.level}!`);
    }
    if (events.evolved && events.newStage) {
      log(`✨ ${herzie.name} EVOLVED to Stage ${events.newStage}!`);
    }
  }
}

function handleNotifications(notifications: EventNotification[]) {
  for (const n of notifications) {
    if (n.type === "item_granted") {
      log(`🎁 ${n.title}: ${n.message}`);
    } else if (n.type === "event_complete") {
      log(`🏆 ${n.title}: ${n.message}`);
    } else {
      log(`ℹ ${n.title}: ${n.message}`);
    }
  }
}

async function syncLoop(herzie: Herzie) {
  if (!isLoggedIn()) return;

  // Cap to server's hard limit so excess minutes stay pending for next sync
  const minutesToSync = Math.min(pendingMinutes, 10);
  const npPayload = currentNowPlaying
    ? {
        title: currentNowPlaying.title,
        artist: currentNowPlaying.artist,
        genre: currentNowPlaying.genre,
      }
    : null;

  const result = await apiSync(npPayload, minutesToSync, currentGenres);

  if (result) {
    pendingMinutes = Math.max(0, pendingMinutes - minutesToSync);

    // Server is authoritative — update local state from response
    const serverHerzie = result.herzie;
    herzie.xp = serverHerzie.xp;
    herzie.level = serverHerzie.level;
    herzie.stage = serverHerzie.stage;
    herzie.totalMinutesListened = serverHerzie.totalMinutesListened;
    herzie.genreMinutes = serverHerzie.genreMinutes;
    herzie.friendCodes = serverHerzie.friendCodes;
    herzie.streakDays = serverHerzie.streakDays;
    herzie.streakLastDate = serverHerzie.streakLastDate;
    herzie.currency = serverHerzie.currency;
    saveHerzie(herzie);
    saveMultipliers(result.multipliers ?? []);

    // Write pending trade request for the UI to pick up
    savePendingTrade(result.pendingTradeRequest ?? null);

    if (result.notifications.length > 0) {
      handleNotifications(result.notifications);
      saveNotifications(result.notifications);
    }

    log("synced");
  }
  // If API unreachable, pendingMinutes keeps accumulating for next attempt
}

async function main() {
  const existingPid = loadPid();
  if (existingPid !== null) {
    try {
      process.kill(existingPid, 0);
      log(`daemon already running (pid ${existingPid}), exiting`);
      process.exit(1);
    } catch {
      // stale pid file
    }
  }

  const herzie = loadHerzie();
  if (!herzie) {
    log("no herzie found — run `herzies hatch` first");
    process.exit(1);
  }

  const require = createRequire(import.meta.url);
  const startVersion: string = require("../../../package.json").version;

  writePid(process.pid);
  log(
    `daemon started (pid ${process.pid}, v${startVersion}) for ${herzie.name}`,
  );

  const cleanup = async () => {
    log("daemon stopping");
    currentNowPlaying = null;

    if (isLoggedIn()) {
      await apiSync(null, 0, []).catch(() => null);
    }

    clearPid();
    process.exit(0);
  };
  process.on("SIGTERM", cleanup);
  process.on("SIGINT", cleanup);

  setInterval(() => {
    poll(herzie).catch((err) => log(`poll error: ${err}`));
  }, POLL_INTERVAL);

  syncLoop(herzie).catch(() => {});
  setInterval(() => {
    syncLoop(herzie).catch(() => {});
  }, SYNC_INTERVAL);

  setInterval(() => {
    try {
      delete require.cache[require.resolve("../../../package.json")];
      const currentVersion: string = require("../../../package.json").version;
      if (currentVersion !== startVersion) {
        log(
          `version changed (${startVersion} → ${currentVersion}), restarting`,
        );
        clearPid();
        const child = spawn(
          process.execPath,
          [fileURLToPath(import.meta.url)],
          {
            detached: true,
            stdio: "ignore",
          },
        );
        child.unref();
        process.exit(0);
      }
    } catch {
      // ignore — package.json may be temporarily missing during install
    }
  }, VERSION_CHECK_INTERVAL);

  poll(herzie).catch(() => {});
}

main();
