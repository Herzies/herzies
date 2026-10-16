/**
 * Browser → desktop app login handoff.
 *
 * The desktop app listens on a fixed loopback port and opens
 * `/auth/desktop?state=…` in the browser; after OAuth the browser POSTs the
 * session to that port along with the same `state`, which the app checks.
 *
 * The destination is a constant on purpose. It used to be built from a
 * `cli_port` query parameter, and `cli_port=1@evil.com/x?` turned
 * `http://127.0.0.1:${port}/callback` into a URL on evil.com — one link was
 * enough to post a signed-in visitor's tokens to an attacker.
 */
export const DESKTOP_LOGIN_PORT = 8974;
export const DESKTOP_CALLBACK_URL = `http://127.0.0.1:${DESKTOP_LOGIN_PORT}/callback`;

/** The nonce the desktop app generates for one login attempt: 32 hex chars. */
export function isValidLoginState(state: string | null): state is string {
  return !!state && /^[0-9a-f]{32}$/.test(state);
}

/**
 * Desktop builds up to beta.45 open `/auth/cli?port=8974` and send no state.
 * Only that exact port is honoured for them.
 */
export function isLegacyDesktopPort(port: string | null): boolean {
  return port === String(DESKTOP_LOGIN_PORT);
}

/** POSTs a session to the desktop app's loopback listener, with the
 * attempt's `state` (null for legacy builds, which send none). Navigates
 * away: the app answers the POST with its own page. */
export function postSessionToDesktop(
  session: { access_token: string; refresh_token: string; expires_in?: number },
  state: string | null,
): void {
  const form = document.createElement("form");
  form.method = "POST";
  form.action = DESKTOP_CALLBACK_URL;

  const addField = (name: string, value: string) => {
    const input = document.createElement("input");
    input.type = "hidden";
    input.name = name;
    input.value = value;
    form.appendChild(input);
  };

  addField("access_token", session.access_token);
  addField("refresh_token", session.refresh_token);
  addField("expires_in", String(session.expires_in ?? 3600));
  if (state) addField("state", state);
  document.body.appendChild(form);
  form.submit();
}

/** A dev server pointed at a local Supabase stack (scripts/local.sh): the
 * only place the password sign-in exists, since OAuth isn't set up there. */
export function isLocalSupabase(): boolean {
  if (process.env.NODE_ENV === "production") return false;
  try {
    const { hostname } = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "");
    return hostname === "127.0.0.1" || hostname === "localhost";
  } catch {
    return false;
  }
}
