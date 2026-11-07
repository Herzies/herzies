import type { Metadata } from "next";
import { NotificationsSection } from "../_components/sections";

export const metadata: Metadata = { title: "Notifications" };

export default function Page() {
  return <NotificationsSection />;
}
