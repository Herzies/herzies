import type { Metadata } from "next";
import { GrantSection } from "../_components/sections";

export const metadata: Metadata = { title: "Grant item" };

export default function Page() {
  return <GrantSection />;
}
