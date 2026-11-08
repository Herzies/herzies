"use client";

import { useSearchParams } from "next/navigation";
import { Suspense } from "react";
import { isLegacyDesktopPort } from "@/lib/desktop-login";
import { DesktopHandoff } from "../../DesktopHandoff";

/** LEGACY — see `/auth/cli`. These builds send no state nonce. */
function Handoff() {
  const valid = isLegacyDesktopPort(useSearchParams().get("cli_port"));
  return <DesktopHandoff valid={valid} state={null} />;
}

export default function LegacyDesktopCallbackPage() {
  return (
    <Suspense fallback={<p className="p-8">Loading...</p>}>
      <Handoff />
    </Suspense>
  );
}
