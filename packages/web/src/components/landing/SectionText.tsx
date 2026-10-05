import { cn } from "@/lib/utils";

/** Every landing section's heading. */
export const SECTION_TITLE =
  "mb-4 text-3xl leading-none font-bold text-purple md:text-5xl";

/** A section's words block: centred, and on phones held well in from the
 * screen's edges. */
export const SECTION_TEXT = "mx-auto max-w-2xl px-6 text-center md:px-0";

/** A landing section's words, centred: a small pre-title, the heading, then
 * the copy. Slides in from `from` with the rest of its section (see
 * useReveal). */
export function SectionText({
  preTitle,
  title,
  children,
  from = "up",
  className,
}: {
  preTitle: string;
  title: string;
  children: React.ReactNode;
  from?: "left" | "right" | "up";
  className?: string;
}) {
  return (
    <div data-reveal={from} className={cn(SECTION_TEXT, className)}>
      <p className="mb-2 text-sm uppercase tracking-widest text-text-dim">
        {preTitle}
      </p>
      <h2 className={SECTION_TITLE}>{title}</h2>
      {/* The copy keeps a reading width under the wider heading. */}
      <div className="mx-auto max-w-md space-y-3 text-sm text-text-dim">
        {children}
      </div>
    </div>
  );
}

/** The full-height frame every landing section sits in. `min-h`, not `h`, so
 * a short phone screen grows the section rather than clipping it. */
export function SectionFrame({
  id,
  className,
  style,
  overlayHeader,
  children,
  ref,
}: {
  id?: string;
  className?: string;
  style?: React.CSSProperties;
  /** Lay the site header over this section rather than above it (see
   * globals.css), for a page whose first section fills the screen. */
  overlayHeader?: boolean;
  children: React.ReactNode;
  ref?: React.Ref<HTMLElement>;
}) {
  return (
    <section
      ref={ref}
      id={id}
      style={style}
      data-overlay-header={overlayHeader ? "" : undefined}
      className={cn(
        "relative flex min-h-dvh w-full items-center overflow-x-clip py-16",
        className,
      )}
    >
      <div className="relative mx-auto w-5xl max-w-full px-4 sm:px-6 md:px-8">
        {children}
      </div>
    </section>
  );
}

/** A section that holds still while you scroll through it: `screens` screens
 * tall, with its content stuck to the viewport the whole way, for a
 * scroll-driven sequence to play out in. */
export function PinnedFrame({
  screens,
  children,
  ref,
}: {
  screens: number;
  children: React.ReactNode;
  ref?: React.Ref<HTMLElement>;
}) {
  return (
    <section
      ref={ref}
      className="relative w-full"
      style={{ height: `${screens * 100}dvh` }}
    >
      <div className="sticky top-0 flex h-dvh w-full items-center overflow-x-clip py-16">
        <div className="relative mx-auto w-5xl max-w-full px-4 sm:px-6 md:px-8">
          {children}
        </div>
      </div>
    </section>
  );
}
