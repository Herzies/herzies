"use client";

import type { Session } from "@supabase/supabase-js";
import { useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { createSupabaseClient } from "@/lib/supabase";

/** How long to wait for the OAuth code to be exchanged for a session. */
const SESSION_WAIT_MS = 10_000;

function CallbackHandler() {
  const searchParams = useSearchParams();
  const cliPort = searchParams.get("cli_port");
  const [status, setStatus] = useState<"loading" | "success" | "error">(
    "loading",
  );
  const [error, setError] = useState("");

  useEffect(() => {
    const supabase = createSupabaseClient();

    // Surface explicit errors the provider may redirect back with.
    const params = new URLSearchParams(window.location.search);
    const oauthError =
      params.get("error_description") ?? params.get("error_code");
    if (oauthError) {
      setError(oauthError);
      setStatus("error");
      return;
    }

    let settled = false;

    const forwardSession = (session: Session) => {
      if (settled) return;
      settled = true;

      if (!cliPort) {
        setStatus("success");
        return;
      }

      const form = document.createElement("form");
      form.method = "POST";
      form.action = `http://127.0.0.1:${cliPort}/callback`;

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
      document.body.appendChild(form);
      form.submit();
    };

    // The browser client exchanges the OAuth `code` in the URL for a session
    // asynchronously, emitting an auth event once it completes. We wait for
    // that instead of reading getSession() immediately, which previously raced
    // the exchange and intermittently reported "No session found".
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, session) => {
      if (session) forwardSession(session);
    });

    // When there is no code to exchange (e.g. an already-established session),
    // fall back to the current session right away.
    if (!params.get("code")) {
      supabase.auth.getSession().then(({ data: { session } }) => {
        if (session) forwardSession(session);
      });
    }

    // Give the exchange a bounded amount of time before giving up.
    const timer = setTimeout(async () => {
      if (settled) return;
      const {
        data: { session },
      } = await supabase.auth.getSession();
      if (session) {
        forwardSession(session);
      } else {
        settled = true;
        setError("No session found. Try logging in again.");
        setStatus("error");
      }
    }, SESSION_WAIT_MS);

    return () => {
      subscription.unsubscribe();
      clearTimeout(timer);
    };
  }, [cliPort]);

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

      {status === "success" && (
        <>
          <div>
            <h1 className="text-lg text-green mb-1">you're in</h1>
            <p className="text-xs text-text-dim">logged in successfully</p>
          </div>
          <div className="bg-bg-panel border border-border rounded-md p-5 max-w-[400px]">
            <p className="text-[13px]">
              Run{" "}
              <code className="bg-bg px-1.5 py-0.5 rounded text-xs">
                herzies login
              </code>{" "}
              in your terminal to sync your herzie.
            </p>
          </div>
        </>
      )}
    </main>
  );
}

export default function CLICallbackPage() {
  return (
    <Suspense fallback={<p className="p-8">Loading...</p>}>
      <CallbackHandler />
    </Suspense>
  );
}
