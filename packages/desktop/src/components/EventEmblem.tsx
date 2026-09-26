import {
  BOSS_BODY_TYPE,
  DEFAULT_Y_ANGLE,
  GOLD_SCHEME_ID,
  generateCreatureParams,
  ItemPreview,
  Herzie3D as SharedHerzie3D,
  SONG_HUNT_EMBLEM,
} from "@herzies/shared";
import { useMemo } from "react";
import { cn } from "../lib/utils";

/** Square footprint of every emblem, so the cards line up. */
const BOX = 56;

/** George's look: one fixed seed, so he's the same herzie for everyone —
 * painted solid gold, because George is rich and wants you to know it. */
const GEORGE_SEED = "npc:good-ol-george";
const GEORGE_EQUIPPED = { color: GOLD_SCHEME_ID };

/**
 * The little 3D mascot on each Events card: the boss you'll face (seeded by
 * its event id, exactly as BossFightPanel draws it), Good ol' George
 * himself, or a spinning note for the Song Hunt.
 */
export function EventEmblem({
  type,
  eventId,
  paused,
  dim = false,
}: {
  type: string;
  eventId?: string;
  paused: boolean;
  /** Nothing scheduled: grey it out like a defeated boss. */
  dim?: boolean;
}) {
  const bossParams = useMemo(() => {
    if (type !== "boss_fight") return undefined;
    const base = generateCreatureParams(`boss:${eventId ?? "preview"}`);
    return { ...base, bodyType: BOSS_BODY_TYPE };
  }, [type, eventId]);

  let art: React.ReactNode = null;
  if (type === "boss_fight" && bossParams) {
    art = (
      <SharedHerzie3D
        userId={`boss:${eventId ?? "preview"}`}
        stage={3}
        size={1.7}
        cols={48}
        creatureParams={bossParams}
        animate={false}
        defaultAngle={-DEFAULT_Y_ANGLE}
        draggable={false}
        paused={paused}
        ariaLabel="The boss"
      />
    );
  } else if (type === "merchant") {
    art = (
      <SharedHerzie3D
        userId={GEORGE_SEED}
        stage={2}
        equipped={GEORGE_EQUIPPED}
        size={1.9}
        cols={40}
        animate={false}
        draggable={false}
        paused={paused}
        ariaLabel="Good ol' George"
      />
    );
  } else if (type === "song_hunt") {
    art = (
      <ItemPreview
        item={SONG_HUNT_EMBLEM}
        box={BOX - 8}
        paused={paused}
        ariaLabel="Song Hunt"
      />
    );
  }

  return (
    <div
      className={cn(
        "flex shrink-0 items-center justify-center overflow-hidden",
        dim && "grayscale opacity-50",
      )}
      style={{ width: BOX, height: BOX }}
    >
      {art}
    </div>
  );
}
