"use client";

import { useSearchParams } from "next/navigation";
import { Suspense } from "react";
import { isValidLoginState } from "@/lib/desktop-login";
import { DesktopHandoff } from "../../DesktopHandoff";

function Handoff() {
  const state = useSearchParams().get("state");
  const valid = isValidLoginState(state);
  return <DesktopHandoff valid={valid} state={valid ? state : null} />;
}

export default function DesktopCallbackPage() {
  return (
    <Suspense fallback={<p className="p-8">Loading...</p>}>
      <Handoff />
    </Suspense>
  );
}
