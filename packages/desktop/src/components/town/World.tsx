import { Clouds } from "./Clouds";
import { type Champion, useChampion } from "./champion";
import type { Hour } from "./DayCycle";
import { DayLight } from "./DayLight";
import { HAZE_START } from "./depth";
import { Ground } from "./Ground";
import { DistantIslands, HomeIsland, SKY, Sky } from "./Islands";
import { islandRadius, type TownMap } from "./map";
import { Particles } from "./Particles";
import { MapColliders, Props } from "./Props";
import { Room } from "./Room";
import { HOME_MAP, TOWN_MAPS_LOCAL } from "./runtime";

/** The cave's air: nearly black, a touch of violet. */
const DARK_ROOM = "#09070e";

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
 * The static town: a floating island under an open sky, the other
 * islands you can visit floating where they are, made-up ones drifting in
 * the distance, light, and the island's top as the map paints it —
 * ground, water, bridges, plants, buildings and statues.
 *
 * The island you're on is drawn at the origin (where its physics are);
 * everything else in the sky is moved by its `origin`.
 */
export function World({
  map = HOME_MAP,
  others,
  champion: given,
  hour,
}: {
  /** Show the world at this hour of the day (default: the local clock). */
  hour?: Hour;
  map?: TownMap;
  /** The other islands in the sky (default: every map there is; the map
   * editor passes its own). */
  others?: TownMap[];
  /** Who the statues show (default: the last boss fight's, as the
   * server last said; see champion.ts). */
  champion?: Champion;
}) {
  const live = useChampion();
  const champion = given ?? live;
  // Rooms (the boss's cave) aren't islands in anyone's sky.
  const rest = (others ?? [...TOWN_MAPS_LOCAL.values()]).filter(
    (m) => m.id !== map.id && !m.room,
  );
  const [ox, oy, oz] = map.origin;
  if (map.room) {
    return (
      <>
        <color attach="background" args={[DARK_ROOM]} />
        <fog attach="fog" args={[DARK_ROOM, HAZE_START, 0]} />
        <DayLight hour={hour} room />
        <Room map={map} />
        <Ground map={map} />
        <Props map={map} champion={champion} />
        <Particles map={map} />
        <MapColliders key={mapId(map)} map={map} />
      </>
    );
  }
  return (
    <>
      <color attach="background" args={[SKY.horizon]} />
      {/* The haze (see fog.ts): `far` is its thickness, set by DayLight. */}
      <fog attach="fog" args={[SKY.horizon, HAZE_START, 0]} />
      <Sky />
      {/* Keyed: the sun's shadow box is fitted to the island once. */}
      <DayLight
        key={`${map.id}:${map.size}`}
        hour={hour}
        radius={islandRadius(map)}
      />
      <group position={[-ox, -oy, -oz]}>
        <DistantIslands
          avoid={[map, ...rest].map((m) => ({
            at: m.origin,
            radius: islandRadius(m),
          }))}
        />
        <Clouds />
        {rest.map((m) => (
          <Backdrop key={m.id} map={m} champion={champion} />
        ))}
      </group>

      <HomeIsland radius={islandRadius(map)} />
      <Ground map={map} />
      <Props map={map} champion={champion} />
      <Particles map={map} />
      <MapColliders key={mapId(map)} map={map} />
    </>
  );
}

/** Another island, seen from this one: its rock, ground and what stands
 * on it, where it floats — nothing to bump into, no lights or life. */
function Backdrop({ map, champion }: { map: TownMap; champion: Champion }) {
  return (
    <group position={map.origin}>
      <HomeIsland radius={islandRadius(map)} />
      <Ground map={map} />
      <Props map={map} champion={champion} backdrop />
    </group>
  );
}
