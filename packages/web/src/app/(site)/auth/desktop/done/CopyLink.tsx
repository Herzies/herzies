"use client";

import { useEffect, useState } from "react";

/** The link to pass on, and a button that copies it. */
export function CopyLink({ url }: { url: string }) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(timer);
  }, [copied]);

  async function copy() {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
    } catch {
      // No clipboard (permissions, old browser): the link is there to select.
    }
  }

  return (
    <div className="flex items-stretch gap-2">
      <input
        readOnly
        value={url.replace(/^https:\/\//, "")}
        aria-label="Link to Herzies"
        onFocus={(e) => e.currentTarget.select()}
        className="min-w-0 flex-1 rounded border border-border bg-bg px-3 py-2 font-[inherit] text-[13px] text-cyan outline-none focus:border-cyan"
      />
      <button
        type="button"
        onClick={copy}
        className="shrink-0 rounded bg-text px-4 font-[inherit] text-[13px] font-bold text-bg cursor-pointer"
      >
        {copied ? "copied!" : "copy link"}
      </button>
    </div>
  );
}
