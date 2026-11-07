"use client";

import { ExternalLink, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

/**
 * A local editor (its own dev server on this machine) shown inside the
 * panel. When it isn't running, says how to start it.
 */
export function WorkshopFrame({
  src,
  title,
  command,
}: {
  src: string;
  title: string;
  /** What starts the editor, from the repo root. */
  command: string;
}) {
  const [state, setState] = useState<"checking" | "up" | "down">("checking");

  const check = useCallback(async () => {
    setState("checking");
    // The panel starts the editor when the tab opens: give it a minute to
    // come up before calling it down.
    for (let attempt = 0; attempt < 60; attempt++) {
      try {
        // Opaque, but it only resolves when something answers.
        await fetch(src, { mode: "no-cors", cache: "no-store" });
        setState("up");
        return;
      } catch {
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
    setState("down");
  }, [src]);

  useEffect(() => {
    check();
  }, [check]);

  if (state === "up") {
    return (
      <div className="-m-4 md:-m-6 flex h-[calc(100dvh-3.5rem)] flex-col">
        <iframe src={src} title={title} className="w-full flex-1 border-0" />
      </div>
    );
  }

  return (
    <Card className="max-w-lg">
      <CardHeader>
        <CardTitle>
          {state === "checking" ? title : `${title} didn't start`}
        </CardTitle>
        <CardDescription>
          {state === "checking"
            ? "Starting it..."
            : "Check the dev server's terminal, or start it by hand from the repo root."}
        </CardDescription>
      </CardHeader>
      <CardContent className={state === "down" ? "grid gap-4" : "hidden"}>
        <pre className="rounded-md bg-muted px-3 py-2 font-mono text-xs">
          {command}
        </pre>
        <div className="flex gap-2">
          <Button onClick={check} disabled={state === "checking"}>
            <RefreshCw />
            Check again
          </Button>
          <Button variant="outline" asChild>
            <a href={src} target="_blank" rel="noreferrer">
              <ExternalLink />
              Open in a tab
            </a>
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
