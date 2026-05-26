import {
  CHAT_MESSAGE_MAX_LENGTH,
  getItem,
  type Herzie,
  type Inventory,
  RARITY_COLORS as ITEM_RARITY_COLORS,
  RARITY_LABELS,
} from "@herzies/shared";
import { createClient, type RealtimeChannel } from "@supabase/supabase-js";
import { useEffect, useRef, useState } from "react";
import { cn } from "../lib/utils";
import { type ChatMessage, herzies } from "../tauri-bridge";
import ItemInspectOverlay from "./ItemInspectOverlay";

const CHAT_COLORS = [
  "#7dd3fc",
  "#fca5a5",
  "#86efac",
  "#fde047",
  "#c4b5fd",
  "#fdba74",
  "#f9a8d4",
  "#67e8f9",
];

type UserMenuTarget = {
  username: string;
  friendCode: string | null | undefined;
};

const USER_MENU_ITEMS = [
  { id: "add", label: "Add as friend" },
  { id: "profile", label: "Profile" },
  { id: "report", label: "Report" },
] as const;

const DROPDOWN_ROW_CLASS =
  "cursor-pointer px-2 py-0.5 text-[10px] bg-transparent hover:bg-[#333]";

function usernameColor(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++)
    hash = ((hash << 5) - hash + name.charCodeAt(i)) | 0;
  return CHAT_COLORS[Math.abs(hash) % CHAT_COLORS.length];
}

