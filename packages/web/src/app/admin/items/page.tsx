import type { Metadata } from "next";
import { isLocalPanel } from "@/lib/admin-auth";
import { ItemsWorkbench } from "./_workbench/ItemsWorkbench";

export const metadata: Metadata = { title: "Items" };

export default function Page() {
  return <ItemsWorkbench local={isLocalPanel()} />;
}
