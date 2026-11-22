import { useFrame } from "@react-three/fiber";
import { useRef } from "react";
import * as THREE from "three";
import { Dock } from "./airship/Dock";
import { Birds } from "./Birds";
import { Bunting } from "./Bunting";
import { Clouds } from "./Clouds";
import { type Champion, useChampion } from "./champion";
import type { Hour } from "./DayCycle";
import { DayLight, type ShadowFocus } from "./DayLight";
import { HAZE_START } from "./depth";
import { Ground } from "./Ground";
import { DistantIslands, HomeIsland, SKY, Sky } from "./Islands";
import { islandRadius, type TownMap } from "./map";
import { Particles } from "./Particles";
import { Props } from "./Props";
import { Weather } from "./Rain";
import { Room } from "./Room";
import { HOME_MAP, TOWN_MAPS_LOCAL } from "./runtime";
import type { Season } from "./Seasons";
import { TowerHall } from "./TowerHall";
import { compileUnseen } from "./vfx/warmup";
import { WEATHER_ON } from "./weather";

/** A room's air until DayLight sets it (the cave's: nearly black, a touch
 * of violet). */
const DARK_ROOM = "#09070e";

/** A fresh id per map object, so its colliders are rebuilt as a whole when
 * the map editor's preview changes the map. */
const mapIds = new WeakMap<TownMap, number>();
let nextMapId = 0;
export function mapId(map: TownMap): number {
  let id = mapIds.get(map);
  if (id === undefined) {
    id = nextMapId++;
    mapIds.set(map, id);
  }
  return id;
}

/**
 * The town as it looks: a floating island under an open sky, the other
 * islands you can visit floating where they are, made-up ones drifting in
 * the distance, light, and the island's top as the map paints it —
 * ground, water, bridges, plants, buildings and statues. (What you bump
 * into is MapColliders', in the physics.)
 *
 * The island you're on (`map`) is drawn at the origin; everything else in
 * the sky is moved by its `origin`. Aboard a sky ship, `map` is the island
 * the ship is nearest: drawn in full, the others as they look from afar.
 * Every island keeps its place in the tree (keyed by id) whichever is
 * nearest, so changing which costs a few small things, not a rebuild —
 * and no shaders: every island lights as many lamps (see lightPools), and
 * everything in the sky was compiled as it came up (see Precompile).
 */
export function World({
  map = HOME_MAP,
  others,
  champion: given,
  hour,
  season,
  shadows,
}: {
  /** Show the world at this hour of the day (default: the local clock). */
  hour?: Hour;
  /** Show the world at this time of year (default: the calendar). */
  season?: Season;
  map?: TownMap;
  /** The other islands in the sky (default: every map there is; the map
   * editor passes its own). */
  others?: TownMap[];
  /** Who the statues show (default: the last boss fight's, as the
   * server last said; see champion.ts). */
  champion?: Champion;
  /** Where the sun's shadows fall, frame by frame (default: all of the
   * island; see DayLight). Given, the light isn't remounted per island. */
  shadows?: ShadowFocus;
}) {
  const live = useChampion();
  const champion = given ?? live;
  // Rooms (the boss's cave, the Tower's hall) aren't islands in anyone's
  // sky, nor are decks.
  const rest = (others ?? [...TOWN_MAPS_LOCAL.values()]).filter(
    (m) => m.id !== map.id && !m.room && !m.ship,
  );
  const [ox, oy, oz] = map.origin;
  if (map.room) {
    return (
      <>
        <color attach="background" args={[DARK_ROOM]} />
        <fog attach="fog" args={[DARK_ROOM, HAZE_START, 0]} />
        <DayLight
          key={map.id}
          hour={hour}
          season={season}
          room={map.room}
          radius={islandRadius(map)}
        />
        {/* The hall lays its own floor; the cave's is the map's gravel. */}
        {map.room === "tower" ? (
          <TowerHall map={map} />
        ) : (
          <>
            <Room map={map} />
            <Ground map={map} />
          </>
        )}
        <Props map={map} champion={champion} />
        <Particles map={map} />
      </>
    );
  }
  const islands = [map, ...rest].sort((a, b) => (a.id < b.id ? -1 : 1));
  return (
    <>
      <color attach="background" args={[SKY.horizon]} />
      {/* The haze (see fog.ts): `far` is its thickness, set by DayLight. */}
      <fog attach="fog" args={[SKY.horizon, HAZE_START, 0]} />
      <Sky />
      {/* Keyed, unless told where to shadow: the sun's shadow box is fitted
          to the island once. */}
      <DayLight
        key={shadows ? "focused" : `${map.id}:${map.size}`}
        hour={hour}
        season={season}
        radius={islandRadius(map)}
        focus={shadows}
      />
      <group position={[-ox, -oy, -oz]}>
        <DistantIslands
          avoid={islands.map((m) => ({
            at: m.origin,
            radius: islandRadius(m),
          }))}
        />
        <Clouds />
        {islands.map((m) => (
          <Island
            key={m.id}
            map={m}
            full={m.id === map.id}
            champion={champion}
          />
        ))}
      </group>
      <Precompile key={islands.map((m) => m.id).join()} />
    </>
  );
}

/** Every material in the sky compiled when its islands come up — in the
 * background, where the GPU allows (compileAsync) — rather than each the
 * first time it's in view: everything's in the scene, but what's off
 * screen isn't drawn, so isn't compiled, until it's on screen. From a sky
 * ship, that was the other island's things, one stall after another on
 * the way over. On the second frame, once the first has set the lights
 * as they'll be (the lamps' shadows, at night: part of every shader);
 * again (keyed) for another sky. */
function Precompile() {
  const frames = useRef(0);
  useFrame(({ gl, scene, camera }) => {
    if (++frames.current !== 2) return;
    const was = gl.getRenderTarget();
    gl.setRenderTarget(OFFSCREEN);
    gl.compileAsync(scene, camera);
    // And what isn't in the scene yet: effects, telegraphs, loot pillars.
    compileUnseen(gl, scene, camera);
    gl.setRenderTarget(was);
  });
  return null;
}

/** Where Precompile draws, as it were: in the sky the scene's drawn into
 * Post's buffer, never straight to the screen, and a shader for a buffer
 * isn't the one for the screen (its colour space, its tone mapping). */
const OFFSCREEN = new THREE.WebGLRenderTarget(1, 1);

/** An island where it floats. `full`: the one you're on (or nearest),
 * with its lights and life; else as seen across the sky — its rock,
 * ground and what stands on it, the little things left out, nothing lit. */
function Island({
  map,
  full,
  champion,
}: {
  map: TownMap;
  full: boolean;
  champion: Champion;
}) {
  return (
    <group position={map.origin}>
      <HomeIsland radius={islandRadius(map)} />
      <Ground map={map} />
      <Props map={map} champion={champion} backdrop={!full} />
      <Dock map={map} />
      {full && (
        <>
          <Bunting map={map} />
          <Birds map={map} />
          {WEATHER_ON && <Weather map={map} />}
          <Particles map={map} />
        </>
      )}
    </group>
  );
}
