import {
  CHAT_MESSAGE_MAX_LENGTH,
  formatCurrentSongChatMessage,
  getChatInputMenuState,
  getItem,
  type Herzie,
  type HerzieProfile,
  type Inventory,
  RARITY_COLORS as ITEM_RARITY_COLORS,
  type MentionableChatUser,
  RARITY_LABELS,
} from "@herzies/shared";
import { createClient, type RealtimeChannel } from "@supabase/supabase-js";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { chatUserColor, cn } from "../lib/utils";
import { type ChatMessage, herzies } from "../tauri-bridge";
import ItemInspectOverlay from "./ItemInspectOverlay";

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
  "cursor-pointer px-2 py-0.5 text-[10px] bg-transparent hover:bg-white/5";
const DROPDOWN_ROW_ACTIVE_CLASS =
  "bg-purple/20 ring-1 ring-inset ring-purple/60 border-l-2 border-l-purple pl-[6px]";

const CHAT_SLASH_COMMANDS = [
  {
    id: "current_song",
    label: "current_song",
    description: "Share now playing (opens Last.fm)",
  },
] as const;

function filterAutocompleteItems(inventory: Inventory | null, filter: string) {
  if (!inventory) return [];
  return Object.entries(inventory)
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
        !filter || x.item.name.toLowerCase().includes(filter.toLowerCase()),
    );
}

function filterSlashCommandItems(filter: string) {
  return CHAT_SLASH_COMMANDS.filter(
    (c) =>
      !filter ||
      c.label.toLowerCase().includes(filter.toLowerCase()) ||
      c.description.toLowerCase().includes(filter.toLowerCase()),
  );
}

function filterMentionableUsers(users: MentionableChatUser[], filter: string) {
  const q = filter.toLowerCase();
  return users.filter(
    (u) =>
      !q ||
      u.name.toLowerCase().includes(q) ||
      u.friendCode.toLowerCase().includes(q),
  );
}

