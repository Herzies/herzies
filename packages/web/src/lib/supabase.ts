import { createBrowserClient } from "@supabase/ssr";
import { createClient, type SupportedStorage } from "@supabase/supabase-js";

export function createSupabaseClient() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
  );
}

/**
 * Storage for a desktop app login: the PKCE code verifier goes to
 * sessionStorage so it survives the same-tab OAuth round trip; everything
 * else, including the session, only ever lives in memory.
 */
function desktopLoginStorage(): SupportedStorage {
  const memory = new Map<string, string>();
  const persisted = (key: string) => key.endsWith("-code-verifier");
  return {
    getItem(key) {
      if (!persisted(key)) return memory.get(key) ?? null;
      try {
        return window.sessionStorage.getItem(key);
      } catch {
        return null;
      }
    },
    setItem(key, value) {
      if (!persisted(key)) return void memory.set(key, value);
      try {
        window.sessionStorage.setItem(key, value);
      } catch {}
    },
    removeItem(key) {
      if (!persisted(key)) return void memory.delete(key);
      try {
        window.sessionStorage.removeItem(key);
      } catch {}
    },
  };
}

let desktopLoginClient: ReturnType<typeof createClient> | undefined;

/**
 * Client for signing in on behalf of the desktop app, kept apart from the
 * website's cookie session. One per page: the session lives in its memory,
 * so a second client (e.g. StrictMode re-running an effect) would race the
 * first to exchange the single-use code.
 *
 * It used to be the website's cookie client, so the session handed to the
 * app also stayed in the browser's cookies and the two shared one refresh
 * token. Once one side rotated it and the other presented the old one,
 * Supabase's reuse detection likely revoked the session, logging the app
 * out. And whenever auth-js clears a dead session (the middleware's
 * `getUser()` runs on every page) it deletes the PKCE code verifier too,
 * which likely left the next login's callback with a `code` it couldn't
 * exchange, sitting on "hang tight" until the login was retried.
 */
export function getDesktopLoginClient() {
  desktopLoginClient ??= createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      auth: {
        flowType: "pkce",
        storageKey: "herzies-desktop-login",
        storage: desktopLoginStorage(),
        persistSession: true,
        autoRefreshToken: false,
        detectSessionInUrl: true,
      },
    },
  );
  return desktopLoginClient;
}
