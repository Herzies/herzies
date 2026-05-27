import { createServer } from "node:http";
import { URL } from "node:url";
import open from "open";
import { saveSession } from "../storage/state.js";

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

/** Open browser for auth and wait for the callback. Returns true on success. */
export function waitForLogin(): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer(async (req, res) => {
      const url = new URL(req.url ?? "/", `http://${req.headers.host}`);

      if (url.pathname === "/callback" && req.method === "POST") {
        const body = await new Promise<string>((r) => {
          let data = "";
          req.on("data", (chunk: Buffer) => {
            data += chunk.toString();
          });
          req.on("end", () => r(data));
        });
        const params = new URLSearchParams(body);
        const accessToken = params.get("access_token");
        const refreshToken = params.get("refresh_token");
        const expiresIn = parseInt(params.get("expires_in") ?? "3600", 10);

        if (!accessToken) {
          res.writeHead(200, { "Content-Type": "text/html" });
          res.end("<h1>Login failed. You can close this window.</h1>");
          server.close();
          resolve(false);
          return;
        }

        const userId = extractUserId(accessToken);
        if (!userId) {
          res.writeHead(200, { "Content-Type": "text/html" });
          res.end("<h1>Login failed. You can close this window.</h1>");
          server.close();
          resolve(false);
          return;
        }

        saveSession({
          accessToken,
          refreshToken: refreshToken ?? "",
          expiresAt: Date.now() + expiresIn * 1000,
          userId,
        });

        res.writeHead(200, { "Content-Type": "text/html" });
        res.end("<h1>Logged in! Return to your terminal.</h1>");
        server.close();
        resolve(true);
      }
    });

    server.listen(CALLBACK_PORT, () => {
      const authUrl = `${process.env.HERZIES_WEB_URL ?? "https://www.herzies.app"}/auth/cli?port=${CALLBACK_PORT}`;
      open(authUrl);
    });

    // Timeout after 2 minutes
    setTimeout(() => {
      server.close();
      resolve(false);
    }, 120000);
  });
}
