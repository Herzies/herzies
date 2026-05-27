import type { Herzie, Inventory, Trade, TradeOffer } from "@herzies/shared";
import { Box, Text, useInput } from "ink";
import React, { useCallback, useEffect, useRef, useState } from "react";
import { getItem, RARITY_COLORS } from "../art/items.js";
import {
  apiAcceptTrade,
  apiCancelTrade,
  apiFetchInventory,
  apiLockTrade,
  apiPollTrade,
  apiUpdateTradeOffer,
} from "../storage/api.js";

const POLL_INTERVAL = 1500;

interface Props {
  herzie: Herzie;
  tradeId: string;
  onDone: (message: string, color: string) => void;
}

type Phase = "waiting" | "trading" | "adding" | "adding_currency";

export function TradingView({ herzie, tradeId, onDone }: Props) {
  const [trade, setTrade] = useState<Trade | null>(null);
  const [myInventory, setMyInventory] = useState<Inventory>({});
  const [myCurrency, setMyCurrency] = useState(herzie.currency);
  const [myOffer, setMyOffer] = useState<TradeOffer>({
    items: {},
    currency: 0,
  });
  const [phase, setPhase] = useState<Phase>("waiting");
  const [selected, setSelected] = useState(0);
  const [currencyInput, setCurrencyInput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const doneRef = useRef(false);

  // Determine if I'm initiator or target
  const amInitiator = trade ? trade.initiatorId === herzie.id : false;
  // Note: herzie.id is the herzie row id, trade uses user_id. We'll compare by name instead.
  const myName = herzie.name;

  const isMyLocked = useCallback(
    (t: Trade) => {
      const isInit = t.initiatorName === myName;
      if (t.state === "both_locked") return true;
      if (t.state === "initiator_locked" && isInit) return true;
      if (t.state === "target_locked" && !isInit) return true;
      return false;
    },
    [myName],
  );

  const isTheirLocked = useCallback(
    (t: Trade) => {
      const isInit = t.initiatorName === myName;
      if (t.state === "both_locked") return true;
      if (t.state === "initiator_locked" && !isInit) return true;
      if (t.state === "target_locked" && isInit) return true;
      return false;
    },
    [myName],
  );

  const finish = useCallback(
    (message: string, color: string) => {
      if (doneRef.current) return;
      doneRef.current = true;
      if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
      onDone(message, color);
    },
    [onDone],
  );

  // Load inventory and start polling
  useEffect(() => {
    apiFetchInventory().then((result) => {
      if (result) {
        setMyInventory(result.inventory);
        setMyCurrency(result.currency);
      }
    });

    const poll = async () => {
      if (doneRef.current) return;
      const t = await apiPollTrade(tradeId);
      if (!t || doneRef.current) return;

      setTrade(t);

      if (t.state === "completed") {
        finish("Trade completed!", "green");
        return;
      }
      if (t.state === "cancelled") {
        finish("Trade cancelled.", "yellow");
        return;
      }
      if (t.state !== "pending") {
        setPhase((prev) => (prev === "waiting" ? "trading" : prev));
      }
    };

    poll();
    pollRef.current = setInterval(poll, POLL_INTERVAL);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [tradeId]);

  // Sync my offer from trade state
  useEffect(() => {
    if (!trade) return;
    const isInit = trade.initiatorName === myName;
    const serverOffer = isInit ? trade.initiatorOffer : trade.targetOffer;
    setMyOffer(serverOffer);
  }, [trade?.state]);

  // Items available to add (own inventory minus what's already offered)
  const availableItems = Object.entries(myInventory)
    .map(([id, qty]) => {
      const offered = myOffer.items[id] ?? 0;
      return { id, available: qty - offered };
    })
    .filter((e) => e.available > 0);

  const myOfferEntries = Object.entries(myOffer.items).filter(
    ([, qty]) => qty > 0,
  );

  const theirOffer = trade
    ? trade.initiatorName === myName
      ? trade.targetOffer
      : trade.initiatorOffer
    : { items: {}, currency: 0 };
  const theirOfferEntries = Object.entries(theirOffer.items).filter(
    ([, qty]) => qty > 0,
  );

  const theirName = trade
    ? trade.initiatorName === myName
      ? trade.targetName
      : trade.initiatorName
    : "...";

  async function sendOffer(offer: TradeOffer) {
    setError(null);
    const ok = await apiUpdateTradeOffer(tradeId, offer);
    if (!ok) {
      setError("Failed to update offer");
    }
  }

  useInput((_input, key) => {
    if (phase === "adding_currency") {
      if (key.return) {
        const amount = parseInt(currencyInput, 10);
        if (!isNaN(amount) && amount >= 0 && amount <= myCurrency) {
          const newOffer = { ...myOffer, currency: amount };
          setMyOffer(newOffer);
          sendOffer(newOffer);
        }
        setPhase("trading");
        setCurrencyInput("");
        return;
      }
      if (key.escape) {
        setPhase("trading");
        setCurrencyInput("");
        return;
      }
      if (key.backspace || key.delete) {
        setCurrencyInput((s) => s.slice(0, -1));
        return;
      }
      if (/^\d$/.test(_input)) {
        setCurrencyInput((s) => s + _input);
        return;
      }
      return;
    }

    if (phase === "adding") {
      if (key.escape || _input === "q") {
        setPhase("trading");
        setSelected(0);
        return;
      }
      if (key.upArrow) {
        setSelected((s) => Math.max(0, s - 1));
      }
      if (key.downArrow) {
        setSelected((s) => Math.min(availableItems.length - 1, s + 1));
      }
      if (
        key.return &&
        availableItems.length > 0 &&
        selected < availableItems.length
      ) {
        const item = availableItems[selected];
        const newItems = { ...myOffer.items };
        newItems[item.id] = (newItems[item.id] ?? 0) + 1;
        const newOffer = { ...myOffer, items: newItems };
        setMyOffer(newOffer);
        sendOffer(newOffer);
        setPhase("trading");
        setSelected(0);
      }
      return;
    }

    // Trading phase
    if (key.escape || _input === "q") {
      apiCancelTrade(tradeId);
      finish("Trade cancelled.", "yellow");
      return;
    }

    if (!trade || phase !== "trading") return;

    const locked = isMyLocked(trade);

    // Don't allow modifications when locked
    if (!locked) {
      if (_input === "a") {
        setPhase("adding");
        setSelected(0);
        return;
      }
      if (_input === "c") {
        setPhase("adding_currency");
        setCurrencyInput(String(myOffer.currency));
        return;
      }
      if (_input === "r" && myOfferEntries.length > 0) {
        const idx = Math.min(selected, myOfferEntries.length - 1);
        if (idx >= 0) {
          const [itemId] = myOfferEntries[idx];
          const newItems = { ...myOffer.items };
          newItems[itemId] = (newItems[itemId] ?? 0) - 1;
          if (newItems[itemId] <= 0) delete newItems[itemId];
          const newOffer = { ...myOffer, items: newItems };
          setMyOffer(newOffer);
          sendOffer(newOffer);
        }
        return;
      }
    }

    if (_input === "l" && !locked) {
      apiLockTrade(tradeId);
      return;
    }

    if (key.return && trade.state === "both_locked") {
      apiAcceptTrade(tradeId);
      return;
    }

    if (key.upArrow) {
      setSelected((s) => Math.max(0, s - 1));
    }
    if (key.downArrow) {
      setSelected((s) => Math.min(myOfferEntries.length - 1, s + 1));
    }
  });

  if (!trade || phase === "waiting") {
    return (
      <Box flexDirection="column" padding={1}>
        <Text bold color="magenta">
          Waiting for trade partner to join...
        </Text>
        <Text dimColor>Press Esc to cancel</Text>
      </Box>
    );
  }

  const myLocked = isMyLocked(trade);
  const theirLocked = isTheirLocked(trade);
  const bothLocked = trade.state === "both_locked";

  const isInit = trade.initiatorName === myName;
  const myAccepted = isInit ? trade.initiatorAccepted : trade.targetAccepted;
  const theirAccepted = isInit ? trade.targetAccepted : trade.initiatorAccepted;

  // Adding item picker
  if (phase === "adding") {
    return (
      <Box flexDirection="column" padding={1}>
        <Text bold color="cyan">
          Add item to trade
        </Text>
        <Box marginTop={1} flexDirection="column">
          {availableItems.length === 0 ? (
            <Text dimColor>No items available to add.</Text>
          ) : (
            availableItems.map((item, i) => {
              const def = getItem(item.id);
              return (
                <Box key={item.id}>
                  <Text color={i === selected ? "yellow" : undefined}>
                    {i === selected ? "▸ " : "  "}
                  </Text>
                  <Text color={def ? RARITY_COLORS[def.rarity] : undefined}>
                    {def?.name ?? item.id}
                  </Text>
                  <Text dimColor> (x{item.available} available)</Text>
                </Box>
              );
            })
          )}
        </Box>
        <Box marginTop={1}>
          <Text dimColor>Enter to add · Esc to cancel</Text>
        </Box>
      </Box>
    );
  }

  // Currency input
  if (phase === "adding_currency") {
    return (
      <Box flexDirection="column" padding={1}>
        <Text bold color="cyan">
          Set currency offer (max ${myCurrency})
        </Text>
        <Box marginTop={1}>
          <Text>Amount: </Text>
          <Text color="yellow">{currencyInput || "0"}</Text>
          <Text> H</Text>
        </Box>
        <Box marginTop={1}>
          <Text dimColor>Type amount · Enter to confirm · Esc to cancel</Text>
        </Box>
      </Box>
    );
  }

  // Main trade view
  const COL_WIDTH = 24;

  return (
    <Box flexDirection="column" padding={1}>
      <Text bold color="magenta">
        ═══ Trade with {theirName} ═══
      </Text>

      {error && <Text color="red">{error}</Text>}

      <Box marginTop={1} flexDirection="row">
        {/* Your offer column */}
        <Box flexDirection="column" width={COL_WIDTH}>
          <Text bold underline>
            Your offer
          </Text>
          <Box flexDirection="column" marginTop={1}>
            {myOfferEntries.length === 0 && myOffer.currency === 0 ? (
              <Text dimColor> (empty)</Text>
            ) : (
              <>
                {myOfferEntries.map(([id, qty], i) => {
                  const def = getItem(id);
                  return (
                    <Box key={id}>
                      <Text
                        color={
                          i === selected && !myLocked ? "yellow" : undefined
                        }
                      >
                        {i === selected && !myLocked ? "▸ " : "  "}
                      </Text>
                      <Text color={def ? RARITY_COLORS[def.rarity] : undefined}>
                        {def?.name ?? id}
                      </Text>
                      {qty > 1 && <Text dimColor> x{qty}</Text>}
                    </Box>
                  );
                })}
                {myOffer.currency > 0 && (
                  <Text color="yellow"> ${myOffer.currency}</Text>
                )}
              </>
            )}
          </Box>
          <Box marginTop={1}>
            <Text color={myLocked ? "green" : "yellow"} bold>
              [{myLocked ? (myAccepted ? "ACCEPTED" : "LOCKED") : "UNLOCKED"}]
            </Text>
          </Box>
        </Box>

        {/* Divider */}
        <Box flexDirection="column" marginLeft={1} marginRight={1}>
          <Text dimColor>│</Text>
          <Text dimColor>│</Text>
          <Text dimColor>│</Text>
          <Text dimColor>│</Text>
          <Text dimColor>│</Text>
          <Text dimColor>│</Text>
        </Box>

        {/* Their offer column */}
        <Box flexDirection="column" width={COL_WIDTH}>
          <Text bold underline>
            {theirName}'s offer
          </Text>
          <Box flexDirection="column" marginTop={1}>
            {theirOfferEntries.length === 0 && theirOffer.currency === 0 ? (
              <Text dimColor> (empty)</Text>
            ) : (
              <>
                {theirOfferEntries.map(([id, qty]) => {
                  const def = getItem(id);
                  return (
                    <Box key={id}>
                      <Text> </Text>
                      <Text color={def ? RARITY_COLORS[def.rarity] : undefined}>
                        {def?.name ?? id}
                      </Text>
                      {qty > 1 && <Text dimColor> x{qty}</Text>}
                    </Box>
                  );
                })}
                {theirOffer.currency > 0 && (
                  <Text color="yellow"> ${theirOffer.currency}</Text>
                )}
              </>
            )}
          </Box>
          <Box marginTop={1}>
            <Text color={theirLocked ? "green" : "red"} bold>
              [
              {theirLocked
                ? theirAccepted
                  ? "ACCEPTED"
                  : "LOCKED"
                : "WAITING"}
              ]
            </Text>
          </Box>
        </Box>
      </Box>

      {/* Controls */}
      <Box marginTop={1} flexDirection="column">
        {!myLocked && (
          <Text dimColor>a add item · c set currency · r remove · l lock</Text>
        )}
        {bothLocked && !myAccepted && (
          <Text color="green" bold>
            Both locked! Press Enter to accept the trade.
          </Text>
        )}
        {bothLocked && myAccepted && !theirAccepted && (
          <Text color="yellow">Waiting for {theirName} to accept...</Text>
        )}
        <Text dimColor>Esc to cancel trade</Text>
      </Box>
    </Box>
  );
}
