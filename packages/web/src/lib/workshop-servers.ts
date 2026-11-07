import { type ChildProcess, spawn } from "node:child_process";
import { connect } from "node:net";
import { resolve } from "node:path";

/*
 * The map editor needs the desktop app's Vite server (its live 3D Town is
 * built from the desktop's source). Opening the Map editor tab in the local
 * control panel starts it as a child of this dev server, so stopping the
 * dev server stops it too.
 */

export const MAP_EDITOR_PORT = 1420;
export const MAP_EDITOR_URL = `http://localhost:${MAP_EDITOR_PORT}/map-editor.html`;

const state = globalThis as typeof globalThis & {
  __herziesMapEditor?: ChildProcess;
};

function listening(port: number): Promise<boolean> {
  return new Promise((done) => {
    const socket = connect({ port, host: "localhost" });
    socket.once("connect", () => {
      socket.destroy();
      done(true);
    });
    socket.once("error", () => done(false));
  });
}

/** Starts the map editor's Vite server unless something is already on its
 * port. Returns at once; the page waits for it to answer. */
export async function ensureMapEditor(): Promise<"running" | "starting"> {
  if (await listening(MAP_EDITOR_PORT)) return "running";
  const child = state.__herziesMapEditor;
  if (child && child.exitCode === null) return "starting";

  const root = resolve(process.cwd(), "../..");
  const vite = spawn(
    "pnpm",
    [
      "--filter",
      "herzies-desktop",
      "exec",
      "vite",
      "dev",
      "--port",
      String(MAP_EDITOR_PORT),
      "--strictPort",
    ],
    { cwd: root, stdio: ["ignore", "inherit", "inherit"] },
  );
  vite.on("exit", () => {
    if (state.__herziesMapEditor === vite) state.__herziesMapEditor = undefined;
  });
  state.__herziesMapEditor = vite;
  process.once("exit", () => vite.kill());
  return "starting";
}
