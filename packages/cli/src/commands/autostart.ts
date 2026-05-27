import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import chalk from "chalk";

const LABEL = "com.herzies.daemon";
const PLIST_DIR = join(homedir(), "Library", "LaunchAgents");
const PLIST_PATH = join(PLIST_DIR, `${LABEL}.plist`);

function getNodePath(): string {
  try {
    return execFileSync("which", ["node"], { encoding: "utf-8" }).trim();
  } catch {
    return process.execPath;
  }
}

function getDaemonScriptPath(): string {
  // Resolve relative to this compiled file — daemon.js is in the same directory
  const __dirname = dirname(fileURLToPath(import.meta.url));
  return join(__dirname, "daemon.js");
}

function buildPlist(nodePath: string, daemonPath: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key>
	<string>${LABEL}</string>
	<key>ProgramArguments</key>
	<array>
		<string>${nodePath}</string>
		<string>${daemonPath}</string>
	</array>
	<key>RunAtLoad</key>
	<true/>
	<key>KeepAlive</key>
	<false/>
	<key>StandardErrorPath</key>
	<string>${join(homedir(), ".config", "herzies", "daemon.log")}</string>
</dict>
</plist>`;
}

export function runAutostart(action: string) {
  if (action === "on") {
    enableAutostart();
  } else if (action === "off") {
    disableAutostart();
  } else {
    // Show current status
    if (existsSync(PLIST_PATH)) {
      console.log(
        chalk.green("●") + chalk.dim(" Autostart is ") + chalk.bold("enabled"),
      );
      console.log(chalk.dim(`  ${PLIST_PATH}`));
    } else {
      console.log(
        chalk.red("●") + chalk.dim(" Autostart is ") + chalk.bold("disabled"),
      );
      console.log(
        chalk.dim("  Run ") +
          chalk.bold("herzies autostart on") +
          chalk.dim(" to enable."),
      );
    }
  }
}

function enableAutostart() {
  const nodePath = getNodePath();
  const daemonPath = getDaemonScriptPath();

  if (!existsSync(PLIST_DIR)) {
    mkdirSync(PLIST_DIR, { recursive: true });
  }

  writeFileSync(PLIST_PATH, buildPlist(nodePath, daemonPath));

  // Load it now so it starts without needing a reboot
  try {
    execFileSync("launchctl", ["load", PLIST_PATH]);
  } catch {
    // Already loaded or launchctl issue — not fatal
  }

  console.log(chalk.green("♫ Autostart enabled!"));
  console.log(
    chalk.dim(
      "  Your Herzie daemon will start automatically on login.\n" +
        "  Run " +
        chalk.bold("herzies autostart off") +
        " to disable.",
    ),
  );
}

function disableAutostart() {
  if (!existsSync(PLIST_PATH)) {
    console.log(chalk.dim("Autostart is already disabled."));
    return;
  }

  try {
    execFileSync("launchctl", ["unload", PLIST_PATH]);
  } catch {
    // Not loaded — fine
  }

  unlinkSync(PLIST_PATH);

  console.log(chalk.green("Autostart disabled."));
}
