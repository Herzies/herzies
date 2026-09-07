import { Analytics } from "@vercel/analytics/next";
import type { Metadata } from "next";
import "./globals.css";
import Footer from "@/components/footer";
import Header from "@/components/header";

export const metadata: Metadata = {
  metadataBase: new URL("https://www.herzies.app"),
  title: {
    default: "Herzies — Your digital pet that grows by listening to music",
    template: "%s | Herzies",
  },
  description:
    "Hatch your herzie, play music, and watch it evolve. A terminal-based digital pet powered by your listening habits. Works with Apple Music and Spotify on macOS and Windows.",
  keywords: [
    "cli",
    "digital pet",
    "music",
    "terminal",
    "macos",
    "windows",
    "apple music",
    "spotify",
  ],
  openGraph: {
    title: "Herzies",
    description: "Your digital pet that grows by listening to music.",
    siteName: "Herzies",
    type: "website",
    url: "https://www.herzies.app",
    images: [
      {
        url: "/og.png",
        width: 1200,
        height: 630,
        alt: "Herzies — your digital pet that grows by listening to music",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "Herzies",
    description: "Your digital pet that grows by listening to music.",
    images: ["/og.png"],
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
      <body className="min-h-screen flex flex-col justify-between items-start">
        <Header />

        <main className="w-full flex-1 overflow-clip">{children}</main>

        <Footer />
        <Analytics />
      </body>
    </html>
  );
}
