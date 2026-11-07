import type { Metadata } from "next";
import { EventsSection } from "../_components/sections";

export const metadata: Metadata = { title: "Events" };

export default function Page() {
  return <EventsSection />;
}
