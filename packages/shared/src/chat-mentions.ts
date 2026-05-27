export type ChatInputMenuState =
  | { kind: "item"; triggerIdx: number; filter: string }
  | { kind: "user"; triggerIdx: number; filter: string }
  | { kind: "slash"; triggerIdx: number; filter: string }
  | { kind: "none" };

/** Active #item, @user, or /slash menu at the cursor. */
export function getChatInputMenuState(
  val: string,
  cursorPos: number,
): ChatInputMenuState {
  const before = val.slice(0, cursorPos);
  const triggers: { kind: "item" | "user" | "slash"; idx: number }[] = [];

  const hashIdx = before.lastIndexOf("#");
  if (hashIdx >= 0 && (hashIdx === 0 || before[hashIdx - 1] === " ")) {
    triggers.push({ kind: "item", idx: hashIdx });
  }
  const atIdx = before.lastIndexOf("@");
  if (atIdx >= 0 && (atIdx === 0 || before[atIdx - 1] === " ")) {
    triggers.push({ kind: "user", idx: atIdx });
  }
  const slashIdx = before.lastIndexOf("/");
  if (slashIdx >= 0 && (slashIdx === 0 || before[slashIdx - 1] === " ")) {
    triggers.push({ kind: "slash", idx: slashIdx });
  }

  triggers.sort((a, b) => b.idx - a.idx);
  const active = triggers[0];
  if (!active) return { kind: "none" };

  const filter = before.slice(active.idx + 1);
  if (filter.includes(" ")) return { kind: "none" };
  if (active.kind === "slash" && (filter.includes("@") || filter.includes("#"))) {
    return { kind: "none" };
  }
  if (active.kind === "item" && filter.includes("@")) return { kind: "none" };
  if (active.kind === "user" && filter.includes("#")) return { kind: "none" };

  return { kind: active.kind, triggerIdx: active.idx, filter };
}

export type MentionableChatUser = {
  friendCode: string;
  name: string;
};
