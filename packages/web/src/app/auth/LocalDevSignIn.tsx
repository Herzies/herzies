"use client";

import { useState } from "react";
import { postSessionToDesktop } from "@/lib/desktop-login";
import { getDesktopLoginClient } from "@/lib/supabase";

/** Every local test account shares it: the stack is on this machine only. */
const LOCAL_PASSWORD = "herzies-local-dev";

/**
 * Sign-in for a local Supabase stack (scripts/local.sh), where OAuth isn't
 * set up: any email, created on first use, handed to the app like an OAuth
 * login. Rendered only when `isLocalSupabase()`.
 */
export function LocalDevSignIn({ state }: { state: string | null }) {
  const [email, setEmail] = useState("dev@herzies.local");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function signIn(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setBusy(true);
    const supabase = getDesktopLoginClient();
    const creds = { email: email.trim(), password: LOCAL_PASSWORD };
    let { data, error } = await supabase.auth.signInWithPassword(creds);
    if (error) {
      // No such account yet: make it (local email needs no confirmation).
      const up = await supabase.auth.signUp(creds);
      data = { session: up.data.session, user: up.data.user } as typeof data;
      error = up.error;
    }
    if (error || !data.session) {
      setError(error?.message ?? "No session");
      setBusy(false);
      return;
    }
    postSessionToDesktop(data.session, state);
  }

  return (
    <form
      onSubmit={signIn}
      className="bg-bg-panel border border-yellow/40 rounded-md p-4 flex flex-col gap-2"
    >
      <p className="text-[11px] text-yellow">
        local stack: sign in with any email
      </p>
      <input
        type="email"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        className="w-full px-2 py-1.5 bg-transparent border border-border rounded text-[13px] font-[inherit]"
      />
      {error && <p className="text-red text-xs">{error}</p>}
      <button
        type="submit"
        disabled={busy || !email.trim()}
        className="w-full py-2 bg-yellow text-bg border-0 rounded font-[inherit] font-bold text-[13px] cursor-pointer disabled:opacity-60"
      >
        {busy ? "signing in..." : "sign in locally"}
      </button>
    </form>
  );
}
