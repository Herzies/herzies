// Nakata: an old man who lives by the river in Town and talks to cats (after
// Kafka on the Shore). To anyone else he only says "meow". With sleptwell, the
// cat spirit, at your side, he talks to you through it.

/** His name, in Town. */
export const NAKATA_NAME = "Nakata";

/** What opens his panel in Town (a card's openKey) and keys his spot on the
 * map. */
export const NAKATA_KEY = "nakata";

/** The spirit he'll talk to you for. */
export const NAKATA_CAT_ID = "sleptwell";

/** What he says to someone without a cat. */
export const NAKATA_MEOW_LINES = [
  "Meow.",
  "Mrrow?",
  "Meow meow.",
  "...Meow.",
  "Mrr.",
  "Meeow.",
];

/** What he says with sleptwell beside you: gentle, simple, about himself in
 * the third person. */
export const NAKATA_LINES = [
  "Hello. Nakata is not very bright. But Nakata can talk to cats.",
  "What is your name, little one? sleptwell. That is a good name.",
  "sleptwell says you walk too fast. Nakata thinks so too.",
  "sleptwell says the sun is warm by the river today.",
  "Nakata is looking for a stone. A round one. Have you seen it?",
  "It may rain fish tomorrow. Please take an umbrella.",
  "Nakata likes eel very much. sleptwell prefers fish.",
  "Cats know many things. They do not tell everyone.",
  "sleptwell says you snore. Nakata is only passing it on.",
  "Nakata cannot read. But Nakata listens very well.",
  "sleptwell would like more naps. Nakata agrees with sleptwell.",
  "When the cats are quiet, Nakata waits. Waiting is not difficult.",
];

/** His lines for whoever's talking to him, by their spirit. */
export function nakataLines(spirit: string | undefined): readonly string[] {
  return spirit === NAKATA_CAT_ID ? NAKATA_LINES : NAKATA_MEOW_LINES;
}
