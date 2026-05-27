"use client";

import { useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";
import { createSupabaseClient } from "@/lib/supabase";

function AuthForm() {
  const searchParams = useSearchParams();
  const port = searchParams.get("port");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  async function handleOAuthLogin(provider: "github" | "google") {
    setError("");
    setLoading(true);

    const supabase = createSupabaseClient();
    const redirectTo = port
      ? `${window.location.origin}/auth/callback/cli?cli_port=${port}`
      : `${window.location.origin}/auth/callback`;

    const { error } = await supabase.auth.signInWithOAuth({
      provider,
      options: { redirectTo },
    });

    if (error) {
      setError(error.message);
      setLoading(false);
    }
  }

  return (
    <main className="w-full max-w-[360px] px-6 flex flex-col gap-4">
      <div className="text-center mb-2">
        <h1 className="text-lg text-purple mb-1">sign in to herzies</h1>
        <p className="text-xs text-text-dim">
          {port
            ? "authorize the CLI to access your account"
            : "sign in to your account"}
        </p>
      </div>

      <div className="bg-bg-panel border border-border rounded-md p-5 flex flex-col gap-4">
        {error && <p className="text-red text-xs">{error}</p>}

        <button
          type="button"
          onClick={() => handleOAuthLogin("google")}
          disabled={loading}
          className="w-full py-2.5 bg-text text-bg border-0 rounded font-[inherit] font-bold text-[13px] cursor-pointer disabled:cursor-default disabled:opacity-60 flex items-center justify-center gap-2"
        >
          <svg
            width="16"
            height="16"
            viewBox="0 0 16 16"
            fill="none"
            aria-hidden="true"
          >
            <path
              d="M15.68 8.18c0-.567-.05-1.113-.145-1.636H8v3.094h4.305a3.68 3.68 0 01-1.597 2.415v2.007h2.585c1.513-1.393 2.387-3.443 2.387-5.88z"
              fill="#4285F4"
            />
            <path
              d="M8 16c2.16 0 3.97-.716 5.293-1.94l-2.585-2.008c-.716.48-1.633.763-2.708.763-2.083 0-3.846-1.407-4.476-3.298H.867v2.073A7.997 7.997 0 008 16z"
              fill="#34A853"
            />
            <path
              d="M3.524 9.517A4.81 4.81 0 013.273 8c0-.526.09-1.037.251-1.517V4.41H.867A7.997 7.997 0 000 8c0 1.29.31 2.512.867 3.59l2.657-2.073z"
              fill="#FBBC05"
            />
            <path
              d="M8 3.185c1.174 0 2.229.403 3.058 1.196l2.294-2.294C11.967.792 10.157 0 8 0A7.997 7.997 0 00.867 4.41l2.657 2.073C4.154 4.592 5.917 3.185 8 3.185z"
              fill="#EA4335"
            />
          </svg>
          {loading ? "redirecting..." : "sign in with Google"}
        </button>

        <button
          type="button"
          onClick={() => handleOAuthLogin("github")}
          disabled={loading}
          className="w-full py-2.5 bg-transparent text-text border border-border rounded font-[inherit] font-bold text-[13px] cursor-pointer disabled:cursor-default disabled:opacity-60 flex items-center justify-center gap-2"
        >
          <svg
            width="16"
            height="16"
            viewBox="0 0 16 16"
            fill="currentColor"
            aria-hidden="true"
          >
            <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
          </svg>
          {loading ? "redirecting..." : "sign in with GitHub"}
        </button>

        <p className="text-[11px] text-text-dim">
          by signing in, you agree to the{" "}
          <a href="/terms" target="_blank" className="text-cyan" rel="noopener">
            terms of service
          </a>
        </p>
      </div>
    </main>
  );
}

export default function CLIAuthPage() {
  return (
    <Suspense fallback={<p className="p-8">Loading...</p>}>
      <AuthForm />
    </Suspense>
  );
}
