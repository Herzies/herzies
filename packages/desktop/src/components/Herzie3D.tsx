import {
  type CreatureParams,
  Herzie3D as SharedHerzie3D,
  Sky,
} from "@herzies/shared";
import { useEffect, useState } from "react";
import { useWindowVisible } from "../tauri-bridge";

interface Props {
  userId: string;
  stage?: number;
  size?: number;
  animate?: boolean;
  isPlaying?: boolean;
  wearables?: string[];
  creatureParams?: CreatureParams;
  showSky?: boolean;
  draggable?: boolean;
}

/**
 * Desktop-tuned composition of the shared Sky + Herzie3D primitives.
 *
 * The Tauri window is fixed-size (380×520, borderless), so the sky is anchored
 * to the window's top edge and the drag area spans the full window width.
 */
export function Herzie3D({
  userId,
  stage = 1,
  size = 5,
  animate,
  isPlaying = false,
  wearables,
  creatureParams,
  showSky = true,
  draggable,
}: Props) {
  // Full-window-width column count, shared by the sky and the creature
  // viewport so both span the window without stretching their contents.
  const [windowCols, setWindowCols] = useState(() =>
    Math.floor(window.innerWidth / (size * 0.6)),
  );

  useEffect(() => {
    const onResize = () => {
      setWindowCols(Math.floor(window.innerWidth / (size * 0.6)));
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [size]);

  const visible = useWindowVisible();
  const paused = !visible;

  const scenery = wearables?.includes("stars")
    ? "stars"
    : wearables?.includes("clouds")
      ? "clouds"
      : null;

  return (
    <>
      {showSky && (
        <Sky
          userId={userId}
          isPlaying={isPlaying}
          cols={windowCols}
          variant={scenery}
          size={size}
          paused={paused || animate === false}
          style={{
            position: "fixed",
            top: 0,
            left: 0,
            width: "100vw",
            zIndex: 0,
          }}
        />
      )}
      <SharedHerzie3D
        userId={userId}
        stage={stage}
        size={size}
        cols={showSky ? windowCols : undefined}
        animate={animate}
        isPlaying={isPlaying}
        wearables={wearables}
        creatureParams={creatureParams}
        draggable={draggable}
        paused={paused}
        wrapperStyle={
          showSky
            ? {
                position: "relative",
                width: "100vw",
                marginLeft: "calc(-50vw + 50%)",
              }
            : undefined
        }
      />
    </>
  );
}
