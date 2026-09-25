import releaseNotesData from "../release-notes.json";

export interface ReleaseNotesEntry {
  version: string;
  highlights: string[];
}

/**
 * Manually curated per release — add an entry here (see
 * packages/desktop/README.md#releasing) before tagging a `desktop-v*`
 * release. CI reads the same file to fail the release if the current
 * version has no entry, and to fill in the updater's release notes.
 */
export const RELEASE_NOTES: ReleaseNotesEntry[] = releaseNotesData;