function buildMentionableUsers(
  messages: ChatMessage[],
  friends: Record<string, HerzieProfile>,
  selfFriendCode: string,
): MentionableChatUser[] {
  const byCode = new Map<string, MentionableChatUser>();
  for (const [code, profile] of Object.entries(friends)) {
    if (code !== selfFriendCode) {
      byCode.set(code, { friendCode: code, name: profile.name });
    }
  }
  for (const msg of messages) {
    const code = msg.friendCode;
    if (code && code !== selfFriendCode) {
      byCode.set(code, { friendCode: code, name: msg.username });
    }
  }
  return [...byCode.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function isChatMenuNavKey(e: KeyboardEvent) {
  return (
    e.key === "ArrowUp" ||
    e.key === "ArrowDown" ||
    e.code === "ArrowUp" ||
    e.code === "ArrowDown" ||
    e.key === "Enter" ||
    e.key === "Tab" ||
    e.key === "Escape"
  );
}

const LASTFM_URL_RE = /https:\/\/(?:www\.)?last\.fm\/[^\s]+/;

type LastFmChunk =
  | { type: "text"; value: string }
  | { type: "songShare"; label: string; url: string }
  | { type: "urlOnly"; url: string };

/** Split text into plain spans vs Last.fm shares (hidden URL) / bare Last.fm URLs. */
function parseSegmentsWithLastFm(text: string): LastFmChunk[] {
  const chunks: LastFmChunk[] = [];
  let i = 0;
  while (i < text.length) {
    const rest = text.slice(i);
    const two = rest.match(
      /^(♪[^\n]+)\n(https:\/\/(?:www\.)?last\.fm\/[^\s\n]+)/,
    );
    if (two) {
      chunks.push({ type: "songShare", label: two[1], url: two[2] });
      i += two[0].length;
      continue;
    }
    const urlMatch = rest.match(LASTFM_URL_RE);
    if (!urlMatch || urlMatch.index === undefined) {
      if (rest.length > 0) chunks.push({ type: "text", value: rest });
      break;
    }
    const urlStart = i + urlMatch.index;
    const url = urlMatch[0];
    const before = text.slice(i, urlStart).trimEnd();
    if (before.startsWith("♪") && !before.includes("\n")) {
      chunks.push({ type: "songShare", label: before, url });
      i = urlStart + url.length;
      continue;
    }
    if (urlStart > i) {
      chunks.push({ type: "text", value: text.slice(i, urlStart) });
    }
    chunks.push({ type: "urlOnly", url });
    i = urlStart + url.length;
  }
  return chunks;
}

function pushTextWithLastFmLinks(
  parts: React.ReactNode[],
  text: string,
  nextKey: () => number,
) {
  for (const ch of parseSegmentsWithLastFm(text)) {
    if (ch.type === "text") {
      if (ch.value.length > 0) {
        parts.push(<span key={nextKey()}>{ch.value}</span>);
      }
    } else if (ch.type === "songShare") {
      parts.push(
        <button
          key={nextKey()}
          type="button"
          className="cursor-pointer border-none bg-transparent p-0 text-left font-inherit text-inherit underline decoration-dotted underline-offset-2 hover:decoration-solid"
          onClick={() => {
            void herzies.openExternalUrl(ch.url);
          }}
        >
          {ch.label}
        </button>,
      );
    } else {
      parts.push(
        <button
          key={nextKey()}
          type="button"
          className="cursor-pointer border-none bg-transparent p-0 font-inherit text-inherit underline decoration-dotted underline-offset-2 hover:decoration-solid"
          onClick={() => {
            void herzies.openExternalUrl(ch.url);
          }}
        >
          Last.fm
        </button>,
      );
    }
  }
}

export function ChatPanel({
  activityLog,
  isOnline,
  messages,
  inventory: cachedInventory,
  friends: cachedFriends,
  herzie,
  nowPlaying,
  onOpenProfile,
  onActivity,
}: {
  activityLog: { time: string; message: string }[];
  isOnline: boolean;
  messages: ChatMessage[];
  inventory: Inventory | null;
  friends: Record<string, HerzieProfile>;
  herzie: Herzie;
  nowPlaying: {
    title: string;
    artist: string;
    albumArtUrl?: string;
    vibe?: string;
    tags?: string[];
  } | null;
  onOpenProfile: (friendCode: string) => void;
  onActivity?: (message: string) => void;
}) {
  const [input, setInput] = useState("");
  const [itemRefs, setItemRefs] = useState<string[]>([]);
  const [userRefs, setUserRefs] = useState<string[]>([]);
  const [cooldown, setCooldown] = useState(false);
  const [inspectItem, setInspectItem] = useState<string | null>(null);
  const [inventory, setInventory] = useState<Inventory | null>(cachedInventory);
  const [showItemAutocomplete, setShowItemAutocomplete] = useState(false);
  const [autocompleteFilter, setAutocompleteFilter] = useState("");
  const [autocompleteIndex, setAutocompleteIndex] = useState(0);
  const [showUserAutocomplete, setShowUserAutocomplete] = useState(false);
  const [userAutocompleteFilter, setUserAutocompleteFilter] = useState("");
  const [userAutocompleteIndex, setUserAutocompleteIndex] = useState(0);
  const [showSlashCommands, setShowSlashCommands] = useState(false);
  const [slashFilter, setSlashFilter] = useState("");
  const [slashIndex, setSlashIndex] = useState(0);
  const [userMenu, setUserMenu] = useState<UserMenuTarget | null>(null);
  const [userMenuIndex, setUserMenuIndex] = useState(0);
  const [expanded, setExpanded] = useState(false);
  /** In-flow height of the dock when collapsed; keeps flex layout stable while expanded (fixed) panel is out of flow. */
  const [dockHeight, setDockHeight] = useState(88);
  const scrollRef = useRef<HTMLDivElement>(null);
  const bottomAnchorRef = useRef<HTMLDivElement>(null);
  const stickToBottomRef = useRef(true);
  const pinnedToBottomRef = useRef(true);
  const feedAnchorFromBottomRef = useRef(0);
  const ignoreScrollRef = useRef(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const channelRef = useRef<RealtimeChannel | null>(null);
  const itemHashPosRef = useRef<number>(-1);
  const userAtPosRef = useRef<number>(-1);
  const slashPosRef = useRef<number>(-1);
  const userAutocompleteIndexRef = useRef(0);
  const userOptionRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const menuRef = useRef<HTMLDivElement>(null);
  const autocompleteListRef = useRef<HTMLDivElement>(null);
  const autocompleteOptionRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const autocompleteIndexRef = useRef(0);
  const slashIndexRef = useRef(0);
  const userMenuIndexRef = useRef(0);
  const chatKeyStateRef = useRef({
    inventory: null as Inventory | null,
    mentionableUsers: [] as MentionableChatUser[],
    userMenu: null as UserMenuTarget | null,
    expanded: false,
    cooldown: false,
    input: "",
  });
  const chatKeyActionsRef = useRef({
    selectAutocomplete: (_itemId: string) => {},
    selectUserMention: (_user: MentionableChatUser) => {},
    selectSlashCommand: (_label: string) => {},
    handleSend: () => {},
    closeUserMenu: () => {},
    runUserMenuAction: (
      _actionId: (typeof USER_MENU_ITEMS)[number]["id"],
    ) => {},
    collapseChat: () => {},
  });

  const mentionableUsers = useMemo(
    () => buildMentionableUsers(messages, cachedFriends, herzie.friendCode),
    [messages, cachedFriends, herzie.friendCode],
  );

  const nameByFriendCode = useMemo(() => {
    const map = new Map<string, string>();
    for (const u of mentionableUsers) {
      map.set(u.friendCode, u.name);
    }
    for (const msg of messages) {
      if (msg.friendCode) map.set(msg.friendCode, msg.username);
    }
    map.set(herzie.friendCode, herzie.name);
    return map;
  }, [mentionableUsers, messages, herzie.friendCode, herzie.name]);

  /** Treat as "at bottom"; expanded flex layout often reports a larger gap than collapsed. */
  const SCROLL_STICK_THRESHOLD_PX = 32;

  const isNearBottom = (el: HTMLElement) => {
    const maxTop = Math.max(0, el.scrollHeight - el.clientHeight);
    return maxTop - el.scrollTop <= SCROLL_STICK_THRESHOLD_PX;
  };

  const pinToBottom = () => {
    pinnedToBottomRef.current = true;
    stickToBottomRef.current = true;
    feedAnchorFromBottomRef.current = 0;
  };

  const scrollToBottom = () => {
    const el = scrollRef.current;
    if (!el) return;
    ignoreScrollRef.current = true;
    pinToBottom();
    bottomAnchorRef.current?.scrollIntoView({ block: "end" });
    el.scrollTop = Math.max(0, el.scrollHeight - el.clientHeight);
    requestAnimationFrame(() => {
      bottomAnchorRef.current?.scrollIntoView({ block: "end" });
      el.scrollTop = Math.max(0, el.scrollHeight - el.clientHeight);
      requestAnimationFrame(() => {
        ignoreScrollRef.current = false;
      });
    });
  };

  const handleFeedScroll = () => {
    if (ignoreScrollRef.current) return;
    const el = scrollRef.current;
    if (!el) return;
    const near = isNearBottom(el);
    stickToBottomRef.current = near;
    pinnedToBottomRef.current = near;
    if (near) feedAnchorFromBottomRef.current = 0;
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
    if (expanded) return;
    const panel = panelRef.current;
    if (!panel) return;
    const ro = new ResizeObserver(() => {
      setDockHeight(panel.getBoundingClientRect().height);
    });
    ro.observe(panel);
    setDockHeight(panel.getBoundingClientRect().height);
    return () => ro.disconnect();
  }, [expanded]);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;

    const applyFeedScroll = () => {
      if (pinnedToBottomRef.current) {
        ignoreScrollRef.current = true;
        bottomAnchorRef.current?.scrollIntoView({ block: "end" });
        el.scrollTop = Math.max(0, el.scrollHeight - el.clientHeight);
        pinToBottom();
        return;
      }
      const maxTop = Math.max(0, el.scrollHeight - el.clientHeight);
      const target = maxTop - feedAnchorFromBottomRef.current;
      el.scrollTop = Math.min(maxTop, Math.max(0, target));
    };

    applyFeedScroll();
    const ro = new ResizeObserver(applyFeedScroll);
    ro.observe(el);
    const raf1 = requestAnimationFrame(() => {
      applyFeedScroll();
      requestAnimationFrame(() => {
        applyFeedScroll();
        ro.disconnect();
        ignoreScrollRef.current = false;
      });
    });

    return () => {
      cancelAnimationFrame(raf1);
      ro.disconnect();
      ignoreScrollRef.current = false;
    };
  }, [expanded]);

  useEffect(() => {
    autocompleteIndexRef.current = autocompleteIndex;
  }, [autocompleteIndex]);

  useEffect(() => {
    slashIndexRef.current = slashIndex;
  }, [slashIndex]);

  useEffect(() => {
    userMenuIndexRef.current = userMenuIndex;
  }, [userMenuIndex]);

  useLayoutEffect(() => {
    if (!showItemAutocomplete) return;
    autocompleteOptionRefs.current[autocompleteIndex]?.scrollIntoView({
      block: "nearest",
    });
  }, [autocompleteIndex, showItemAutocomplete, autocompleteFilter, inventory]);

  useEffect(() => {
    userAutocompleteIndexRef.current = userAutocompleteIndex;
  }, [userAutocompleteIndex]);

  useLayoutEffect(() => {
    if (!showUserAutocomplete) return;
    userOptionRefs.current[userAutocompleteIndex]?.scrollIntoView({
      block: "nearest",
    });
  }, [userAutocompleteIndex, showUserAutocomplete, userAutocompleteFilter]);

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

  const captureFeedScrollAnchor = () => {
    const el = scrollRef.current;
    if (!el) return;
    if (isNearBottom(el)) {
      pinToBottom();
      return;
    }
    pinnedToBottomRef.current = false;
    stickToBottomRef.current = false;
    feedAnchorFromBottomRef.current = Math.max(
      0,
      el.scrollHeight - el.scrollTop - el.clientHeight,
    );
  };

  const collapseChat = () => {
    const el = scrollRef.current;
    if (el && (pinnedToBottomRef.current || isNearBottom(el))) {
      pinToBottom();
    } else {
      captureFeedScrollAnchor();
    }
    setExpanded(false);
    setShowItemAutocomplete(false);
    setShowUserAutocomplete(false);
    setShowSlashCommands(false);
    closeUserMenu();
    inputRef.current?.blur();
  };

  const handleInputFocus = () => {
    captureFeedScrollAnchor();
    setExpanded(true);
    pinToBottom();
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

  const slashCommandItems = filterSlashCommandItems(slashFilter);

  const handleSend = async () => {
    if (!input.trim() || cooldown) return;

    let content = input.trim().slice(0, CHAT_MESSAGE_MAX_LENGTH);
    let refs = [...itemRefs];
    let mentions = [...userRefs];

    const rawLower = input.trim().toLowerCase();
    if (rawLower === "/current_song") {
      if (!nowPlaying) {
        onActivity?.("Nothing playing — start music to share your track.");
        return;
      }
      content = formatCurrentSongChatMessage(
        nowPlaying.title,
        nowPlaying.artist,
        CHAT_MESSAGE_MAX_LENGTH,
      );
      refs = [];
      mentions = [];
    }

    setInput("");
    setItemRefs([]);
    setUserRefs([]);
    setShowItemAutocomplete(false);
    setShowUserAutocomplete(false);
    setShowSlashCommands(false);
    closeUserMenu();
    stickToBottomRef.current = true;
    setCooldown(true);
    setTimeout(() => setCooldown(false), 1500);

    await herzies.chatSend(content, refs, mentions);
    scrollToBottom();
  };

  const autocompleteItems = filterAutocompleteItems(
    inventory,
    autocompleteFilter,
  );
  const userAutocompleteItems = filterMentionableUsers(
    mentionableUsers,
    userAutocompleteFilter,
  );

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value;
    setInput(val);

    const cursorPos = e.target.selectionStart ?? val.length;
    const menu = getChatInputMenuState(val, cursorPos);
    if (menu.kind === "item") {
      setShowItemAutocomplete(true);
      setShowUserAutocomplete(false);
      setShowSlashCommands(false);
      setAutocompleteFilter(menu.filter);
      setAutocompleteIndex(0);
      autocompleteIndexRef.current = 0;
      itemHashPosRef.current = menu.triggerIdx;
      userAtPosRef.current = -1;
      slashPosRef.current = -1;
      return;
    }
    if (menu.kind === "user") {
      setShowUserAutocomplete(true);
      setShowItemAutocomplete(false);
      setShowSlashCommands(false);
      setUserAutocompleteFilter(menu.filter);
      setUserAutocompleteIndex(0);
      userAutocompleteIndexRef.current = 0;
      userAtPosRef.current = menu.triggerIdx;
      itemHashPosRef.current = -1;
      slashPosRef.current = -1;
      return;
    }
    if (menu.kind === "slash") {
      setShowSlashCommands(true);
      setShowItemAutocomplete(false);
      setShowUserAutocomplete(false);
      setSlashFilter(menu.filter);
      setSlashIndex(0);
      slashIndexRef.current = 0;
      slashPosRef.current = menu.triggerIdx;
      itemHashPosRef.current = -1;
      userAtPosRef.current = -1;
      return;
    }
    setShowItemAutocomplete(false);
    setShowUserAutocomplete(false);
    setShowSlashCommands(false);
  };

  const selectSlashCommand = (label: string) => {
    const sIdx = slashPosRef.current;
    if (sIdx < 0) return;
    const before = input.slice(0, sIdx);
    const cursorPos = inputRef.current?.selectionStart ?? input.length;
    const after = input.slice(cursorPos);
    const newInput = `${before}/${label} ${after}`;
    setInput(newInput);
    setShowSlashCommands(false);
    slashPosRef.current = -1;
    inputRef.current?.focus();
  };

  const selectAutocomplete = (itemId: string) => {
    const hashIdx = itemHashPosRef.current;
    if (hashIdx < 0) return;
    const before = input.slice(0, hashIdx);
    const cursorPos = inputRef.current?.selectionStart ?? input.length;
    const after = input.slice(cursorPos);
    const newInput = `${before}#${itemId} ${after}`;
    setInput(newInput);
    if (!itemRefs.includes(itemId)) {
      setItemRefs((prev) => [...prev, itemId]);
    }
    setShowItemAutocomplete(false);
    itemHashPosRef.current = -1;
    inputRef.current?.focus();
  };

  const selectUserMention = (user: MentionableChatUser) => {
    const atIdx = userAtPosRef.current;
    if (atIdx < 0) return;
    const before = input.slice(0, atIdx);
    const cursorPos = inputRef.current?.selectionStart ?? input.length;
    const after = input.slice(cursorPos);
    const newInput = `${before}@${user.name} ${after}`;
    setInput(newInput);
    if (!userRefs.includes(user.friendCode)) {
      setUserRefs((prev) => [...prev, user.friendCode]);
    }
    setShowUserAutocomplete(false);
    userAtPosRef.current = -1;
    inputRef.current?.focus();
  };

  chatKeyStateRef.current = {
    inventory: cachedInventory ?? inventory,
    mentionableUsers,
    userMenu,
    expanded,
    cooldown,
    input,
  };
  chatKeyActionsRef.current = {
    selectAutocomplete,
    selectUserMention,
    selectSlashCommand,
    handleSend,
    closeUserMenu,
    runUserMenuAction,
    collapseChat,
  };

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (!isChatMenuNavKey(e)) return;

      const inputEl = inputRef.current;
      if (
        !inputEl ||
        (e.target !== inputEl && document.activeElement !== inputEl)
      ) {
        return;
      }

      const state = chatKeyStateRef.current;
      const actions = chatKeyActionsRef.current;

      if (state.userMenu) {
        e.preventDefault();
        e.stopPropagation();
        if (e.key === "ArrowUp") {
          setUserMenuIndex((i) => {
            const next = Math.max(0, i - 1);
            userMenuIndexRef.current = next;
            return next;
          });
          return;
        }
        if (e.key === "ArrowDown") {
          setUserMenuIndex((i) => {
            const next = Math.min(USER_MENU_ITEMS.length - 1, i + 1);
            userMenuIndexRef.current = next;
            return next;
          });
          return;
        }
        if (e.key === "Enter") {
          const item = USER_MENU_ITEMS[userMenuIndexRef.current];
          if (item) void actions.runUserMenuAction(item.id);
          return;
        }
        if (e.key === "Escape") {
          actions.closeUserMenu();
          return;
        }
      }

      const val = inputEl.value;
      const cursorPos = inputEl.selectionStart ?? val.length;
      const menu = getChatInputMenuState(val, cursorPos);

      if (menu.kind === "item") {
        const items = filterAutocompleteItems(state.inventory, menu.filter);
        if (items.length > 0) {
          e.preventDefault();
          e.stopPropagation();
          setShowItemAutocomplete(true);
          setAutocompleteFilter(menu.filter);
          itemHashPosRef.current = menu.triggerIdx;

          if (e.key === "ArrowUp") {
            const next =
              autocompleteIndexRef.current <= 0
                ? items.length - 1
                : autocompleteIndexRef.current - 1;
            autocompleteIndexRef.current = next;
            setAutocompleteIndex(next);
            return;
          }
          if (e.key === "ArrowDown") {
            const next =
              autocompleteIndexRef.current >= items.length - 1
                ? 0
                : autocompleteIndexRef.current + 1;
            autocompleteIndexRef.current = next;
            setAutocompleteIndex(next);
            return;
          }
          if (e.key === "Tab" || e.key === "Enter") {
            const idx = Math.min(
              autocompleteIndexRef.current,
              items.length - 1,
            );
            const sel = items[idx];
            if (sel) actions.selectAutocomplete(sel.id);
            return;
          }
          if (e.key === "Escape") {
            setShowItemAutocomplete(false);
            return;
          }
        }
      }

      if (menu.kind === "user") {
        const users = filterMentionableUsers(
          state.mentionableUsers,
          menu.filter,
        );
        if (users.length > 0) {
          e.preventDefault();
          e.stopPropagation();
          setShowUserAutocomplete(true);
          setUserAutocompleteFilter(menu.filter);
          userAtPosRef.current = menu.triggerIdx;

          if (e.key === "ArrowUp") {
            const next =
              userAutocompleteIndexRef.current <= 0
                ? users.length - 1
                : userAutocompleteIndexRef.current - 1;
            userAutocompleteIndexRef.current = next;
            setUserAutocompleteIndex(next);
            return;
          }
          if (e.key === "ArrowDown") {
            const next =
              userAutocompleteIndexRef.current >= users.length - 1
                ? 0
                : userAutocompleteIndexRef.current + 1;
            userAutocompleteIndexRef.current = next;
            setUserAutocompleteIndex(next);
            return;
          }
          if (e.key === "Tab" || e.key === "Enter") {
            const idx = Math.min(
              userAutocompleteIndexRef.current,
              users.length - 1,
            );
            const sel = users[idx];
            if (sel) actions.selectUserMention(sel);
            return;
          }
          if (e.key === "Escape") {
            setShowUserAutocomplete(false);
            return;
          }
        }
      }

      if (menu.kind === "slash") {
        const items = filterSlashCommandItems(menu.filter);
        if (items.length > 0) {
          e.preventDefault();
          e.stopPropagation();
          setShowSlashCommands(true);
          setSlashFilter(menu.filter);
          slashPosRef.current = menu.triggerIdx;

          if (e.key === "ArrowUp") {
            const next =
              slashIndexRef.current <= 0
                ? items.length - 1
                : slashIndexRef.current - 1;
            slashIndexRef.current = next;
            setSlashIndex(next);
            return;
          }
          if (e.key === "ArrowDown") {
            const next =
              slashIndexRef.current >= items.length - 1
                ? 0
                : slashIndexRef.current + 1;
            slashIndexRef.current = next;
            setSlashIndex(next);
            return;
          }
          if (e.key === "Tab" || e.key === "Enter") {
            const idx = Math.min(slashIndexRef.current, items.length - 1);
            const sel = items[idx];
            if (sel) actions.selectSlashCommand(sel.label);
            return;
          }
          if (e.key === "Escape") {
            setShowSlashCommands(false);
            return;
          }
        }
      }

      if (e.key === "Escape" && state.expanded) {
        e.preventDefault();
        e.stopPropagation();
        actions.collapseChat();
        return;
      }
      if (e.key === "Enter" && menu.kind === "none") {
        e.preventDefault();
        e.stopPropagation();
        void actions.handleSend();
      }
    };

    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, []);

  const renderMessageContent = (
    content: string,
    msgItemRefs: string[],
    msgUserRefs: string[] = [],
  ) => {
    const parts: React.ReactNode[] = [];
    let k = 0;
    const nextKey = () => k++;

    if (msgItemRefs.length === 0 && msgUserRefs.length === 0) {
      pushTextWithLastFmLinks(parts, content, nextKey);
      return <>{parts}</>;
    }

    let remaining = content;
    while (remaining.length > 0) {
      let best: {
        idx: number;
        len: number;
        kind: "item" | "user";
        ref: string;
      } | null = null;

      for (const ref of msgItemRefs) {
        const hashPattern = `#${ref}`;
        const hashIdx = remaining.indexOf(hashPattern);
        if (hashIdx >= 0 && (!best || hashIdx < best.idx)) {
          best = { idx: hashIdx, len: hashPattern.length, kind: "item", ref };
        }
        // Legacy messages used @ for items before # was introduced.
        const legacyPattern = `@${ref}`;
        const legacyIdx = remaining.indexOf(legacyPattern);
        if (
          legacyIdx >= 0 &&
          (!best || legacyIdx < best.idx) &&
          !msgUserRefs.includes(ref)
        ) {
          best = {
            idx: legacyIdx,
            len: legacyPattern.length,
            kind: "item",
            ref,
          };
        }
      }
      for (const ref of msgUserRefs) {
        const name = nameByFriendCode.get(ref) ?? ref;
        const patterns = name === ref ? [`@${name}`] : [`@${name}`, `@${ref}`];
        for (const pattern of patterns) {
          const idx = remaining.indexOf(pattern);
          if (idx >= 0 && (!best || idx < best.idx)) {
            best = { idx, len: pattern.length, kind: "user", ref };
          }
        }
      }

      if (!best) {
        pushTextWithLastFmLinks(parts, remaining, nextKey);
        break;
      }

      if (best.idx > 0) {
        pushTextWithLastFmLinks(parts, remaining.slice(0, best.idx), nextKey);
      }

      if (best.kind === "item") {
        const item = getItem(best.ref);
        parts.push(
          <span
            key={nextKey()}
            className="cursor-pointer underline decoration-dotted"
            style={{
              color: item ? ITEM_RARITY_COLORS[item.rarity] : "#c084fc",
            }}
            onClick={() => setInspectItem(best.ref)}
          >
            {item?.name ?? best.ref}
          </span>,
        );
      } else {
        const name = nameByFriendCode.get(best.ref) ?? best.ref;
        const isMentionedViewer = best.ref === herzie.friendCode;
        parts.push(
          <span
            key={nextKey()}
            className={isMentionedViewer ? "text-cyan" : "text-text"}
          >
            @{name}
          </span>,
        );
      }

      remaining = remaining.slice(best.idx + best.len);
    }

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
      {expanded && (
        <button
          type="button"
          aria-label="Close chat"
          className="fixed inset-0 z-[200] cursor-default border-none bg-black/55 p-0"
          onMouseDown={(e) => {
            e.preventDefault();
            collapseChat();
          }}
        />
      )}

      <div
        className="shrink-0"
        style={expanded ? { height: dockHeight } : undefined}
      >
        <div
          ref={panelRef}
          className={cn(
            "flex flex-col border-t border-border",
            expanded &&
              "fixed inset-x-3 bottom-10 z-[201] h-[50vh] max-h-[50vh] bg-bg-panel shadow-[0_-8px_32px_rgba(0,0,0,0.45)] ring-1 ring-border",
          )}
        >
          <div
            ref={scrollRef}
            onScroll={handleFeedScroll}
            onKeyDown={(e) => {
              if (
                (showItemAutocomplete ||
                  showUserAutocomplete ||
                  showSlashCommands) &&
                (e.key === "ArrowUp" || e.key === "ArrowDown")
              ) {
                e.preventDefault();
              }
            }}
            className={cn(
              "min-h-5 overflow-auto py-0.5",
              expanded ? "min-h-0 flex-1" : "max-h-[58px]",
            )}
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
                    style={{
                      color: chatUserColor(
                        msg.friendCode ?? msg.userId ?? msg.username,
                      ),
                    }}
                    onClick={(e) => {
                      e.stopPropagation();
                      setUserMenu({
                        username: msg.username,
                        friendCode: msg.friendCode,
                      });
                      setUserMenuIndex(0);
                      setShowItemAutocomplete(false);
                      setShowUserAutocomplete(false);
                      setShowSlashCommands(false);
                    }}
                  >
                    {msg.username}
                  </button>
                  <span className="text-text-dim">:</span>{" "}
                  <span className="text-text">
                    {renderMessageContent(
                      msg.content,
                      msg.itemRefs,
                      msg.userRefs ?? [],
                    )}
                  </span>
                </div>
              );
            })}
            <div ref={bottomAnchorRef} aria-hidden className="h-0 shrink-0" />
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
                          i === userMenuIndex && DROPDOWN_ROW_ACTIVE_CLASS,
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
              {showItemAutocomplete &&
                autocompleteItems.length > 0 &&
                !userMenu && (
                  <div
                    ref={autocompleteListRef}
                    id="chat-item-autocomplete"
                    role="listbox"
                    aria-label="Inventory items"
                    className="absolute bottom-full left-0 right-0 z-[100] max-h-[88px] overflow-auto rounded border border-[#444] bg-bg-panel"
                  >
                    {autocompleteItems.map((x, i) => (
                      <button
                        key={x.id}
                        type="button"
                        role="option"
                        aria-selected={i === autocompleteIndex}
                        ref={(el) => {
                          autocompleteOptionRefs.current[i] = el;
                        }}
                        onMouseEnter={() => {
                          autocompleteIndexRef.current = i;
                          setAutocompleteIndex(i);
                        }}
                        onClick={() => selectAutocomplete(x.id)}
                        className={cn(
                          "block w-full border-none text-left",
                          DROPDOWN_ROW_CLASS,
                          i === autocompleteIndex && DROPDOWN_ROW_ACTIVE_CLASS,
                        )}
                        style={{
                          color: ITEM_RARITY_COLORS[x.item.rarity],
                          ...(i === autocompleteIndex
                            ? { filter: "brightness(1.25)" }
                            : undefined),
                        }}
                      >
                        {x.item.name}
                        <span className="ml-1 text-text-dim">
                          {RARITY_LABELS[x.item.rarity]}
                        </span>
                      </button>
                    ))}
                  </div>
                )}
              {showUserAutocomplete &&
                userAutocompleteItems.length > 0 &&
                !userMenu && (
                  <div
                    id="chat-user-autocomplete"
                    role="listbox"
                    aria-label="Mention people"
                    className="absolute bottom-full left-0 right-0 z-[100] max-h-[88px] overflow-auto rounded border border-[#444] bg-bg-panel"
                  >
                    {userAutocompleteItems.map((u, i) => (
                      <button
                        key={u.friendCode}
                        type="button"
                        role="option"
                        aria-selected={i === userAutocompleteIndex}
                        ref={(el) => {
                          userOptionRefs.current[i] = el;
                        }}
                        onMouseEnter={() => {
                          userAutocompleteIndexRef.current = i;
                          setUserAutocompleteIndex(i);
                        }}
                        onClick={() => selectUserMention(u)}
                        className={cn(
                          "block w-full border-none text-left",
                          DROPDOWN_ROW_CLASS,
                          i === userAutocompleteIndex &&
                            DROPDOWN_ROW_ACTIVE_CLASS,
                        )}
                      >
                        <span className="text-cyan">@{u.name}</span>
                      </button>
                    ))}
                  </div>
                )}
              {showSlashCommands &&
                slashCommandItems.length > 0 &&
                !userMenu && (
                  <div
                    id="chat-slash-autocomplete"
                    className="absolute bottom-full left-0 right-0 z-[100] max-h-[88px] overflow-auto rounded border border-[#444] bg-bg-panel"
                  >
                    {slashCommandItems.map((cmd, i) => (
                      <button
                        key={cmd.id}
                        type="button"
                        role="option"
                        aria-selected={i === slashIndex}
                        onMouseEnter={() => {
                          slashIndexRef.current = i;
                          setSlashIndex(i);
                        }}
                        onClick={() => selectSlashCommand(cmd.label)}
                        className={cn(
                          "block w-full border-none text-left",
                          DROPDOWN_ROW_CLASS,
                          i === slashIndex && DROPDOWN_ROW_ACTIVE_CLASS,
                        )}
                      >
                        <span className="text-[#d51007]">/{cmd.label}</span>
                        <span className="ml-1 text-text-dim">
                          {cmd.description}
                        </span>
                      </button>
                    ))}
                  </div>
                )}
              <div className="flex gap-0.5 py-0.5">
                <input
                  ref={inputRef}
                  className="input flex-1 text-[10px]"
                  placeholder="Message… # items · @ people · / commands"
                  value={input}
                  onChange={handleInputChange}
                  onFocus={handleInputFocus}
                  aria-autocomplete="list"
                  aria-expanded={
                    showItemAutocomplete ||
                    showUserAutocomplete ||
                    showSlashCommands
                  }
                  aria-controls={
                    showItemAutocomplete
                      ? "chat-item-autocomplete"
                      : showUserAutocomplete
                        ? "chat-user-autocomplete"
                        : showSlashCommands
                          ? "chat-slash-autocomplete"
                          : undefined
                  }
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
