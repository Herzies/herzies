import { NextResponse } from "next/server";

const RELEASES_API =
  "https://api.github.com/repos/Herzies/herzies/releases/latest";
const RELEASES_PAGE = "https://github.com/Herzies/herzies/releases/latest";

interface ReleaseAsset {
  name: string;
  browser_download_url: string;
}

/**
 * Resolve and redirect to the latest universal macOS DMG. The release asset is
 * version-stamped (e.g. `Herzies_0.1.0-beta.23_universal.dmg`), so there's no
 * stable filename to link directly — we look it up via the GitHub API instead.
 * The lookup is cached to stay under the unauthenticated rate limit, and we
 * fall back to the releases page if anything goes wrong.
 */
export async function GET() {
  try {
    const res = await fetch(RELEASES_API, {
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": "herzies-web",
      },
      next: { revalidate: 3600 },
    });

    if (res.ok) {
      const release = (await res.json()) as { assets?: ReleaseAsset[] };
      const assets = release.assets ?? [];
      const dmg =
        assets.find((a) => /universal.*\.dmg$/i.test(a.name)) ??
        assets.find((a) => a.name.toLowerCase().endsWith(".dmg"));
      if (dmg) {
        return NextResponse.redirect(dmg.browser_download_url, 302);
      }
    }
  } catch {
    // Fall through to the releases page below.
  }

  return NextResponse.redirect(RELEASES_PAGE, 302);
}
