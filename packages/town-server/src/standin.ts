/**
 * The seed the website is told a herzie has. Its real seed is its friend
 * code, which would let anyone look the herzie up, so watchers get a seed
 * made from the user id and the server's secret instead (the same herzie
 * always gets the same one), with the herzie's real body sent alongside as
 * numbers (TownLook.body). The body can still be matched back to a code by
 * rolling every code until one fits; the seed just doesn't hand it over.
 */
export async function standInSeed(
  uid: string,
  secret: string,
): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, enc.encode(`watch:${uid}`));
  const hex = [...new Uint8Array(mac, 0, 8)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `W-${hex}`;
}
