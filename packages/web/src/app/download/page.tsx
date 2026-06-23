import type { Metadata } from "next";
import Button from "@/components/button";
import Container from "@/components/container";
import { DesktopHomePreview } from "@/components/DesktopHomePreview";

export const metadata: Metadata = {
  title: "Download Herzies for macOS",
  description:
    "Download Herzies Desktop for macOS. A universal build for Apple Silicon and Intel that works with Apple Music and Spotify.",
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

          <a href="/api/download" className="inline-block">
            <Button className="text-base px-6 py-3">
              <svg
                width="15"
                height="18"
                viewBox="0 0 384 512"
                fill="currentColor"
                aria-hidden="true"
              >
                <path d="M318.7 268.7c-.2-36.7 16.4-64.4 50-84.8-18.8-26.9-47.2-41.7-84.7-44.6-35.5-2.8-74.3 20.7-88.5 20.7-15 0-49.4-19.7-76.4-19.7C63.3 141.2 4 184.8 4 273.5q0 39.3 14.4 81.2c12.8 36.7 59 126.7 107.2 125.2 25.2-.6 43-17.9 75.8-17.9 31.8 0 48.3 17.9 76.4 17.9 48.6-.7 90.4-82.5 102.6-119.3-65.2-30.7-61.7-90-61.7-91.9zm-56.6-164.2c27.3-32.4 24.8-61.9 24-72.5-24.1 1.4-52 16.4-67.9 34.9-17.5 19.8-27.8 44.3-25.6 71.9 26.1 2 49.9-11.4 69.5-34.3z" />
              </svg>
              Download for macOS
            </Button>
          </a>

          <p className="text-[11px] text-text-dim mt-3">
            Universal · Apple Silicon &amp; Intel · macOS 10.15+
          </p>

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
