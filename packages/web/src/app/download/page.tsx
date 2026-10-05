import type { Metadata } from "next";
import { DownloadSection } from "@/components/landing/DownloadSection";

export const metadata: Metadata = {
  title: "Download Herzies for macOS & Windows",
  description:
    "Download Herzies Desktop for macOS or Windows. A universal build for Apple Silicon and Intel, plus a native Windows build, that works with Apple Music and Spotify.",
  alternates: { canonical: "https://www.herzies.app/download" },
};

const RELEASES_PAGE = "https://github.com/Herzies/herzies/releases/latest";

export default function DownloadPage() {
  return (
    <DownloadSection page>
      <p className="mx-auto mt-5 max-w-sm text-[12px] leading-snug text-text-dim">
        Things may break. Found a bug?{" "}
        <a
          href="https://github.com/Herzies/herzies/issues"
          target="_blank"
          rel="noopener noreferrer"
          className="text-cyan hover:underline"
        >
          Let us know
        </a>
        .
      </p>
      <a
        href={RELEASES_PAGE}
        target="_blank"
        rel="noopener noreferrer"
        className="mt-4 text-xs text-cyan hover:underline"
      >
        All releases on GitHub →
      </a>
    </DownloadSection>
  );
}
