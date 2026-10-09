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

/** A chat message as plain text for a bubble: item references by their
 * names, and cut short if long. */
export function bubbleText(msg: Pick<ChatMessage, "content" | "itemRefs">) {
  let text = msg.content;
  for (const ref of msg.itemRefs ?? []) {
    const name = getItem(ref)?.name ?? ref;
    text = text.split(`#${ref}`).join(name).split(`@${ref}`).join(name);
  }
  text = text.replace(/\s+/g, " ").trim();
  return text.length > MAX_CHARS ? `${text.slice(0, MAX_CHARS - 1)}…` : text;
}

/**
 * Turns new chat messages into bubbles over their senders' heads while
 * `active` (the Town is open). Messages already there when it opens are
 * history, not speech, so they never pop up.
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
    const fresh = list.filter((m) => !seen.current?.has(m.id));
    if (!fresh.length) return;
    for (const m of fresh) seen.current.add(m.id);
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
