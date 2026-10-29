/**
 * The body the website draws a herzie with. A herzie's real body is made
 * from its friend code, so drawing it in public would let anyone work the
 * code back out of it (and with the code, look the herzie up). Watchers get
 * a seed made from the user id and the server's secret instead: the same
 * herzie always gets the same made-up body, and nothing leads back to it.
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
