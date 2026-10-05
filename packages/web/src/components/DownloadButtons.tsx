import Button from "@/components/button";

/** The macOS and Windows download buttons, with the builds' small print —
 * on the download page and at the bottom of the homepage. */
export default function DownloadButtons() {
  return (
    <>
      <div className="flex flex-col sm:flex-row items-center gap-3">
        <a
          href="/api/download"
          className="inline-block no-underline hover:no-underline"
        >
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
            macOS
          </Button>
        </a>

        <a
          href="/api/download?platform=windows"
          className="inline-block no-underline hover:no-underline"
        >
          <Button className="text-base px-6 py-3 bg-transparent text-purple border border-purple">
            <svg
              width="16"
              height="16"
              viewBox="0 0 448 512"
              fill="currentColor"
              aria-hidden="true"
            >
              <path d="M0 93.7l183.6-25.3v177.4H0V93.7zm0 324.6l183.6 25.3V268.4H0v149.9zm203.8 28L448 480V268.4H203.8v177.9zm0-380.6v180.1H448V32L203.8 65.7z" />
            </svg>
            Windows
          </Button>
        </a>
      </div>

      <p className="text-[11px] text-text-dim mt-3">
        macOS: Universal · Apple Silicon &amp; Intel · macOS 10.15+
        <br />
        Windows: 64-bit
      </p>
    </>
  );
}
