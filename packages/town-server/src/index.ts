/**
 * The multiplayer Town's entry point: routes `wss://…/v1/town/<map>?shard=n`
 * to that shard's room. Everything else about a connection — who you are,
 * whether there's space — is the room's call.
 */
import { isTownMapId, TOWN_MAX_SHARDS } from "@herzies/shared/town-net";
import type { Env } from "./room";

export { TownRoom } from "./room";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/health") return new Response("ok");

    const match = url.pathname.match(/^\/v1\/town\/([a-z0-9_-]{1,32})$/);
    if (!match || !isTownMapId(match[1]))
      return new Response("not found", { status: 404 });
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket")
      return new Response("expected a websocket", { status: 426 });

    const shard = Number(url.searchParams.get("shard") ?? "0");
    if (!Number.isInteger(shard) || shard < 0 || shard >= TOWN_MAX_SHARDS)
      return new Response("bad shard", { status: 400 });

    const map = match[1];
    const room = env.TOWN_ROOM.get(env.TOWN_ROOM.idFromName(`${map}:${shard}`));
    const headers = new Headers(request.headers);
    headers.set("x-town-map", map);
    return room.fetch(new Request(request, { headers }));
  },
} satisfies ExportedHandler<Env>;
