import type { Metadata } from "next";
import { SeriesSection } from "../_components/sections";

export const metadata: Metadata = { title: "Series" };

export default function Page() {
  return <SeriesSection />;
}
