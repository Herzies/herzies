import { TOWN_FLAG_AFK, TOWN_FLAG_SITTING } from "@herzies/shared";
import { HerzieModel } from "@herzies/shared/gl";
import { Html } from "@react-three/drei";
import { useFrame } from "@react-three/fiber";
import { useEffect, useMemo, useRef } from "react";
import type { Group } from "three";
import { ROW_TEXT_SHADOW } from "../VisitorRowTheme";
import { ambient } from "./ambient";
import { SEAT_Y } from "./Benches";
import { BUBBLE_RANGE, type ChatBubble, type ChatBubbles } from "./chatBubbles";
import { HeadBubble } from "./HeadBubble";
import type { RemotePlayer, TownConnection } from "./net/TownConnection";
import { useTownNetVersion } from "./net/townNet";
import { townSave } from "./runtime";

/** Everyone else in the Town. */
export function RemotePlayers({
  net,
  bubbles,
}: {
  net: TownConnection;
  /** What people are saying, by friend code. */
  bubbles?: ChatBubbles;
}) {
  useTownNetVersion(net);
  return (
    <>
      {[...net.remotes.values()].map((r) => (
        <RemoteHerzie
          key={r.id}
          remote={r}
          net={net}
          bubble={bubbles?.get(r.look.seed)}
        />
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
  bubble,
}: {
  remote: RemotePlayer;
  net: TownConnection;
  bubble?: ChatBubble;
}) {
  const { look } = remote;
  const lookKey = JSON.stringify(look);
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed on the look's content
  const herzie = useMemo(
    () => new HerzieModel(look, { seed: remote.id * 7, lighting: ambient }),
    [lookKey, remote.id],
  );
  useEffect(() => {
    herzie.root.visible = false;
    return () => herzie.dispose();
  }, [herzie]);

  const tag = useRef<HTMLDivElement>(null);
  const tagAnchor = useRef<Group>(null);
  const afk = useRef(false);
  const bubbleBox = useRef<HTMLDivElement>(null);

  useFrame((_, dt) => {
    const s = remote.buffer.sample(net.clock.renderTime(performance.now()));
    if (!s) return;
    herzie.root.visible = true;
    if (tag.current) tag.current.style.visibility = "visible";
    // Sitting on a bench: on its seat, not the ground.
    const seated = (s.flags & TOWN_FLAG_SITTING) !== 0;
    herzie.root.position.set(s.x, seated ? SEAT_Y : 0, s.z);
    herzie.sitting = seated;
    herzie.heading = s.heading;
    herzie.update(dt, s.speed);
    tagAnchor.current?.position.set(
      s.x,
      herzie.height + 0.3 + (seated ? SEAT_Y : 0),
      s.z,
    );
    // Chat is one room for everyone; the Town only shows what's said near
    // you.
    if (bubbleBox.current) {
      const near =
        Math.hypot(s.x - townSave.x, s.z - townSave.z) <= BUBBLE_RANGE;
      bubbleBox.current.style.display = near ? "" : "none";
    }
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
        <Html zIndexRange={[19, 0]}>
          {/* Stacked up from the anchor: the bubble over the name. */}
          <div className="flex -translate-x-1/2 -translate-y-full flex-col items-center">
            <div ref={bubbleBox}>
              {bubble ? <HeadBubble key={bubble.key} bubble={bubble} /> : null}
            </div>
            <div
              ref={tag}
              className="pointer-events-none whitespace-nowrap rounded bg-black/40 px-1.5 py-0.5 text-[10px] leading-tight text-white/90 transition-opacity"
              // Hidden until the first state arrives, rather than at the origin.
              style={{ textShadow: ROW_TEXT_SHADOW, visibility: "hidden" }}
            >
              {remote.name}
            </div>
          </div>
        </Html>
      </group>
    </>
  );
}
