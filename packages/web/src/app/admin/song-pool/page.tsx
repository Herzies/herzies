import type { Metadata } from "next";
import { SongPoolSection } from "../_components/sections";

export const metadata: Metadata = { title: "Song pool" };

export default function Page() {
  return <SongPoolSection />;
}
