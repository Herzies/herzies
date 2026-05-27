import { createInterface } from "node:readline";
import type { Herzie } from "@herzies/shared";
import { validateName } from "@herzies/shared";
import { Box, render, Text, useApp } from "ink";
import React, { useEffect } from "react";
import { composeHerzie } from "../art/composer.js";
import { waitForLogin } from "../auth/login-flow.js";
import { createHerzie } from "../core/herzie.js";
import { apiGetMe, apiIsNameTaken, apiRegisterHerzie } from "../storage/api.js";
import { saveHerzie } from "../storage/state.js";

const EGG_FRAMES = [
  `
  ╭─╮
  │ │
  │ │
  ╰─╯
`,
  `
  ╭─╮
  │∙│
  │ │
  ╰─╯
`,
  `
   ∗
  ╭─╮
  │∙│
  │∙│
  ╰─╯
`,
  `
  ∗ ∗
  ╭╌╮
 ╱ ∙ ╲
 ╲ ∙ ╱
  ╰╌╯
`,
  `
 ∗ ∗ ∗
  ╱ ╲
 ╱ ✦ ╲
 ╲   ╱
  ╲ ╱
 ∗ ∗ ∗
`,
];

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function prompt(question: string): Promise<string> {
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

function RevealApp({ herzie }: { herzie: Herzie }) {
  const { exit } = useApp();
  const art = composeHerzie(herzie.appearance, herzie.stage);

  useEffect(() => {
    const timer = setTimeout(() => exit(), 100);
    return () => clearTimeout(timer);
  }, [exit]);

  return (
    <Box flexDirection="column" padding={1}>
      <Text color="green" bold>
        {herzie.name} has hatched!
      </Text>
      <Box marginTop={1}>
        <Text>{art}</Text>
      </Box>
      <Box marginTop={1} flexDirection="column">
        <Text>
          <Text bold>Friend code:</Text>{" "}
          <Text color="cyan">{herzie.friendCode}</Text>
        </Text>
        <Text dimColor>
          Share this code so others can add you as a friendzie!
        </Text>
      </Box>
    </Box>
  );
}

async function hatchFlow(): Promise<Herzie> {
  console.log("\n\x1b[35m\x1b[1mA mysterious egg has appeared!\x1b[0m\n");
  console.log(EGG_FRAMES[0]);

  let name = "";
  while (true) {
    name = await prompt("Give your herzie a name: ");

    const validationError = validateName(name);
    if (validationError) {
      console.log(`\x1b[31m${validationError}\x1b[0m`);
      continue;
    }

    if (await apiIsNameTaken(name)) {
      console.log(
        `\x1b[31mThe name "${name}" is already taken. Try another!\x1b[0m`,
      );
      continue;
    }

    break;
  }

  // Hatching animation
  for (let i = 1; i < EGG_FRAMES.length; i++) {
    process.stdout.write("\x1b[2J\x1b[H");
    console.log(`\n\x1b[33m\x1b[1mThe egg is hatching...!\x1b[0m\n`);
    console.log(EGG_FRAMES[i]);
    await sleep(400);
  }

  process.stdout.write("\x1b[2J\x1b[H");

  const herzie = createHerzie(name);
  saveHerzie(herzie);

  // Register with server (user is logged in at this point)
  const registered = await apiRegisterHerzie(herzie);
  if (registered) {
    saveHerzie(registered);
    return registered;
  }

  return herzie;
}

export async function runOnboard() {
  console.log(
    "\n\x1b[35m\x1b[1mHi, looks like you're new. Let's get you started!\x1b[0m",
  );
  console.log("\x1b[2mYou must log in to hatch your herzie.\x1b[0m\n");

  await prompt("Press enter to log in ");

  console.log("\x1b[33mOpening browser...\x1b[0m");
  console.log("\x1b[2mWaiting for login in your browser...\x1b[0m");

  const loggedIn = await waitForLogin();

  if (!loggedIn) {
    console.log(
      "\n\x1b[31mLogin failed or timed out. Try again with: herzies login\x1b[0m\n",
    );
    return;
  }

  console.log("\x1b[32mLogged in!\x1b[0m\n");

  // Check if user already has a herzie on the server
  const existing = await apiGetMe();
  if (existing) {
    saveHerzie(existing);
    console.log(
      `\x1b[32m\x1b[1mWelcome back!\x1b[0m Your herzie \x1b[1m${existing.name}\x1b[0m has been synced.`,
    );
  } else {
    // Hatch a new herzie
    const herzie = await hatchFlow();

    render(<RevealApp herzie={herzie} />);
    await sleep(200);
  }

  // Offer autostart (macOS)
  if (process.platform === "darwin") {
    const answer = await prompt(
      "\nStart listening automatically on login? (Y/n) ",
    );
    if (answer === "" || answer.toLowerCase() === "y") {
      const { runAutostart } = await import("./autostart.js");
      runAutostart("on");
    }
  }

  console.log(
    "\nYou're all set. Run \x1b[1mherzies\x1b[0m and listen to some music!\n",
  );
  process.exit(0);
}
