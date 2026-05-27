import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getConfigDir } from "./state.js";

const PID_FILE = join(getConfigDir(), "daemon.pid");

export function writePid(pid: number): void {
  writeFileSync(PID_FILE, String(pid));
}

export function loadPid(): number | null {
  if (!existsSync(PID_FILE)) return null;
  try {
    const raw = readFileSync(PID_FILE, "utf-8").trim();
    const pid = Number.parseInt(raw, 10);
    return Number.isNaN(pid) ? null : pid;
  } catch {
    return null;
  }
}

export function clearPid(): void {
  try {
    if (existsSync(PID_FILE)) unlinkSync(PID_FILE);
  } catch {
    // ignore
  }
}

/** Returns true if the daemon process is currently alive */
export function isDaemonRunning(): boolean {
  const pid = loadPid();
  if (pid === null) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    // Process doesn't exist — stale PID file
    clearPid();
    return false;
  }
}
