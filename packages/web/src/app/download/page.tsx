import type { Metadata } from "next";
import Container from "@/components/container";
import { DesktopHomePreview } from "@/components/DesktopHomePreview";
import DownloadButtons from "@/components/DownloadButtons";

export const metadata: Metadata = {
  title: "Download Herzies for macOS & Windows",
  description:
    "Download Herzies Desktop for macOS or Windows. A universal build for Apple Silicon and Intel, plus a native Windows build, that works with Apple Music and Spotify.",
  alternates: { canonical: "https://www.herzies.app/download" },
};

const RELEASES_PAGE = "https://github.com/Herzies/herzies/releases/latest";

export default function DownloadPage() {
  return (
    <Container className="py-12 md:py-20">
      <div className="flex flex-col-reverse md:flex-row md:items-center gap-12 md:gap-16">
        {/* CTA */}
        <div className="flex-1 flex flex-col items-center md:items-start text-center md:text-left">
          <span className="mb-3 text-text-dim">Open beta</span>
          <h1 className="text-4xl md:text-5xl lg:text-6xl text-purple mb-4 font-semibold">
            Download
          </h1>
          <p className="text-[13px] text-text-dim max-w-sm leading-snug mb-8">
            Your digital pet that grows by listening to music.
          </p>

          <DownloadButtons />

          <p className="text-[12px] text-text-dim max-w-sm leading-snug mt-5">
            Herzies is in open beta and free to use. Things may break — found a
            bug?{" "}
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
            className="text-xs text-cyan mt-6 hover:underline"
          >
            All releases on GitHub →
          </a>
        </div>

        {/* App preview */}
        <div className="flex-1 flex justify-center">
          <DesktopHomePreview />
        </div>
      </div>
    </Container>
  );
}
