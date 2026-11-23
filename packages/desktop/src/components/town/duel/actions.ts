import { townNet } from "../net/townNet";
import {
  blockDuels,
  clearInvite,
  clearOutgoing,
  duel,
  markRematchAsked,
} from "./store";

/**
 * What the player does about duels, sent to the room. The store follows
 * at once where nothing needs the room's word (a challenge answered), and
 * otherwise waits for it.
 */

/** Challenge herzie `id` (an entity id in the room). */
export function challenge(id: number): void {
  townNet().sendDuel({ op: "ask", to: id });
}

/** Answer the challenge waiting on you. */
export function answerInvite(yes: boolean): void {
  const invite = duel.invite;
  if (!invite) return;
  townNet().sendDuel({ op: "answer", from: invite.from, yes });
  clearInvite(invite.from, yes);
}

/** Turn the challenge down, and every one from that herzie this session
 * (it's told you aren't accepting duels, not that you said no). */
export function blockInviter(): void {
  const invite = duel.invite;
  if (!invite) return;
  blockDuels(invite.who.seed);
  townNet().sendDuel({
    op: "answer",
    from: invite.from,
    yes: false,
    auto: true,
  });
  clearInvite(invite.from, false);
}

/** Withdraw your challenge. */
export function cancelChallenge(): void {
  townNet().sendDuel({ op: "cancel" });
  clearOutgoing();
}

/** Give up the duel you're in. */
export function yieldDuel(): void {
  townNet().sendDuel({ op: "yield" });
}

/** Ask for a rematch (or agree to the one asked for). */
export function askRematch(): void {
  townNet().sendDuel({ op: "rematch" });
  markRematchAsked();
}
