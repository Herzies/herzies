"use client";

import { useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { createSupabaseClient } from "@/lib/supabase";

function CallbackHandler() {
  const searchParams = useSearchParams();
  const cliPort = searchParams.get("cli_port");
  const [status, setStatus] = useState<"loading" | "success" | "error">(
    "loading",
  );
  const [error, setError] = useState("");

  useEffect(() => {
    async function handleCallback() {
      const supabase = createSupabaseClient();

      const {
        data: { session },
        error,
      } = await supabase.auth.getSession();

      if (error || !session) {
        setError(error?.message ?? "No session found. Try logging in again.");
        setStatus("error");
        return;
      }

      if (cliPort) {
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
      } else {
        setStatus("success");
      }
    }

    handleCallback();
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
