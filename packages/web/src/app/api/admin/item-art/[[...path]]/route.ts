import { NextResponse } from "next/server";
import { isLocalPanel, unauthorizedAdmin, verifyAdmin } from "@/lib/admin-auth";
import {
  ArtError,
  deleteArtwork,
  deleteCardArt,
  readCardArtFile,
  readItemArt,
  saveArtwork,
  saveCardArtRender,
  saveCardArtSource,
  saveIcon,
  saveItemText,
} from "@/lib/item-art";

/*
 * The item art workshop's API (local dev only: it writes into the repo).
 *
 *   GET    /api/admin/item-art                          everything the editor shows
 *   GET    /api/admin/item-art/file/{file|source}/NAME  a card image or original
 *   POST   /api/admin/item-art/ID/text                  name + description (items.ts)
 *   POST   /api/admin/item-art/ID/icon                  icon grid
 *   POST   /api/admin/item-art/ID/artwork               card artwork grid
 *   DELETE /api/admin/item-art/ID/artwork               back to the icon's
 *   PUT    /api/admin/item-art/ID/card-art/source       new original (raw image body)
 *   PUT    /api/admin/item-art/ID/card-art/render?settings=JSON  finished image
 *   DELETE /api/admin/item-art/ID/card-art              remove the illustration
 */

type Ctx = { params: Promise<{ path?: string[] }> };

async function handle(
  request: Request,
  ctx: Ctx,
  method: "GET" | "POST" | "PUT" | "DELETE",
): Promise<Response> {
  if (!isLocalPanel()) return new NextResponse(null, { status: 404 });
  if (!(await verifyAdmin(request))) return unauthorizedAdmin();
  const path = (await ctx.params).path ?? [];
  try {
    if (method === "GET" && path.length === 0) {
      return NextResponse.json(readItemArt(), {
        headers: { "Cache-Control": "no-store" },
      });
    }
    if (
      method === "GET" &&
      path[0] === "file" &&
      (path[1] === "file" || path[1] === "source") &&
      path[2]
    ) {
      const { body, mime } = readCardArtFile(path[1], path[2]);
      return new Response(new Uint8Array(body), {
        headers: { "Content-Type": mime, "Cache-Control": "no-store" },
      });
    }
    const [id, what, sub] = path;
    if (!id) return NextResponse.json({ error: "Not found" }, { status: 404 });

    if (method === "POST" && what === "text") {
      return NextResponse.json({
        ok: true,
        ...(await saveItemText(id, await request.json())),
      });
    }
    if (method === "POST" && what === "icon") {
      await saveIcon(id, await request.json());
      return NextResponse.json({ ok: true });
    }
    if (what === "artwork" && method === "POST") {
      await saveArtwork(id, await request.json());
      return NextResponse.json({ ok: true });
    }
    if (what === "artwork" && method === "DELETE") {
      await deleteArtwork(id);
      return NextResponse.json({ ok: true });
    }
    if (what === "card-art" && method === "PUT" && sub === "source") {
      const body = Buffer.from(await request.arrayBuffer());
      return NextResponse.json({
        ok: true,
        entry: saveCardArtSource(id, body),
      });
    }
    if (what === "card-art" && method === "PUT" && sub === "render") {
      let settings: unknown;
      try {
        settings = JSON.parse(
          new URL(request.url).searchParams.get("settings") ?? "",
        );
      } catch {
        throw new ArtError(400, "Bad settings: not JSON");
      }
      const body = Buffer.from(await request.arrayBuffer());
      return NextResponse.json({
        ok: true,
        entry: saveCardArtRender(id, settings, body),
      });
    }
    if (what === "card-art" && method === "DELETE" && !sub) {
      deleteCardArt(id);
      return NextResponse.json({ ok: true });
    }
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  } catch (err) {
    if (err instanceof ArtError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    if (err instanceof SyntaxError) {
      return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}

export const GET = (r: Request, c: Ctx) => handle(r, c, "GET");
export const POST = (r: Request, c: Ctx) => handle(r, c, "POST");
export const PUT = (r: Request, c: Ctx) => handle(r, c, "PUT");
export const DELETE = (r: Request, c: Ctx) => handle(r, c, "DELETE");
