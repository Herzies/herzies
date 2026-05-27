import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { createAdminClient } from "@/lib/supabase-admin";
import { createServerClient } from "@/lib/supabase-server";
import { SpotifyCard } from "./SpotifyCard";

export const metadata: Metadata = {
  title: "Dashboard",
  robots: { index: false, follow: false },
};

export default async function DashboardPage() {
  const supabase = await createServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) redirect("/login");

  const admin = createAdminClient();
  const { data: connection } = await admin
    .from("spotify_connections")
    .select("display_name, spotify_user_id")
    .eq("user_id", user.id)
    .maybeSingle();

  return (
    <main className="max-w-[800px] mx-auto px-6 py-8">
      <h1 className="text-lg text-purple mb-6">dashboard</h1>

      <SpotifyCard connection={connection} />

      <form action="/auth/logout" method="POST" className="mt-8">
        <button
          type="submit"
          className="bg-transparent border-0 text-text-dim font-[inherit] text-xs cursor-pointer p-0"
        >
          sign out
        </button>
      </form>
    </main>
  );
}