export function ChatPanel({
  activityLog,
  isOnline,
  messages,
  inventory: cachedInventory,
  herzie,
  onOpenProfile,
  onActivity,
}: {
  activityLog: { time: string; message: string }[];
  isOnline: boolean;
  messages: ChatMessage[];
  inventory: Inventory | null;
  herzie: Herzie;
  onOpenProfile: (friendCode: string) => void;
  onActivity?: (message: string) => void;
}) {
  const [input, setInput] = useState("");
  const [itemRefs, setItemRefs] = useState<string[]>([]);
  const [cooldown, setCooldown] = useState(false);
  const [inspectItem, setInspectItem] = useState<string | null>(null);
  const [inventory, setInventory] = useState<Inventory | null>(cachedInventory);
  const [showAutocomplete, setShowAutocomplete] = useState(false);
  const [autocompleteFilter, setAutocompleteFilter] = useState("");
  const [autocompleteIndex, setAutocompleteIndex] = useState(0);
  const [userMenu, setUserMenu] = useState<UserMenuTarget | null>(null);
  const [userMenuIndex, setUserMenuIndex] = useState(0);
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickToBottomRef = useRef(true);
  const inputRef = useRef<HTMLInputElement>(null);
  const channelRef = useRef<RealtimeChannel | null>(null);
  const atPosRef = useRef<number>(-1);
  const menuRef = useRef<HTMLDivElement>(null);

  const SCROLL_STICK_THRESHOLD_PX = 8;

  const scrollToBottom = () => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  };

  const handleFeedScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    stickToBottomRef.current = distanceFromBottom <= SCROLL_STICK_THRESHOLD_PX;
  };

  useEffect(() => {
    if (!isOnline) return;
    let cancelled = false;
    let localChannel: RealtimeChannel | null = null;

    herzies.getAuthConfig().then((config) => {
      if (cancelled || !config) return;
      const supabase = createClient(config.supabaseUrl, config.anonKey);
      supabase.realtime.setAuth(config.accessToken);

      localChannel = supabase
        .channel("chat_messages_realtime")
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .on(
          "postgres_changes" as any,
          { event: "INSERT", schema: "public", table: "chat_messages" } as any,
          (payload: any) => {
            const newId = payload.new?.id;
            if (!newId) return;
            herzies.chatFetch();
          },
        )
        .subscribe((status, err) => {
          if (status !== "SUBSCRIBED")
            console.warn("chat realtime:", status, err);
        });

      if (cancelled) {
        localChannel.unsubscribe();
        localChannel = null;
        return;
      }
      channelRef.current = localChannel;
    });

    return () => {
      cancelled = true;
      const ch = channelRef.current ?? localChannel;
      if (ch) {
        ch.unsubscribe();
        channelRef.current = null;
      }
    };
  }, [isOnline]);

  useEffect(() => {
    setInventory(cachedInventory);
  }, [cachedInventory]);

  useEffect(() => {
    if (stickToBottomRef.current) scrollToBottom();
  }, [messages, activityLog]);

  useEffect(() => {
    if (!userMenu) return;
    const onPointerDown = (e: MouseEvent) => {
      if (menuRef.current?.contains(e.target as Node)) return;
      setUserMenu(null);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setUserMenu(null);
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [userMenu]);

  const isSelf = (code: string | null | undefined) =>
    !!code && code === herzie.friendCode;

  const isAlreadyFriend = (code: string | null | undefined) =>
    !!code && herzie.friendCodes.includes(code);

  const canAddFriend = (code: string | null | undefined) =>
    !!code && !isSelf(code) && !isAlreadyFriend(code);

  const closeUserMenu = () => {
    setUserMenu(null);
    setUserMenuIndex(0);
  };

  const runUserMenuAction = async (
    actionId: (typeof USER_MENU_ITEMS)[number]["id"],
  ) => {
    if (!userMenu) return;
    const code = userMenu.friendCode;

    switch (actionId) {
      case "add": {
        if (!canAddFriend(code)) return;
        const result = await herzies.friendAdd(code!);
        onActivity?.(result.message);
        break;
      }
      case "profile": {
        if (!code) return;
        onOpenProfile(code);
        break;
      }
      case "report":
        onActivity?.("Report — coming soon");
        break;
    }
    closeUserMenu();
  };

  const handleSend = async () => {
    if (!input.trim() || cooldown) return;
    const content = input.trim().slice(0, CHAT_MESSAGE_MAX_LENGTH);
    const refs = [...itemRefs];
    setInput("");
    setItemRefs([]);
    setShowAutocomplete(false);
    closeUserMenu();
    stickToBottomRef.current = true;
    setCooldown(true);
    setTimeout(() => setCooldown(false), 1500);

    await herzies.chatSend(content, refs);
    scrollToBottom();
  };

  const autocompleteItems = inventory
    ? Object.entries(inventory)
        .filter(([, qty]) => qty > 0)
        .map(([id]) => ({ id, item: getItem(id) }))
        .filter(
          (
            x,
          ): x is {
            id: string;
            item: NonNullable<ReturnType<typeof getItem>>;
          } => !!x.item,
        )
        .filter(
          (x) =>
            !autocompleteFilter ||
            x.item.name
              .toLowerCase()
              .includes(autocompleteFilter.toLowerCase()),
        )
    : [];

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value;
    setInput(val);

    const cursorPos = e.target.selectionStart ?? val.length;
    const before = val.slice(0, cursorPos);
    const atIdx = before.lastIndexOf("@");
    if (atIdx >= 0 && (atIdx === 0 || before[atIdx - 1] === " ")) {
      const filterText = before.slice(atIdx + 1);
      if (!filterText.includes(" ")) {
        setShowAutocomplete(true);
        setAutocompleteFilter(filterText);
        setAutocompleteIndex(0);
        atPosRef.current = atIdx;
        return;
      }
    }
    setShowAutocomplete(false);
  };

  const selectAutocomplete = (itemId: string) => {
    const atIdx = atPosRef.current;
    if (atIdx < 0) return;
    const before = input.slice(0, atIdx);
    const cursorPos = inputRef.current?.selectionStart ?? input.length;
    const after = input.slice(cursorPos);
    const newInput = `${before}@${itemId} ${after}`;
    setInput(newInput);
    if (!itemRefs.includes(itemId)) {
      setItemRefs((prev) => [...prev, itemId]);
    }
    setShowAutocomplete(false);
    inputRef.current?.focus();
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (userMenu) {
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setUserMenuIndex((i) => Math.max(0, i - 1));
        return;
      }
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setUserMenuIndex((i) => Math.min(USER_MENU_ITEMS.length - 1, i + 1));
        return;
      }
      if (e.key === "Enter") {
        e.preventDefault();
        const item = USER_MENU_ITEMS[userMenuIndex];
        if (item) void runUserMenuAction(item.id);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        closeUserMenu();
        return;
      }
    }

    if (showAutocomplete && autocompleteItems.length > 0) {
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setAutocompleteIndex((i) => Math.max(0, i - 1));
        return;
      }
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setAutocompleteIndex((i) =>
          Math.min(autocompleteItems.length - 1, i + 1),
        );
        return;
      }
      if (e.key === "Tab" || e.key === "Enter") {
        e.preventDefault();
        const sel = autocompleteItems[autocompleteIndex];
        if (sel) selectAutocomplete(sel.id);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setShowAutocomplete(false);
        return;
      }
    }
    if (e.key === "Enter" && !showAutocomplete) {
      e.preventDefault();
      handleSend();
    }
  };

  const renderMessageContent = (content: string, msgItemRefs: string[]) => {
    if (msgItemRefs.length === 0) return <span>{content}</span>;

    const parts: React.ReactNode[] = [];
    let remaining = content;
    let key = 0;

    for (const ref of msgItemRefs) {
      const pattern = `@${ref}`;
      const idx = remaining.indexOf(pattern);
      if (idx >= 0) {
        if (idx > 0)
          parts.push(<span key={key++}>{remaining.slice(0, idx)}</span>);
        const item = getItem(ref);
        parts.push(
          <span
            key={key++}
            className="cursor-pointer underline decoration-dotted"
            style={{
              color: item ? ITEM_RARITY_COLORS[item.rarity] : "#c084fc",
            }}
            onClick={() => setInspectItem(ref)}
          >
            {item?.name ?? ref}
          </span>,
        );
        remaining = remaining.slice(idx + pattern.length);
      }
    }
    if (remaining) parts.push(<span key={key++}>{remaining}</span>);
    return <>{parts}</>;
  };

  const isMenuItemDisabled = (id: (typeof USER_MENU_ITEMS)[number]["id"]) => {
    if (!userMenu) return true;
    const code = userMenu.friendCode;
    switch (id) {
      case "add":
        return !canAddFriend(code);
      case "profile":
        return !code || isSelf(code);
      case "report":
        return false;
      default:
        return true;
    }
  };

  type FeedEntry =
    | { kind: "activity"; time: string; message: string; sortKey: string }
    | { kind: "chat"; msg: ChatMessage; sortKey: string };

  const feed: FeedEntry[] = [];

  for (const entry of activityLog) {
    feed.push({
      kind: "activity",
      time: entry.time,
      message: entry.message,
      sortKey: entry.time,
    });
  }
  for (const msg of messages) {
    feed.push({ kind: "chat", msg, sortKey: msg.createdAt });
  }
  feed.sort((a, b) => a.sortKey.localeCompare(b.sortKey));

  return (
    <>
      <div className="flex flex-col border-t border-border">
        <div
          ref={scrollRef}
          onScroll={handleFeedScroll}
          className="max-h-[58px] min-h-5 overflow-auto py-0.5"
        >
          {feed.length === 0 && (
            <div className="py-0.5 text-center text-ui-sm text-[#444]">
              No messages yet
            </div>
          )}
          {feed.map((entry, i) => {
            if (entry.kind === "activity") {
              const d = new Date(entry.time);
              const display = `${d.getHours().toString().padStart(2, "0")}:${d.getMinutes().toString().padStart(2, "0")}`;
              return (
                <div
                  key={`a-${i}`}
                  className="break-words text-ui-sm leading-[14px] text-text-dim"
                >
                  <span className="text-text-dim">{display}</span>{" "}
                  {entry.message}
                </div>
              );
            }
            const { msg } = entry;
            const ts = new Date(msg.createdAt);
            const time = `${ts.getHours().toString().padStart(2, "0")}:${ts.getMinutes().toString().padStart(2, "0")}`;
            return (
              <div
                key={msg.id}
                className="break-words text-ui-sm leading-[14px]"
              >
                <span className="text-text-dim">{time}</span>{" "}
                <button
                  type="button"
                  className={cn(
                    "cursor-pointer rounded-sm border-none bg-transparent px-0.5 py-px font-bold underline decoration-dotted underline-offset-2 transition-[background-color,filter] hover:brightness-125 hover:decoration-solid",
                    userMenu?.username === msg.username
                      ? "bg-[#333] decoration-solid"
                      : "hover:bg-[#333]/60 active:bg-[#333]",
                  )}
                  style={{ color: usernameColor(msg.username) }}
                  onClick={(e) => {
                    e.stopPropagation();
                    setUserMenu({
                      username: msg.username,
                      friendCode: msg.friendCode,
                    });
                    setUserMenuIndex(0);
                    setShowAutocomplete(false);
                  }}
                >
                  {msg.username}
                </button>
                <span className="text-text-dim">:</span>{" "}
                <span className="text-text">
                  {renderMessageContent(msg.content, msg.itemRefs)}
                </span>
              </div>
            );
          })}
        </div>

        {isOnline && (
          <div className="relative">
            {userMenu && (
              <div
                ref={menuRef}
                className="absolute bottom-full left-0 right-0 z-[100] overflow-hidden rounded border border-[#444] bg-bg-panel"
              >
                {USER_MENU_ITEMS.map((item, i) => {
                  const disabled = isMenuItemDisabled(item.id);
                  const isReport = item.id === "report";
                  return (
                    <button
                      key={item.id}
                      type="button"
                      disabled={disabled && !isReport}
                      onMouseEnter={() => setUserMenuIndex(i)}
                      onClick={() => {
                        if (isReport) {
                          void runUserMenuAction("report");
                          return;
                        }
                        if (!disabled) void runUserMenuAction(item.id);
                      }}
                      className={cn(
                        "block w-full border-none text-left",
                        DROPDOWN_ROW_CLASS,
                        i === userMenuIndex && "bg-[#333]",
                        disabled && !isReport
                          ? "cursor-not-allowed opacity-40 hover:bg-transparent"
                          : isReport
                            ? "cursor-not-allowed opacity-50 hover:bg-transparent"
                            : "text-text",
                      )}
                    >
                      {item.label}
                      {isReport && (
                        <span className="ml-1 text-text-dim">(soon)</span>
                      )}
                    </button>
                  );
                })}
              </div>
            )}
            {showAutocomplete && autocompleteItems.length > 0 && !userMenu && (
              <div className="absolute bottom-full left-0 right-0 z-[100] max-h-[88px] overflow-auto rounded border border-[#444] bg-bg-panel">
                {autocompleteItems.map((x, i) => (
                  <div
                    key={x.id}
                    onMouseEnter={() => setAutocompleteIndex(i)}
                    onClick={() => selectAutocomplete(x.id)}
                    className={cn(
                      DROPDOWN_ROW_CLASS,
                      i === autocompleteIndex && "bg-[#333]",
                    )}
                    style={{ color: ITEM_RARITY_COLORS[x.item.rarity] }}
                  >
                    {x.item.name}
                    <span className="ml-1 text-text-dim">
                      {RARITY_LABELS[x.item.rarity]}
                    </span>
                  </div>
                ))}
              </div>
            )}
            <div className="flex gap-0.5 py-0.5">
              <input
                ref={inputRef}
                className="input flex-1 text-[10px]"
                placeholder="Type a message... (@ for items)"
                value={input}
                onChange={handleInputChange}
                onKeyDown={handleKeyDown}
                maxLength={CHAT_MESSAGE_MAX_LENGTH}
              />
              <button
                type="button"
                className={cn(
                  "btn text-ui-sm",
                  cooldown || !input.trim() ? "opacity-50" : "opacity-100",
                )}
                disabled={cooldown || !input.trim()}
                onClick={handleSend}
              >
                Send
              </button>
            </div>
          </div>
        )}
      </div>

      {inspectItem && (
        <ItemInspectOverlay
          itemId={inspectItem}
          onClose={() => setInspectItem(null)}
        />
      )}
    </>
  );
}
