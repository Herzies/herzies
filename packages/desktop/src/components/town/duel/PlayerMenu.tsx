import { DUEL, DUEL_MAPS } from "@herzies/shared/duel";
import type { TownMapId } from "@herzies/shared/town-net";
import { useEffect, useState } from "react";
import { ContextMenu, type ContextMenuItem } from "../../ContextMenu";
import { entityAt } from "../combat/skills";
import type { RemotePlayer } from "../net/TownConnection";
import { townSave } from "../runtime";
import { TitleLine } from "../TitleLine";
import { cancelChallenge, challenge } from "./actions";
import { closePlayerMenu, duel, duelOf, inDuel, useDuel } from "./store";

/**
 * The menu a remote herzie's name opens: their profile, and a challenge to
 * a duel where there are duels (greyed, with why, when it can't be: too
 * far, or someone's in one already).
 */
export function PlayerMenu({
  remote,
  onOpenProfile,
}: {
  remote: RemotePlayer;
  onOpenProfile?: (friendCode: string) => void;
}) {
  useDuel();
  // Walking up to them lights it up: the distance is looked at again.
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 250);
    return () => clearInterval(t);
  }, []);
  const menu = duel.menu;
  if (!menu || menu.id !== remote.id) return null;
  const at = entityAt.get(remote.id);
  const far =
    !at ||
    Math.hypot(at.x - townSave.x, at.z - townSave.z) > DUEL.challengeRange;
  const busy = inDuel() || !!duelOf(remote.id);
  const items: ContextMenuItem[] = [];
  if (onOpenProfile)
    items.push({
      label: "Profile",
      onClick: () => {
        closePlayerMenu();
        onOpenProfile(remote.look.seed);
      },
    });
  if (DUEL_MAPS.has(townSave.map as TownMapId)) {
    if (duel.outgoing?.to === remote.id)
      items.push({
        label: "Cancel challenge",
        onClick: () => {
          closePlayerMenu();
          cancelChallenge();
        },
      });
    else
      items.push({
        label: "Challenge to duel",
        disabled: busy || far,
        ...(busy ? { hint: "In a duel" } : far ? { hint: "Get closer" } : {}),
        onClick: () => {
          closePlayerMenu();
          challenge(remote.id);
        },
      });
  }
  if (!items.length) return null;
  return (
    <ContextMenu
      x={menu.x}
      y={menu.y}
      items={items}
      onClose={closePlayerMenu}
      numbered
      heading={
        <>
          <div className="font-medium text-white">{remote.name}</div>
          <TitleLine id={remote.title} className="text-ui-sm" />
        </>
      }
    />
  );
}
