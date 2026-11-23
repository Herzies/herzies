import { Analytics } from "@vercel/analytics/next";
import type { Metadata, Viewport } from "next";
import "./globals.css";
import Footer from "@/components/footer";
import Header from "@/components/header";
import { PageLoader } from "@/components/page-loader/PageLoader";

/** The site's colour (theme.css's --color-bg): what iOS Safari draws behind
 * its status bar and toolbar, so they melt into the page. */
export const viewport: Viewport = {
  themeColor: "#0c0c14",
  colorScheme: "dark",
  viewportFit: "cover",
};

export const metadata: Metadata = {
  metadataBase: new URL("https://www.herzies.app"),
  title: {
    default: "Herzies — Your digital pet that grows by listening to music",
    template: "%s | Herzies",
  },
  description:
    "A free desktop pet for macOS and Windows that grows while you listen to music. Works with Spotify, Apple Music, Tidal and more. Collect items, trade, and raid bosses with friends in a live multiplayer Town.",
  keywords: [
    "digital pet",
    "desktop pet",
    "virtual pet",
    "tamagotchi",
    "music game",
    "idle game",
    "macos",
    "windows",
    "apple music",
    "spotify",
    "tidal",
  ],
  openGraph: {
    title: "Herzies — your digital pet that grows by listening to music",
    description:
      "A free desktop pet for macOS and Windows. Play music, level up your herzie, and hang out with other herzies in the Town.",
    siteName: "Herzies",
    type: "website",
    images: [
      {
        url: "/og.png?v=3",
        width: 1200,
        height: 630,
        alt: "Herzies — your digital pet that grows by listening to music",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "Herzies — your digital pet that grows by listening to music",
    description:
      "A free desktop pet for macOS and Windows. Play music, level up your herzie, and hang out with other herzies in the Town.",
    images: ["/og.png?v=3"],
  },
  robots: {
    index: true,
    follow: true,
  },
};

export default async function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className="min-h-dvh flex flex-col justify-between items-start">
        <PageLoader />
        <noscript>
          <style>{"[data-page-loader]{display:none!important}"}</style>
        </noscript>
        <Header />

        <main className="w-full flex-1 overflow-clip">{children}</main>

        <Footer />
        <Analytics />
      </body>
    </html>
  );
}
