import {
  TOWN_FLAG_DANCING,
  TOWN_FLAG_JUMP,
  TOWN_FLAG_SITTING,
} from "@herzies/shared";
import { HerzieModel } from "@herzies/shared/gl";
import { useFrame } from "@react-three/fiber";
import { useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { ambient } from "../components/town/ambient";
import { SEAT_Y } from "../components/town/Benches";
import { groundY, type TownMap } from "../components/town/map";
import type { WatchConnection, Watched } from "./WatchConnection";

/** Everyone in Town right now, walking where they walk: no names, no
 * fights, just herzies out and about. */
export function WatchedHerzies({
  map,
  net,
}: {
  map: TownMap;
  net: WatchConnection;
}) {
  useSyncExternalStore(net.subscribe, () => net.version);
  return (
    <>
      {[...net.herzies.values()].map((h) => (
        <WatchedHerzie key={h.id} map={map} who={h} net={net} />
      ))}
    </>
  );
}

function WatchedHerzie({
  map,
  who,
  net,
}: {
  map: TownMap;
  who: Watched;
  net: WatchConnection;
}) {
  const lookKey = JSON.stringify(who.look);
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed on the look's content
  const herzie = useMemo(
    () => new HerzieModel(who.look, { seed: who.id * 7, lighting: ambient }),
    [lookKey, who.id],
  );
  useEffect(() => {
    herzie.root.visible = false;
    return () => herzie.dispose();
  }, [herzie]);
  /** The jump bit last frame (null until the first state). */
  const jumpBit = useRef<number | null>(null);

  useFrame((_, dt) => {
    const s = who.buffer.sample(net.clock.renderTime(performance.now()));
    if (!s) return;
    herzie.root.visible = true;
    const seated = (s.flags & TOWN_FLAG_SITTING) !== 0;
    herzie.root.position.set(
      s.x,
      groundY(map, s.x, s.z) + (seated ? SEAT_Y : 0),
      s.z,
    );
    herzie.sitting = seated;
    herzie.dancing = (s.flags & TOWN_FLAG_DANCING) !== 0;
    herzie.heading = s.heading;
    const bit = s.flags & TOWN_FLAG_JUMP;
    if (jumpBit.current !== null && bit !== jumpBit.current) herzie.jump();
    jumpBit.current = bit;
    herzie.update(dt, s.speed);
  });

  return <primitive object={herzie.root} />;
}
