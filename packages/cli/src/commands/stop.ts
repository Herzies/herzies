import chalk from "chalk";
import { clearPid, isDaemonRunning, loadPid } from "../storage/pid.js";

export function runStop() {
  if (!isDaemonRunning()) {
    console.log(chalk.dim("No daemon running."));
    return;
  }

  const pid = loadPid();
  try {
    process.kill(pid!, "SIGTERM");
    clearPid();
    console.log(chalk.green(`♫ Daemon stopped.`) + chalk.dim(` (pid ${pid})`));
  } catch (err) {
    clearPid();
    console.log(
      chalk.yellow("Daemon process already gone, cleaned up PID file."),
    );
  }
}
