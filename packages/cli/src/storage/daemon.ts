import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isDaemonRunning } from "./pid.js";

/**
 * Ensure the background daemon is running. Spawns it if not already alive.
 * Returns the PID of the (possibly just-spawned) daemon, or null on failure.
 */
export function ensureDaemonRunning(): number | null {
  if (isDaemonRunning()) return null; // already running

  const __dirname = dirname(fileURLToPath(import.meta.url));
  const daemonPath = join(__dirname, "../commands/daemon.js");

  const child = spawn(process.execPath, [daemonPath], {
    detached: true,
    stdio: "ignore",
  });

  child.unref();
  return child.pid ?? null;
}
