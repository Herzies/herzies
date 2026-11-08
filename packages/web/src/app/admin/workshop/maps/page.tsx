import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { isLocalPanel } from "@/lib/admin-auth";
import { ensureMapEditor, MAP_EDITOR_URL } from "@/lib/workshop-servers";
import { WorkshopFrame } from "../../_components/WorkshopFrame";

export const metadata: Metadata = { title: "Map editor" };
export const dynamic = "force-dynamic";

/** Local only: the editor saves Town maps into the repo. Opening it starts
 * its Vite server (see workshop-servers). */
export default async function Page() {
  if (!isLocalPanel()) notFound();
  await ensureMapEditor();
  return (
    <WorkshopFrame
      src={MAP_EDITOR_URL}
      title="Map editor"
      command="pnpm --filter herzies-desktop map-editor"
    />
  );
}
