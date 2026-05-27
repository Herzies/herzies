import { createServer } from "node:http";
import { URL } from "node:url";
import type { Herzie } from "@herzies/shared";
import { Box, render, Text, useApp } from "ink";
import open from "open";
import React, { useEffect, useState } from "react";
import { apiGetMe, apiRegisterHerzie } from "../storage/api.js";
import { loadHerzie, saveHerzie, saveSession } from "../storage/state.js";

const CALLBACK_PORT = 8974;

/** Extract user ID from a Supabase JWT (base64url-encoded payload) */
function extractUserId(token: string): string | null {
  try {
    const payload = token.split(".")[1];
    const json = Buffer.from(payload, "base64url").toString();
    const data = JSON.parse(json);
    return data.sub ?? null;
  } catch {
    return null;
  }
}

function LoginApp() {
  const { exit } = useApp();
  const [status, setStatus] = useState<
    "opening" | "waiting" | "syncing" | "success" | "error"
  >("opening");
  const [error, setError] = useState("");
  const [synced, setSynced] = useState<string | null>(null);

  useEffect(() => {
    const server = createServer(async (req, res) => {
      const url = new URL(req.url ?? "/", `http://${req.headers.host}`);

      if (url.pathname === "/callback" && req.method === "POST") {
        // Read POST body containing tokens
        const body = await new Promise<string>((resolve) => {
          let data = "";
          req.on("data", (chunk: Buffer) => {
            data += chunk.toString();
          });
          req.on("end", () => resolve(data));
        });
        const params = new URLSearchParams(body);
        const accessToken = params.get("access_token");
        const refreshToken = params.get("refresh_token");
        const expiresIn = parseInt(params.get("expires_in") ?? "3600", 10);

        if (!accessToken) {
          res.writeHead(200, { "Content-Type": "text/html" });
          res.end("<h1>Login failed. You can close this window.</h1>");
          setError("No token received.");
          setStatus("error");
          server.close();
          setTimeout(() => exit(), 100);
          return;
        }

        const userId = extractUserId(accessToken);
        if (!userId) {
          res.writeHead(200, { "Content-Type": "text/html" });
          res.end("<h1>Login failed. You can close this window.</h1>");
          setError("Could not extract user ID from token.");
          setStatus("error");
          server.close();
          setTimeout(() => exit(), 100);
          return;
        }

        saveSession({
          accessToken,
          refreshToken: refreshToken ?? "",
          expiresAt: Date.now() + expiresIn * 1000,
          userId,
        });

        setStatus("syncing");

        // Pull the user's herzie from the game server
        let herzie = await apiGetMe();
        if (!herzie) {
          // No server-side herzie — register the local one
          const local = loadHerzie();
          if (local) {
            herzie = await apiRegisterHerzie(local);
          }
        }
        if (herzie) {
          saveHerzie(herzie);
          setSynced(herzie.name);
        }

        res.writeHead(200, { "Content-Type": "text/html" });
        res.end("<h1>Logged in! Return to your terminal.</h1>");
        setStatus("success");
        server.close();
        setTimeout(() => exit(), 500);
      }
    });

    server.listen(CALLBACK_PORT, () => {
      setStatus("waiting");
      const authUrl = `${process.env.HERZIES_WEB_URL ?? "https://www.herzies.app"}/auth/cli?port=${CALLBACK_PORT}`;
      open(authUrl);
    });

    setTimeout(() => {
      server.close();
    }, 120000);
  }, []);

  return (
    <Box padding={1} flexDirection="column">
      {status === "opening" && <Text color="yellow">Opening browser...</Text>}
      {status === "waiting" && (
        <Text color="yellow">Waiting for login in your browser...</Text>
      )}
      {status === "syncing" && (
        <Text color="yellow">Syncing your Herzie...</Text>
      )}
      {status === "success" && (
        <Box flexDirection="column">
          <Text color="green" bold>
            Logged in!
          </Text>
          {synced && (
            <Text>
              Synced your Herzie:{" "}
              <Text bold color="cyan">
                {synced}
              </Text>
            </Text>
          )}
        </Box>
      )}
      {status === "error" && <Text color="red">{error}</Text>}
    </Box>
  );
}

export function runLogin() {
  const { waitUntilExit } = render(<LoginApp />);
  waitUntilExit().then(() => process.exit(0));
}
