import chalk from "chalk";
import { ensureDaemonRunning } from "../storage/daemon.js";
import { isDaemonRunning, loadPid } from "../storage/pid.js";
import { loadHerzie } from "../storage/state.js";

export function runStart() {
  if (!loadHerzie()) {
    console.log(
      chalk.yellow("No Herzie found! Run ") +
        chalk.bold("herzies hatch") +
        chalk.yellow(" first."),
    );
    process.exit(1);
  }

  if (isDaemonRunning()) {
    console.log(
      chalk.yellow(`Daemon already running (pid ${loadPid()}). Use `) +
        chalk.bold("herzies stop") +
        chalk.yellow(" to restart."),
    );
    return;
  }

  const pid = ensureDaemonRunning();

  console.log(
    chalk.green("♫ Herzie daemon started!") + chalk.dim(` (pid ${pid})`),
  );
  console.log(
    chalk.dim(
      "  Your Herzie is now listening in the background.\n" +
        "  Run " +
        chalk.bold("herzies stop") +
        " to stop, or " +
        chalk.bold("herzies status") +
        " to check in.",
    ),
  );
}
