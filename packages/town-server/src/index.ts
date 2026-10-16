/**
 * The multiplayer Town's entry point: routes `wss://…/v1/town/<map>?shard=n`
 * to that shard's room. Everything else about a connection — who you are,
 * whether there's space — is the room's call.
 */
import {
  isTownMapId,
  TOWN_INSTANCED_MAPS,
  TOWN_MAX_SHARDS,
  TOWN_SINGLE_SHARD,
} from "@herzies/shared/town-net";
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
    // One shared fight: everyone goes to the same room.
    if (TOWN_SINGLE_SHARD.has(map as never) && shard !== 0)
      return new Response("bad shard", { status: 400 });
    // A room of your own: named by your user id (the room checks the
    // ticket is yours).
    let name = `${map}:${shard}`;
    const instance = url.searchParams.get("i");
    if (TOWN_INSTANCED_MAPS.has(map as never)) {
      if (!instance || !/^[0-9a-f-]{8,64}$/i.test(instance))
        return new Response("bad instance", { status: 400 });
      name = `${map}:${instance}`;
    }
    const room = env.TOWN_ROOM.get(env.TOWN_ROOM.idFromName(name));
    const headers = new Headers(request.headers);
    headers.set("x-town-map", map);
    if (instance) headers.set("x-town-instance", instance);
    else headers.delete("x-town-instance");
    return room.fetch(new Request(request, { headers }));
  },
} satisfies ExportedHandler<Env>;
