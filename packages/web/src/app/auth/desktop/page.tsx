"use client";

import { useSearchParams } from "next/navigation";
import { Suspense } from "react";
import { isValidLoginState } from "@/lib/desktop-login";
import { DesktopSignIn } from "../DesktopSignIn";

/** Opened by the desktop app as `/auth/desktop?state=<nonce>`. */
function SignIn() {
  const state = useSearchParams().get("state");
  return (
    <DesktopSignIn
      callbackPath={
        isValidLoginState(state)
          ? `/auth/desktop/callback?${new URLSearchParams({ state })}`
          : null
      }
    />
  );
}

export default function DesktopAuthPage() {
  return (
    <Suspense fallback={<p className="p-8">Loading...</p>}>
      <SignIn />
    </Suspense>
  );
}
