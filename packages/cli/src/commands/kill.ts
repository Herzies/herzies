import { createInterface } from "node:readline";
import { apiDeleteHerzie, isLoggedIn } from "../storage/api.js";
import { deleteLocalData, loadHerzie } from "../storage/state.js";
import { runAutostart } from "./autostart.js";
import { runStop } from "./stop.js";

function confirm(prompt: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(prompt, (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase() === "y");
    });
  });
}

export async function runKill() {
  const herzie = loadHerzie();
  if (!herzie) {
    console.log("\nYou don't have a Herzie to kill.\n");
    return;
  }

  console.log(
    `\n\x1b[31m\x1b[1mThis will permanently kill ${herzie.name}.\x1b[0m`,
  );
  console.log("All local data will be deleted.");
  if (isLoggedIn()) {
    console.log(
      "Your herzie will also be removed from the server and the leaderboard.",
    );
  }
  console.log("");

  const confirmed = await confirm(`Type y to confirm: `);
  if (!confirmed) {
    console.log("\nCancelled. Your Herzie lives on!\n");
    return;
  }

  if (isLoggedIn()) {
    const deleted = await apiDeleteHerzie();
    if (!deleted) {
      console.log(
        "\x1b[33mWarning: Could not delete server data. You may need to log in and try again.\x1b[0m",
      );
    }
  }

  // Stop daemon and remove autostart
  runStop();
  runAutostart("off");

  deleteLocalData();
  console.log(`\n\x1b[2m${herzie.name} is gone. Farewell.\x1b[0m\n`);
}
