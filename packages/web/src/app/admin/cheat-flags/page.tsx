import type { Metadata } from "next";
import { CheatFlagsSection } from "../_components/sections";

export const metadata: Metadata = { title: "Cheat flags" };

export default function Page() {
  return <CheatFlagsSection />;
}
