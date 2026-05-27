import { createHmac } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
  ActiveMultiplier,
  EventNotification,
  Herzie,
  PendingTradeRequest,
} from "@herzies/shared";

const CONFIG_DIR = join(homedir(), ".config", "herzies");
const HERZIE_FILE = join(CONFIG_DIR, "herzie.json");
const SESSION_FILE = join(CONFIG_DIR, "session.json");
const MULTIPLIERS_FILE = join(CONFIG_DIR, "multipliers.json");
const PENDING_TRADE_FILE = join(CONFIG_DIR, "pending-trade.json");
const NOTIFICATIONS_FILE = join(CONFIG_DIR, "notifications.json");

function ensureDir() {
  if (!existsSync(CONFIG_DIR)) {
    mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  }
}

function writeSecure(path: string, data: string) {
  writeFileSync(path, data);
  chmodSync(path, 0o600);
}

const HMAC_SALT = "hrzs_v1_8f3a2c";

/** Compute HMAC over the cheat-sensitive fields of a herzie */
function computeSignature(herzie: Herzie): string {
  const payload = JSON.stringify({
    id: herzie.id,
    xp: herzie.xp,
    level: herzie.level,
    stage: herzie.stage,
    totalMinutesListened: herzie.totalMinutesListened,
    genreMinutes: herzie.genreMinutes,
    currency: herzie.currency,
  });
  return createHmac("sha256", `${HMAC_SALT}:${herzie.id}`)
    .update(payload)
    .digest("hex");
}

export function loadHerzie(): Herzie | null {
  ensureDir();
  if (!existsSync(HERZIE_FILE)) return null;
  try {
    const raw = JSON.parse(readFileSync(HERZIE_FILE, "utf-8"));
    const { _sig, ...herzie } = raw as Herzie & { _sig?: string };
    if (!_sig || _sig !== computeSignature(herzie)) {
      // Tampered or unsigned — reset progress fields
      herzie.xp = 0;
      herzie.level = 1;
      herzie.stage = 1;
      herzie.totalMinutesListened = 0;
      herzie.genreMinutes = {};
    }
    return herzie;
  } catch {
    return null;
  }
}

export function saveHerzie(herzie: Herzie): void {
  ensureDir();
  const data = { ...herzie, _sig: computeSignature(herzie) };
  writeSecure(HERZIE_FILE, JSON.stringify(data, null, 2));
}

export interface SessionData {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  userId: string;
}

export function loadSession(): SessionData | null {
  ensureDir();
  if (!existsSync(SESSION_FILE)) return null;
  try {
    const data = JSON.parse(readFileSync(SESSION_FILE, "utf-8"));
    if (!data?.accessToken || !data?.userId) return null;
    return data;
  } catch {
    return null;
  }
}

export function saveSession(session: SessionData): void {
  ensureDir();
  writeSecure(SESSION_FILE, JSON.stringify(session, null, 2));
}

export function clearSession(): void {
  ensureDir();
  if (existsSync(SESSION_FILE)) {
    writeSecure(SESSION_FILE, "{}");
  }
}

export function deleteLocalData(): void {
  if (existsSync(CONFIG_DIR)) {
    rmSync(CONFIG_DIR, { recursive: true });
  }
}

export function getConfigDir(): string {
  return CONFIG_DIR;
}

export function saveMultipliers(multipliers: ActiveMultiplier[]): void {
  ensureDir();
  writeSecure(MULTIPLIERS_FILE, JSON.stringify(multipliers));
}

export function loadMultipliers(): ActiveMultiplier[] | null {
  if (!existsSync(MULTIPLIERS_FILE)) return null;
  try {
    return JSON.parse(readFileSync(MULTIPLIERS_FILE, "utf-8"));
  } catch {
    return null;
  }
}

export function savePendingTrade(pending: PendingTradeRequest | null): void {
  ensureDir();
  if (pending) {
    writeSecure(PENDING_TRADE_FILE, JSON.stringify(pending));
  } else if (existsSync(PENDING_TRADE_FILE)) {
    rmSync(PENDING_TRADE_FILE, { force: true });
  }
}

export function loadPendingTrade(): PendingTradeRequest | null {
  if (!existsSync(PENDING_TRADE_FILE)) return null;
  try {
    return JSON.parse(readFileSync(PENDING_TRADE_FILE, "utf-8"));
  } catch {
    return null;
  }
}

export function saveNotifications(notifications: EventNotification[]): void {
  ensureDir();
  if (notifications.length > 0) {
    writeSecure(NOTIFICATIONS_FILE, JSON.stringify(notifications));
  } else if (existsSync(NOTIFICATIONS_FILE)) {
    rmSync(NOTIFICATIONS_FILE, { force: true });
  }
}

export function loadAndClearNotifications(): EventNotification[] {
  if (!existsSync(NOTIFICATIONS_FILE)) return [];
  try {
    const data = JSON.parse(readFileSync(NOTIFICATIONS_FILE, "utf-8"));
    rmSync(NOTIFICATIONS_FILE, { force: true });
    return data;
  } catch {
    return [];
  }
}
