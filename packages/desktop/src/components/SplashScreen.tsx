import { useState } from "react";
import { herzies } from "../tauri-bridge";
import { btnStyle } from "./styles";

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
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        height: "100vh",
        gap: 20,
      }}
    >
      <div style={{ display: "flex", justifyContent: "center" }}>
        <pre
          style={{
            color: "#c084fc",
            fontSize: 14,
            lineHeight: 1.15,
            margin: 0,
          }}
        >
          {BANNER}
        </pre>
      </div>
      <button
        style={{
          ...btnStyle,
          padding: "8px 24px",
          fontSize: 13,
          color: "#4ade80",
        }}
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
