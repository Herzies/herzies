import type { Metadata } from "next";
import { GameAdmin } from "./GameAdmin";

export const metadata: Metadata = {
  title: "Game Admin",
  robots: { index: false, follow: false },
};

export default function DevAdminPage() {
  return (
    <div className="max-w-5xl mx-auto px-6 py-8">
      <h1 className="text-lg text-purple mb-2">game admin</h1>
      <GameAdmin />
    </div>
  );
}
