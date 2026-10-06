"use client";

import { useEffect, useState } from "react";
import { DESKTOP_CALLBACK_URL } from "@/lib/desktop-login";
import { getDesktopLoginClient } from "@/lib/supabase";

/** How long to wait for the OAuth code to be exchanged for a session. */
const SESSION_WAIT_MS = 10_000;

/**
 * Where OAuth lands for a desktop login: waits for the code exchange, then
 * POSTs the new session to the app's loopback listener.
 *
 * It only runs with a `code` to exchange — there is no "already signed in,
 * forward that" shortcut — and only ever posts to the fixed loopback
 * address, never to anything taken from the URL.
 *
 * `valid` is false for a malformed link; `state` is echoed back to the app,
 * which rejects a callback that doesn't carry the nonce it issued (null for
 * legacy builds, which send none).
 */
export function DesktopHandoff({
  valid,
  state,
}: {
  valid: boolean;
  state: string | null;
}) {
  const [status, setStatus] = useState<"loading" | "error">("loading");
  const [error, setError] = useState("");

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    // Surface explicit errors the provider may redirect back with.
    const oauthError =
      params.get("error_description") ?? params.get("error_code");
    if (oauthError) {
      setError(oauthError);
      setStatus("error");
      return;
    }
    if (!valid || !params.get("code")) {
      setError("This sign-in link is invalid. Start the login from the app.");
      setStatus("error");
      return;
    }

    const supabase = getDesktopLoginClient();
    let settled = false;

    const forwardSession = (session: {
      access_token: string;
      refresh_token: string;
      expires_in?: number;
    }) => {
      if (settled) return;
      settled = true;

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
    };

    // The browser client exchanges the `code` in the URL while it
    // initializes. A subscriber registered now hears SIGNED_IN when that
    // exchange lands, or INITIAL_SESSION carrying its result if it had
    // already finished. Reading getSession() up front instead raced the
    // exchange and intermittently reported "No session found".
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((event, session) => {
      if (session && (event === "SIGNED_IN" || event === "INITIAL_SESSION")) {
        forwardSession(session);
      }
    });

    // Give the exchange a bounded amount of time before giving up.
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      setError("No session found. Try logging in again.");
      setStatus("error");
    }, SESSION_WAIT_MS);

    return () => {
      subscription.unsubscribe();
      clearTimeout(timer);
    };
  }, [valid, state]);

  return (
    <main className="w-full max-w-[360px] px-6 flex flex-col gap-4 text-center">
      {status === "loading" && (
        <>
          <div>
            <h1 className="text-lg text-purple mb-1">logging in</h1>
            <p className="text-xs text-text-dim">hang tight...</p>
          </div>
          <div className="bg-bg-panel border border-border rounded-md p-5 max-w-[400px]">
            <p className="text-[13px] text-text-dim">...</p>
          </div>
        </>
      )}

      {status === "error" && (
        <>
          <div>
            <h1 className="text-lg text-red mb-1">something went wrong</h1>
            <p className="text-xs text-text-dim">login failed</p>
          </div>
          <div className="bg-bg-panel border border-red rounded-md p-5 max-w-[400px]">
            <p className="text-[13px] text-red">{error}</p>
          </div>
        </>
      )}
    </main>
  );
}
