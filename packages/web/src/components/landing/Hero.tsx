import Link from "next/link";

/** The first screen, over the live Town (see TownBackdrop): the one-line
 * pitch and the download button, just under the statue the camera
 * circles.
 * `data-overlay-header` lays the site header over it and `data-town` the
 * footer (see globals.css): the page fits without scrolling. */
export function Hero() {
  return (
    <section
      data-overlay-header=""
      data-town=""
      className="relative flex flex-1 w-full items-center justify-center overflow-x-clip px-4 py-16 sm:px-6"
    >
      <h1 className="sr-only">
        Herzies — Your digital pet that grows by listening to music
      </h1>

      {/* Just under the statue the camera circles, straight on the Town. */}
      <div className="translate-y-[14vh] text-center [text-shadow:0_1px_3px_rgb(0_0_0/0.55)]">
        <p className="text-[15px] font-bold text-white">
          Your digital pet <br /> that grows by listening to music.
        </p>

        <Link href="/download" className="cta mt-5">
          Download Herzies
          <svg
            className="cta-arrow"
            width="14"
            height="14"
            viewBox="0 0 14 14"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M7 1.5v7.5M3.75 5.75 7 9l3.25-3.25" />
            <path d="M1.75 9.5v1.75c0 .55.45 1 1 1h8.5c.55 0 1-.45 1-1V9.5" />
          </svg>
        </Link>
      </div>
    </section>
  );
}
