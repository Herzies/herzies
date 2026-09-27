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

const LOGIN_ERRORS: Record<string, string> = {
  timed_out: "Login timed out. Try again.",
  port_in_use: "Another login is still running. Try again in a moment.",
  browser_open_failed: "Couldn't open your browser.",
  invalid_callback: "Login didn't complete. Try again.",
};

export function SplashScreen() {
  const [loggingIn, setLoggingIn] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const login = async () => {
    setError(null);
    setLoggingIn(true);
    try {
      await herzies.login();
    } catch (e) {
      const code = String(e);
      if (code !== "cancelled") {
        setError(LOGIN_ERRORS[code] ?? "Login failed. Try again.");
      }
    } finally {
      setLoggingIn(false);
    }
  };

  return (
    <div
      data-tauri-drag-region
      className="flex h-screen flex-col items-center justify-center gap-5"
    >
      <div className="flex justify-center">
        <pre className="m-0 text-sm leading-[1.15] text-purple">{BANNER}</pre>
      </div>
      {loggingIn ? (
        <div className="flex flex-col items-center gap-3">
          <div className="text-ui text-text-dim">Waiting for browser...</div>
          <button
            type="button"
            className="btn px-6 py-2 text-ui-lg text-red"
            onClick={() => herzies.cancelLogin()}
          >
            Cancel
          </button>
        </div>
      ) : (
        <button
          type="button"
          className={cn("btn px-6 py-2 text-ui-lg text-green")}
          onClick={login}
        >
          Login
        </button>
      )}
      {error && !loggingIn && (
        <div className="text-center text-ui text-red">{error}</div>
      )}
    </div>
  );
}
