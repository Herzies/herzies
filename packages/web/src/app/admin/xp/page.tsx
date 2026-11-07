import type { Metadata } from "next";
import { XpSection } from "../_components/sections";

export const metadata: Metadata = { title: "XP" };

export default function Page() {
  return <XpSection />;
}
