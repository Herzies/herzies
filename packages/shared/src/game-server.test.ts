import { describe, expect, it } from "vitest";
import { matchesSecretTrack } from "./game-server.js";

describe("matchesSecretTrack", () => {
  const hunt = {
    trackTitle: "NY Is Killing Me",
    trackArtist: "Gil Scott-Heron & Jamie xx",
  };

  it("matches however an app credits a collaboration", () => {
    // Apple Music lists every artist; Spotify only the first.
    expect(
      matchesSecretTrack(
        "NY Is Killing Me",
        "Gil Scott-Heron & Jamie xx",
        hunt,
      ),
    ).toBe(true);
    expect(
      matchesSecretTrack("NY Is Killing Me", "Gil Scott-Heron", hunt),
    ).toBe(true);
    expect(
      matchesSecretTrack("NY Is Killing Me", "Gil Scott-Heron, Jamie xx", hunt),
    ).toBe(true);
    expect(
      matchesSecretTrack(
        "NY Is Killing Me",
        "Gil Scott-Heron feat. Jamie xx",
        hunt,
      ),
    ).toBe(true);
    expect(
      matchesSecretTrack("NY Is Killing Me", "Gil Scott-Heron", {
        ...hunt,
        trackArtist: "Gil Scott-Heron",
      }),
    ).toBe(true);
  });

  it("still ignores case, brackets and dash suffixes", () => {
    expect(
      matchesSecretTrack(
        "ny is killing me (Remastered)",
        "GIL SCOTT-HERON",
        hunt,
      ),
    ).toBe(true);
    expect(
      matchesSecretTrack("NY Is Killing Me - 2011", "Gil Scott-Heron", hunt),
    ).toBe(true);
  });

  it("does not match a different lead artist or title", () => {
    expect(matchesSecretTrack("NY Is Killing Me", "Jamie xx", hunt)).toBe(
      false,
    );
    expect(
      matchesSecretTrack(
        "Home Is Where the Hatred Is",
        "Gil Scott-Heron",
        hunt,
      ),
    ).toBe(false);
  });

  it("keeps band names with an ampersand or comma whole enough to match", () => {
    const ewf = { trackTitle: "September", trackArtist: "Earth, Wind & Fire" };
    expect(matchesSecretTrack("September", "Earth, Wind & Fire", ewf)).toBe(
      true,
    );
  });
});
