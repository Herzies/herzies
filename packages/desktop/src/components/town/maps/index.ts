import { type MapId, parseMap, portalCells, type TownMap } from "../map";

/**
 * Every island there is: each maps/<id>.json, as painted in the map editor
 * (`pnpm map-editor`). They float in one sky — each at its `origin` — and
 * portals lead between them.
 */
const files = import.meta.glob<unknown>("./*.json", {
  eager: true,
  import: "default",
});

/** Check that every portal leads to an island there is. */
export function checkLinks(maps: Iterable<TownMap>): void {
  const all = [...maps];
  const ids = new Set(all.map((m) => m.id));
  const errors: string[] = [];
  for (const map of all) {
    for (const k of portalCells(map)) {
      const to = map.portals?.[k]?.to;
      if (to && !ids.has(to)) errors.push(`${map.id} portal ${k}: no "${to}"`);
    }
  }
  if (errors.length) throw new Error(`maps: ${errors.join("; ")}`);
}

function load(): Map<MapId, TownMap> {
  const out = new Map<MapId, TownMap>();
  for (const [path, json] of Object.entries(files)) {
    const map = parseMap(json);
    const file = path.replace(/^\.\/|\.json$/g, "");
    if (map.id !== file) {
      throw new Error(`maps: ${path} holds "${map.id}", not "${file}"`);
    }
    out.set(map.id, map);
  }
  if (!out.has("home")) throw new Error("maps: no home island");
  checkLinks(out.values());
  return out;
}

export const TOWN_MAPS_LOCAL: ReadonlyMap<MapId, TownMap> = load();

/** The home island: where everyone starts. */
export const HOME_MAP = TOWN_MAPS_LOCAL.get("home") as TownMap;

/** An island by id (home if there's none by that name). */
export function mapById(id: MapId): TownMap {
  return TOWN_MAPS_LOCAL.get(id) ?? HOME_MAP;
}
