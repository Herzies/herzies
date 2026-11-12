import { getItem } from "@herzies/shared";
import { useEffect, useRef, useState } from "react";
import type { ChatMessage } from "../../tauri-bridge";

/** What a herzie is saying over its head. */
export type ChatBubble = {
  /** Changes with every new message, so the typewriter restarts. */
  key: string;
  text: string;
};

/** Bubbles by the speaker's friend code (the Town's render seed). */
export type ChatBubbles = ReadonlyMap<string, ChatBubble>;

/** Only herzies this close to yours show what they say: the chat is one
 * room for everyone, the Town is a place. */
export const BUBBLE_RANGE = 14;
const MAX_CHARS = 90;

/** How long a line stays up: long enough to read. */
export function bubbleDuration(text: string): number {
  return Math.min(10_000, 4_000 + text.length * 60);
}

const LASTFM_URL = /https:\/\/(?:www\.)?last\.fm\/\S+/g;
/** A song share (/current_song): its "♪ title — artist" line, then the
 * Last.fm link on the next. */
const SONG_SHARE = /(♪[^\n]*)\n\s*https:\/\/(?:www\.)?last\.fm\/\S+/g;

/** A chat message as plain text for a bubble: item references by their
 * names, Last.fm links as the chat shows them (a song share by its song
 * line alone, any other link as "Last.fm"), and cut short if long. */
export function bubbleText(msg: Pick<ChatMessage, "content" | "itemRefs">) {
  let text = msg.content;
  for (const ref of msg.itemRefs ?? []) {
    const name = getItem(ref)?.name ?? ref;
    text = text.split(`#${ref}`).join(name).split(`@${ref}`).join(name);
  }
  text = text.replace(SONG_SHARE, "$1").replace(LASTFM_URL, "Last.fm");
  text = text.replace(/\s+/g, " ").trim();
  return text.length > MAX_CHARS ? `${text.slice(0, MAX_CHARS - 1)}…` : text;
}

/** How old a message can be and still get a bubble when it arrives. */
const BUBBLE_RECENT_MS = 20_000;

/**
 * Turns new chat messages into bubbles over their senders' heads while
 * `active` (the Town is open). Messages already there when it opens are
 * history, not speech, so they never pop up; nor do old ones arriving late.
 */
export function useChatBubbles(
  messages: readonly ChatMessage[] | undefined,
  active: boolean,
): ChatBubbles {
  const [bubbles, setBubbles] = useState<ChatBubbles>(new Map());
  const seen = useRef<Set<string> | null>(null);
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  useEffect(() => {
    if (!active) {
      // Coming back later starts from what's there then.
      seen.current = null;
      return;
    }
    const list = messages ?? [];
    if (!seen.current) {
      seen.current = new Set(list.map((m) => m.id));
      return;
    }
    // New to us and said just now: messages that arrive late (the history,
    // loading after the Town opened) aren't said over again.
    const now = Date.now();
    const fresh = list.filter(
      (m) =>
        !seen.current?.has(m.id) &&
        now - Date.parse(m.createdAt) < BUBBLE_RECENT_MS,
    );
    for (const m of list) seen.current.add(m.id);
    if (!fresh.length) return;
    setBubbles((prev) => {
      const next = new Map(prev);
      for (const m of fresh) {
        const code = m.friendCode;
        const text = bubbleText(m);
        if (!code || !text) continue;
        next.set(code, { key: m.id, text });
        clearTimeout(timers.current.get(code));
        timers.current.set(
          code,
          setTimeout(() => {
            timers.current.delete(code);
            setBubbles((cur) => {
              if (cur.get(code)?.key !== m.id) return cur;
              const after = new Map(cur);
              after.delete(code);
              return after;
            });
          }, bubbleDuration(text)),
        );
      }
      return next;
    });
  }, [messages, active]);

  useEffect(() => {
    const t = timers.current;
    return () => {
      for (const id of t.values()) clearTimeout(id);
    };
  }, []);

  return bubbles;
}
