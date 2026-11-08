import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { redirect } from "next/navigation";
import "./admin.css";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { adminUserIds, isLocalPanel } from "@/lib/admin-auth";
import { createServerClient } from "@/lib/supabase-server";
import { AdminShell } from "./_components/AdminShell";

const geistSans = Geist({ subsets: ["latin"], variable: "--font-geist-sans" });
const geistMono = Geist_Mono({
  subsets: ["latin"],
  variable: "--font-geist-mono",
});

export const metadata: Metadata = {
  title: { default: "Control panel", template: "%s | Herzies control panel" },
  robots: { index: false, follow: false },
};

/**
 * The control panel's own root layout (the public site's lives in (site)),
 * so none of the site's header, footer or styles come along.
 *
 * Signed-in admins (ADMIN_USER_IDS) get in. On a local dev server anyone
 * may open the shell, and the panel asks for GAME_ADMIN_SECRET when the
 * API turns it away; on Vercel it's sign in or nothing.
 */
export default async function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const local = isLocalPanel();
  const supabase = await createServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  const isAdmin = !!user && adminUserIds().has(user.id);

  if (!isAdmin && !local && !user) redirect("/login?next=/admin");

  return (
    <html
      lang="en"
      className={`dark ${geistSans.variable} ${geistMono.variable}`}
    >
      <body>
        {isAdmin || local ? (
          <TooltipProvider>
            <AdminShell local={local} email={isAdmin ? user.email : null}>
              {children}
            </AdminShell>
          </TooltipProvider>
        ) : (
          <main className="min-h-dvh grid place-items-center text-sm text-muted-foreground">
            404 | This page could not be found.
          </main>
        )}
        <Toaster />
      </body>
    </html>
  );
}
