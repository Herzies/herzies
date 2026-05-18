import {
  CHAT_MESSAGE_MAX_LENGTH,
  getItem,
  type Inventory,
  RARITY_COLORS as ITEM_RARITY_COLORS,
  ItemDisplay,
  RARITY_LABELS,
} from "@herzies/shared";
import { createClient, type RealtimeChannel } from "@supabase/supabase-js";
import { useEffect, useRef, useState } from "react";
import { type ChatMessage, herzies } from "../tauri-bridge";
import ItemInspectOverlay from "./ItemInspectOverlay";
import { btnStyle, inputStyle } from "./styles";

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
function usernameColor(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++)
    hash = ((hash << 5) - hash + name.charCodeAt(i)) | 0;
  return CHAT_COLORS[Math.abs(hash) % CHAT_COLORS.length];
}

export function ChatPanel({
  activityLog,
  isOnline,
}: {
  activityLog: { time: string; message: string }[];
  isOnline: boolean;
}) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [itemRefs, setItemRefs] = useState<string[]>([]);
  const [cooldown, setCooldown] = useState(false);
  const [inspectItem, setInspectItem] = useState<string | null>(null);
  const [inventory, setInventory] = useState<Inventory | null>(null);
  const [showAutocomplete, setShowAutocomplete] = useState(false);
  const [autocompleteFilter, setAutocompleteFilter] = useState("");
  const [autocompleteIndex, setAutocompleteIndex] = useState(0);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const channelRef = useRef<RealtimeChannel | null>(null);
  const atPosRef = useRef<number>(-1);

  // Fetch initial messages
  useEffect(() => {
    if (!isOnline) return;
    herzies.chatFetch().then((data) => {
      if (data) setMessages(data.messages);
    });
  }, [isOnline]);

  // Supabase Realtime subscription
  useEffect(() => {
    if (!isOnline) return;
    let cancelled = false;
    let localChannel: RealtimeChannel | null = null;

    herzies.getAuthConfig().then((config) => {
      if (cancelled || !config) return;
      const supabase = createClient(config.supabaseUrl, config.anonKey);
      // Realtime uses a separate WebSocket; it needs the user's JWT to
      // pass the chat_messages RLS SELECT policy.
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
            // Re-fetch outside the setState updater so strict-mode's double
            // invocation doesn't fire two chatFetch round-trips per message.
            herzies.chatFetch().then((data) => {
              if (data) setMessages(data.messages);
            });
          },
        )
        .subscribe((status, err) => {
          if (status !== "SUBSCRIBED")
            console.warn("chat realtime:", status, err);
        });

      // Race: if cleanup ran while getAuthConfig was pending, tear down now.
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

  // Fetch inventory for autocomplete
  useEffect(() => {
    if (!isOnline) return;
    herzies.fetchInventory().then((data) => {
      if (data) setInventory(data.inventory);
    });
  }, [isOnline]);

  // Auto-scroll
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, activityLog]);

  // Send handler
  const handleSend = async () => {
    if (!input.trim() || cooldown) return;
    const content = input.trim().slice(0, CHAT_MESSAGE_MAX_LENGTH);
    const refs = [...itemRefs];
    setInput("");
    setItemRefs([]);
    setShowAutocomplete(false);
    setCooldown(true);
    setTimeout(() => setCooldown(false), 1500);

    const result = await herzies.chatSend(content, refs);
    if (result) {
      setMessages((prev) => {
        if (prev.some((m) => m.id === result.message.id)) return prev;
        return [...prev, result.message];
      });
    }
  };

  // Build filtered autocomplete items
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
    // Find the last @ before cursor that isn't preceded by a non-space
    const before = val.slice(0, cursorPos);
    const atIdx = before.lastIndexOf("@");
    if (atIdx >= 0 && (atIdx === 0 || before[atIdx - 1] === " ")) {
      const filterText = before.slice(atIdx + 1);
      // Don't show autocomplete if there's a space after the filter (completed reference)
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

  const selectAutocomplete = (itemId: string, itemName: string) => {
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
        if (sel) selectAutocomplete(sel.id, sel.item.name);
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

  // Render item ref inline: replace @item-id with colored item name
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
            style={{
              color: item ? ITEM_RARITY_COLORS[item.rarity] : "#c084fc",
              cursor: "pointer",
              textDecoration: "underline",
              textDecorationStyle: "dotted",
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

  // Merge activity log entries and chat messages chronologically
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
      <div
        style={{
          borderTop: "1px solid #333",
          display: "flex",
          flexDirection: "column",
        }}
      >
        {/* Message feed */}
        <div
          ref={scrollRef}
          style={{
            maxHeight: 58,
            minHeight: 20,
            overflow: "auto",
            padding: "2px 0",
          }}
        >
          {feed.length === 0 && (
            <div
              style={{
                fontSize: 9,
                color: "#444",
                textAlign: "center",
                padding: "2px 0",
              }}
            >
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
                  style={{
                    fontSize: 9,
                    color: "#666",
                    lineHeight: "14px",
                    overflowWrap: "break-word",
                    wordBreak: "break-word",
                  }}
                >
                  <span style={{ color: "#555" }}>{display}</span>{" "}
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
                style={{
                  fontSize: 9,
                  lineHeight: "14px",
                  overflowWrap: "break-word",
                  wordBreak: "break-word",
                }}
              >
                <span style={{ color: "#555" }}>{time}</span>{" "}
                <span
                  style={{
                    color: usernameColor(msg.username),
                    fontWeight: "bold",
                  }}
                >
                  {msg.username}
                </span>
                <span style={{ color: "#555" }}>:</span>{" "}
                <span style={{ color: "#ccc" }}>
                  {renderMessageContent(msg.content, msg.itemRefs)}
                </span>
              </div>
            );
          })}
        </div>

        {/* Input area */}
        {isOnline && (
          <div style={{ position: "relative" }}>
            {/* Autocomplete dropdown */}
            {showAutocomplete && autocompleteItems.length > 0 && (
              <div
                style={{
                  position: "absolute",
                  bottom: "100%",
                  left: 0,
                  right: 0,
                  background: "#1a1a1a",
                  border: "1px solid #444",
                  borderRadius: 4,
                  maxHeight: 88,
                  overflow: "auto",
                  zIndex: 100,
                }}
              >
                {autocompleteItems.map((x, i) => (
                  <div
                    key={x.id}
                    onClick={() => selectAutocomplete(x.id, x.item.name)}
                    style={{
                      padding: "3px 8px",
                      fontSize: 10,
                      cursor: "pointer",
                      background:
                        i === autocompleteIndex ? "#333" : "transparent",
                      color: ITEM_RARITY_COLORS[x.item.rarity],
                    }}
                  >
                    {x.item.name}
                    <span style={{ color: "#555", marginLeft: 4 }}>
                      {RARITY_LABELS[x.item.rarity]}
                    </span>
                  </div>
                ))}
              </div>
            )}
            <div style={{ display: "flex", gap: 3, padding: "2px 0" }}>
              <input
                ref={inputRef}
                style={{ ...inputStyle, flex: 1, fontSize: 10 }}
                placeholder="Type a message... (@ for items)"
                value={input}
                onChange={handleInputChange}
                onKeyDown={handleKeyDown}
                maxLength={CHAT_MESSAGE_MAX_LENGTH}
              />
              <button
                style={{
                  ...btnStyle,
                  fontSize: 9,
                  opacity: cooldown || !input.trim() ? 0.5 : 1,
                }}
                disabled={cooldown || !input.trim()}
                onClick={handleSend}
              >
                Send
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Item inspect overlay */}
      {inspectItem && (
        <ItemInspectOverlay
          itemId={inspectItem}
          onClose={() => setInspectItem(null)}
        />
      )}
    </>
  );
}
