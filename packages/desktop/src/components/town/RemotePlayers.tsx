import { TOWN_FLAG_AFK } from "@herzies/shared";
import { Html } from "@react-three/drei";
import { useFrame } from "@react-three/fiber";
import { useEffect, useMemo, useRef } from "react";
import type { Group } from "three";
import { ROW_TEXT_SHADOW } from "../VisitorRowTheme";
import { HerzieModel } from "./HerzieModel";
import type { RemotePlayer, TownConnection } from "./net/TownConnection";
import { useTownNetVersion } from "./net/townNet";

/** Everyone else in the Town. */
export function RemotePlayers({ net }: { net: TownConnection }) {
  useTownNetVersion(net);
  return (
    <>
      {[...net.remotes.values()].map((r) => (
        <RemoteHerzie key={r.id} remote={r} net={net} />
      ))}
    </>
  );
}

/**
 * Another player's herzie, drawn a moment in the past between the states
 * the server sent (see ServerClock/EntityBuffer), walking at the speed it
 * really went so its feet keep pace. No collider: players pass through each
 * other, as in most social spaces, rather than shoving each other about on
 * stale positions.
 */
function RemoteHerzie({
  remote,
  net,
}: {
  remote: RemotePlayer;
  net: TownConnection;
}) {
  const { look } = remote;
  const lookKey = JSON.stringify(look);
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed on the look's content
  const herzie = useMemo(
    () => new HerzieModel(look, remote.id * 7),
    [lookKey, remote.id],
  );
  useEffect(() => {
    herzie.root.visible = false;
    return () => herzie.dispose();
  }, [herzie]);

  const tag = useRef<HTMLDivElement>(null);
  const tagAnchor = useRef<Group>(null);
  const afk = useRef(false);

  useFrame((_, dt) => {
    const s = remote.buffer.sample(net.clock.renderTime(performance.now()));
    if (!s) return;
    herzie.root.visible = true;
    if (tag.current) tag.current.style.visibility = "visible";
    herzie.root.position.set(s.x, 0, s.z);
    herzie.heading = s.heading;
    herzie.update(dt, s.speed);
    tagAnchor.current?.position.set(s.x, herzie.height + 0.5, s.z);
    const away = (s.flags & TOWN_FLAG_AFK) !== 0;
    if (away !== afk.current && tag.current) {
      afk.current = away;
      tag.current.style.opacity = away ? "0.45" : "1";
      tag.current.dataset.afk = away ? "1" : "";
    }
  });

  return (
    <>
      <primitive object={herzie.root} />
      <group ref={tagAnchor}>
        <Html center zIndexRange={[19, 0]}>
          <div
            ref={tag}
            className="pointer-events-none whitespace-nowrap rounded bg-black/40 px-1.5 py-0.5 text-[10px] leading-tight text-white/90 transition-opacity"
            // Hidden until the first state arrives, rather than at the origin.
            style={{ textShadow: ROW_TEXT_SHADOW, visibility: "hidden" }}
          >
            {remote.name}
          </div>
        </Html>
      </group>
    </>
  );
}
