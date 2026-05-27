"use client";

import { useState } from "react";

export function CopyBlock({ command }: { command: string }) {
  const [copied, setCopied] = useState(false);

  const handleClick = async () => {
    await navigator.clipboard.writeText(command);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div
      onClick={handleClick}
      className="bg-bg-panel border border-border rounded-md p-4 cursor-pointer relative"
    >
      <code className="text-[13px]">
        <span className="text-text-dim">$ </span>
        {command}
      </code>
      <span
        className={`absolute right-4 top-1/2 -translate-y-1/2 text-[11px] ${
          copied ? "text-green" : "text-text-dim"
        }`}
      >
        {copied ? "copied!" : "click to copy"}
      </span>
    </div>
  );
}
