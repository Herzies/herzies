import { useState } from "react";
import { cn } from "../lib/utils";
import { herzies } from "../tauri-bridge";

const BANNER = `\
 _                   _
| |                 (_)
| |__   ___ _ __ _____  ___  ___
| '_ \\ / _ \\ '__|_  / |/ _ \\/ __|
| | | |  __/ |   / /| |  __/\\__ \\
|_| |_|\\___|_|  /___|_|\\___||___/`;

export function SplashScreen() {
  const [loggingIn, setLoggingIn] = useState(false);

  return (
    <div
      data-tauri-drag-region
      className="flex h-screen flex-col items-center justify-center gap-5"
    >
      <div className="flex justify-center">
        <pre className="m-0 text-sm leading-[1.15] text-purple">{BANNER}</pre>
      </div>
      <button
        className={cn("btn px-6 py-2 text-ui-lg text-green")}
        disabled={loggingIn}
        onClick={async () => {
          setLoggingIn(true);
          await herzies.login();
          setLoggingIn(false);
        }}
      >
        {loggingIn ? "Opening browser..." : "Login"}
      </button>
    </div>
  );
}
