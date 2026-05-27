"use client";

import Link from "next/link";
import { useState } from "react";
import Button from "./button";
import { Input } from "./input";

type Status =
  | { kind: "idle" }
  | { kind: "submitting" }
  | { kind: "success" }
  | { kind: "error"; message: string };

export default function BetaLeadForm() {
  const [email, setEmail] = useState("");
  const [status, setStatus] = useState<Status>({ kind: "idle" });

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (status.kind === "submitting") return;

    const trimmed = email.trim();
    if (!trimmed) {
      setStatus({ kind: "error", message: "Please enter your email." });
      return;
    }

    setStatus({ kind: "submitting" });
    try {
      const res = await fetch("/api/lead", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: trimmed }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as {
          error?: string;
        } | null;
        setStatus({
          kind: "error",
          message: body?.error ?? "Something went wrong. Try again.",
        });
        return;
      }
      setStatus({ kind: "success" });
      setEmail("");
    } catch {
      setStatus({ kind: "error", message: "Network error. Try again." });
    }
  }

  const isSubmitting = status.kind === "submitting";
  const isSuccess = status.kind === "success";

  return (
    <>
      <div className="rounded-lg overflow-hidden border border-border w-full p-4 md:p-6 lg:p-12 lg:py-24">
        <div className="flex flex-col items-center text-center">
          <p className="text-sm text-text-dim mb-2 uppercase tracking-widest">
            Your herzie is waiting
          </p>
          <h2 className="text-4xl md:text-5xl lg:text-6xl text-purple mb-1 font-semibold">
            Early access
          </h2>
          <p className="text-[12px] text-text-dim mb-4 leading-snug mt-6">
            Drop your email and we'll let you know when we're ready.
          </p>

          {isSuccess ? (
            <p className="text-cyan text-sm mt-2" role="status">
              You're on the list. We'll be in touch.
            </p>
          ) : (
            <form
              className="flex flex-col md:flex-row gap-2 w-xl max-w-full"
              onSubmit={handleSubmit}
            >
              <Input
                type="email"
                placeholder="your@email.com"
                value={email}
                onChange={setEmail}
              />
              <Button
                type="submit"
                className="shrink-0 w-full md:w-auto"
                disabled={isSubmitting}
              >
                {isSubmitting ? "Sending…" : "Let me in!"}
              </Button>
            </form>
          )}

          {status.kind === "error" && (
            <p className="text-red-400 text-xs mt-3" role="alert">
              {status.message}
            </p>
          )}
        </div>
      </div>

      <p className="text-[10px] text-text-dim mt-3 leading-snug text-center">
        By submitting, you agree to our{" "}
        <Link href="/terms" className="text-cyan">
          terms
        </Link>
        . A CLI preview is available on{" "}
        <a
          target="_blank"
          rel="noopener noreferrer"
          href="https://www.npmjs.com/package/herzies"
          className="text-cyan"
        >
          npm
        </a>
        .
      </p>
    </>
  );
}
