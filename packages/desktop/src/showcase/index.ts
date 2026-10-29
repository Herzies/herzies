/**
 * The website's live Town, built by `pnpm build:showcase` into the web
 * package's public/town. This entry keeps one name (/town/showcase.js) so
 * the page always knows where to find it; the Town itself is a hashed chunk
 * it loads, cached for good.
 *
 *   const { mountTownShowcase } = await import("/town/showcase.js");
 *   const unmount = await mountTownShowcase(el, { server, champion, onReady });
 */
import type { ShowcaseOptions } from "./mount";

export type { ShowcaseOptions } from "./mount";

export async function mountTownShowcase(
  el: HTMLElement,
  opts: ShowcaseOptions = {},
): Promise<() => void> {
  const { mountTownShowcase: mount } = await import("./mount");
  return mount(el, opts);
}
