import { execFile } from "node:child_process";

export interface NowPlayingInfo {
  title: string;
  artist: string;
  album: string;
  genre: string;
  duration: number; // seconds
  elapsed: number; // seconds
  isPlaying: boolean;
  source: string; // "Music", "Spotify", etc.
  volume: number; // 0–100
}

/** Query the currently playing track from known macOS music apps via osascript */
export async function getNowPlaying(): Promise<NowPlayingInfo | null> {
  // Try each known music app in order
  return (await tryMusic()) ?? (await trySpotify()) ?? null;
}

function tryMusic(): Promise<NowPlayingInfo | null> {
  return queryApp(
    "Music",
    `
		tell application "System Events"
			if not (exists process "Music") then return "NOT_RUNNING"
		end tell
		tell application "Music"
			if player state is not playing then return "NOT_PLAYING"
			set t to name of current track
			set a to artist of current track
			set al to album of current track
			set g to genre of current track
			set d to duration of current track
			set p to player position
			set v to sound volume
			return t & "||" & a & "||" & al & "||" & g & "||" & d & "||" & p & "||" & v
		end tell
	`,
    "Music",
  );
}

function trySpotify(): Promise<NowPlayingInfo | null> {
  return queryApp(
    "Spotify",
    `
		tell application "System Events"
			if not (exists process "Spotify") then return "NOT_RUNNING"
		end tell
		tell application "Spotify"
			if player state is not playing then return "NOT_PLAYING"
			set u to spotify url of current track
			if u starts with "spotify:ad:" then return "NOT_PLAYING"
			set t to name of current track
			set a to artist of current track
			set al to album of current track
			set d to (duration of current track) / 1000
			set p to player position
			set v to sound volume
			return t & "||" & a & "||" & al & "||" & "||" & d & "||" & p & "||" & v
		end tell
	`,
    "Spotify",
  );
}

function queryApp(
  _appName: string,
  script: string,
  source: string,
): Promise<NowPlayingInfo | null> {
  return new Promise((resolve) => {
    execFile(
      "osascript",
      ["-e", script],
      { timeout: 5000 },
      (error, stdout) => {
        if (error) {
          resolve(null);
          return;
        }

        const result = stdout.trim();
        if (result === "NOT_RUNNING" || result === "NOT_PLAYING") {
          resolve(null);
          return;
        }

        const parts = result.split("||");
        if (parts.length < 7) {
          resolve(null);
          return;
        }

        resolve({
          title: parts[0],
          artist: parts[1],
          album: parts[2],
          genre: parts[3],
          duration: Number.parseFloat(parts[4]) || 0,
          elapsed: Number.parseFloat(parts[5]) || 0,
          isPlaying: true,
          source,
          volume: Number.parseInt(parts[6], 10) || 0,
        });
      },
    );
  });
}
