import { CLASS_DEFS, CLASS_IDS, instrumentOf } from "@herzies/shared/classes";
import type { TownTicketPayload } from "@herzies/shared/town-net";

/**
 * A test ticket's herzie, holding its class's instrument (a class's attack
 * and skills need it), unless the ticket says what's in hand. A ticket
 * with skills but no class key is given the class they belong to.
 */
export function armed(t: TownTicketPayload): TownTicketPayload {
  let cls = t.cls;
  if (!("cls" in t) && t.sk?.length) {
    const first = t.sk[0][0];
    cls = CLASS_IDS.find((c) =>
      (CLASS_DEFS[c].skills as readonly string[]).includes(first),
    );
  }
  if (t.look.equipped) return cls === t.cls ? t : { ...t, cls };
  const inst = instrumentOf(cls);
  return {
    ...t,
    ...(cls ? { cls } : {}),
    look: { ...t.look, ...(inst ? { equipped: { main_hand: inst } } : {}) },
  };
}
