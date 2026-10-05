"use client";

import { useSearchParams } from "next/navigation";
import { Suspense } from "react";
import { isLegacyDesktopPort } from "@/lib/desktop-login";
import { DesktopSignIn } from "../DesktopSignIn";

/**
 * LEGACY — desktop builds up to beta.45 open `/auth/cli?port=8974`; current
 * builds use `/auth/desktop`. Delete this and `/auth/callback/cli` once
 * nobody is on those builds.
 */
function SignIn() {
  const port = useSearchParams().get("port");
  return (
    <DesktopSignIn
      callbackPath={
        isLegacyDesktopPort(port) ? `/auth/callback/cli?cli_port=${port}` : null
      }
    />
  );
}

export default function LegacyDesktopAuthPage() {
  return (
    <Suspense fallback={<p className="p-8">Loading...</p>}>
      <SignIn />
    </Suspense>
  );
}
