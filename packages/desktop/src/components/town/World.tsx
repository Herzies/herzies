import { Clouds } from "./Clouds";
import type { Hour } from "./DayCycle";
import { DayLight } from "./DayLight";
import { Ground } from "./Ground";
import { DistantIslands, HomeIsland, SKY, Sky } from "./Islands";
import type { TownMap } from "./map";
import { Particles } from "./Particles";
import { MapColliders, Props } from "./Props";
import { HOME_MAP, ISLAND_RADIUS } from "./runtime";
import { type Champion, PLACEHOLDER_CHAMPION } from "./Statues";

/** A fresh id per map object, so its colliders are rebuilt as a whole when
 * the map editor's preview changes the map. */
const mapIds = new WeakMap<TownMap, number>();
let nextMapId = 0;
function mapId(map: TownMap): number {
  let id = mapIds.get(map);
  if (id === undefined) {
    id = nextMapId++;
    mapIds.set(map, id);
  }
  return id;
}

/**
 * The static town: a floating island under an open sky, other islands
 * drifting in the distance, light, and the island's top as the map paints
 * it — ground, water, bridges, plants, buildings and statues.
 */
export function World({
  map = HOME_MAP,
  champion = PLACEHOLDER_CHAMPION,
  hour,
}: {
  /** Show the world at this hour of the day (default: the local clock). */
  hour?: Hour;
  map?: TownMap;
  /** Who the statues show (see Statues). */
  champion?: Champion;
}) {
  return (
    <>
      <color attach="background" args={[SKY.horizon]} />
      <fog attach="fog" args={[SKY.horizon, 40, 260]} />
      <Sky />
      <DistantIslands />
      <DayLight hour={hour} />
      <Clouds />

      <HomeIsland radius={ISLAND_RADIUS} />
      <Ground map={map} />
      <Props map={map} champion={champion} />
      <Particles map={map} />
      <MapColliders key={mapId(map)} map={map} />
    </>
  );
}
