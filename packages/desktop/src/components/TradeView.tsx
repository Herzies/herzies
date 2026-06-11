import type { Herzie, Inventory, Trade } from "@herzies/shared";
import { getItem } from "@herzies/shared";
import { useCallback, useEffect, useRef, useState } from "react";
import { cn } from "../lib/utils";
import { herzies } from "../tauri-bridge";
import { NumberTicker } from "./NumberTicker";
import { PromptOverlay } from "./PromptOverlay";

/** How often we poll `/trade/status` while a trade is open (ms). */
const TRADE_POLL_MS = 650;

export function TradeView({
  herzie,
  initialTarget,
  initialTradeId,
  inventory: cachedInventory,
  currency: cachedCurrency,
  onClose,
  onActiveChange,
}: {
  herzie: Herzie;
  initialTarget?: string | null;
  initialTradeId?: string | null;
  inventory: Inventory | null;
  currency: number;
  onClose: () => void;
  /** Reports whether a live (non-terminal) trade session is open, so the app shell can confirm before navigating away. */
  onActiveChange?: (active: boolean) => void;
}) {
  const [targetCode, setTargetCode] = useState(initialTarget ?? "");
  const [tradeId, setTradeId] = useState<string | null>(initialTradeId ?? null);
  const [trade, setTrade] = useState<Trade | null>(null);
  const [message, setMessage] = useState("");
  const [confirmCancel, setConfirmCancel] = useState(false);
  const creatingRef = useRef(false);
  const [inventory, setInventory] = useState<Inventory | null>(cachedInventory);
  const [offerItems, setOfferItems] = useState<Record<string, number>>({});
  const [offerCurrency, setOfferCurrency] = useState(0);
  const [currency, setCurrency] = useState(cachedCurrency || herzie.currency);
  const lastSentOfferRef = useRef<string | null>(null);
  const closeScheduledRef = useRef(false);

  const onActiveChangeRef = useRef(onActiveChange);
  onActiveChangeRef.current = onActiveChange;
  const tradeActive =
    !!tradeId && trade?.state !== "completed" && trade?.state !== "cancelled";
  useEffect(() => {
    onActiveChangeRef.current?.(tradeActive);
  }, [tradeActive]);
  useEffect(() => () => onActiveChangeRef.current?.(false), []);

  const refreshTrade = useCallback(async () => {
    if (!tradeId) return null;
    const t = await herzies.tradePoll(tradeId);
    if (t) setTrade(t);
    return t;
  }, [tradeId]);

  useEffect(() => {
    setInventory(cachedInventory);
    setCurrency(cachedCurrency || herzie.currency);
  }, [cachedInventory, cachedCurrency, herzie.currency]);

  useEffect(() => {
    herzies.fetchInventory().then((data) => {
      if (data) {
        setInventory(data.inventory);
        setCurrency(data.currency);
      }
    });
  }, []);

  // Hydrate + keep trade fresh. Poll even when the window is blurred so partner
  // lock/accept updates arrive quickly (trade sessions are short-lived).
  useEffect(() => {
    if (!tradeId) return;
    let cancelled = false;

    const tick = async () => {
      const t = await herzies.tradePoll(tradeId);
      if (cancelled) return;
      if (t) setTrade(t);
      if (t?.state === "completed" || t?.state === "cancelled") {
        setMessage(
          t.state === "completed" ? "Trade completed!" : "Trade cancelled",
        );
        if (!closeScheduledRef.current) {
          closeScheduledRef.current = true;
          setTimeout(() => {
            closeScheduledRef.current = false;
            onClose();
          }, 2000);
        }
      }
    };

    void tick();
    const interval = setInterval(tick, TRADE_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [tradeId, onClose]);

  const handleCreate = useCallback(
    async (overrideCode?: string) => {
      const code = (overrideCode ?? targetCode).trim().toUpperCase();
      if (!code) return;
      if (creatingRef.current) return;
      creatingRef.current = true;
      const result = await herzies.tradeCreate(code);
      creatingRef.current = false;
      if (result) {
        setTradeId(result.tradeId);
        setTargetCode("");
      } else setMessage("Failed to create trade");
    },
    [targetCode],
  );

  useEffect(() => {
    if (initialTarget && !tradeId) {
      handleCreate(initialTarget);
    }
  }, [initialTarget]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!initialTradeId) return;
    let cancelled = false;
    (async () => {
      const ok = await herzies.tradeJoin(initialTradeId);
      if (cancelled) return;
      if (ok) {
        setTradeId(initialTradeId);
        return;
      }
      // Join fails for already-active trades (rejoining from the Trades tab,
      // strict-mode double-join) and for initiators (only targets can join).
      // Fall back to the trade status: any live trade is fine to re-enter, and
      // a pending one is too when we're the initiator still waiting.
      const t = await herzies.tradePoll(initialTradeId);
      if (cancelled) return;
      const live = t && t.state !== "cancelled" && t.state !== "completed";
      if (live && (t.state !== "pending" || t.initiatorName === herzie.name)) {
        setTradeId(initialTradeId);
      } else {
        setMessage("Couldn't join trade — it may have expired");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [initialTradeId, herzie.name]);

  const handleCancel = async () => {
    if (tradeId) await herzies.tradeCancel(tradeId);
    onClose();
  };

  const handleCancelClick = () => {
    if (tradeActive) {
      setConfirmCancel(true);
    } else {
      void handleCancel();
    }
  };

  const handleSendOffer = async () => {
    if (!tradeId) return;
    const items: Record<string, number> = {};
    for (const [id, qty] of Object.entries(offerItems)) {
      if (qty > 0) items[id] = qty;
    }
    const payload = { items, currency: offerCurrency };
    const serialized = JSON.stringify(payload);
    if (lastSentOfferRef.current === serialized) return;
    lastSentOfferRef.current = serialized;
    await herzies.tradeOffer(tradeId, payload);
  };

  const handleLock = async () => {
    if (!tradeId) return;
    await handleSendOffer();
    const ok = await herzies.tradeLock(tradeId);
    const t = await refreshTrade();
    if (!ok) {
      setMessage("Couldn't lock offer — try again");
    } else if (t) {
      setMessage("");
    }
  };

  const handleAccept = async () => {
    if (!tradeId) return;
    const result = await herzies.tradeAccept(tradeId);
    await refreshTrade();
    if (result?.completed) {
      setMessage("Trade completed!");
      if (!closeScheduledRef.current) {
        closeScheduledRef.current = true;
        setTimeout(() => {
          closeScheduledRef.current = false;
          onClose();
        }, 2000);
      }
    } else if (result && !result.completed) {
      setMessage("You confirmed — waiting for them to confirm.");
    } else {
      setMessage("Couldn't confirm — try again");
    }
  };

  if (!tradeId) {
    if (initialTarget) {
      return (
        <div className="flex h-full flex-col items-center justify-center">
          <div className="text-ui text-text-dim">
            {message || "Starting trade..."}
          </div>
        </div>
      );
    }
    if (initialTradeId) {
      return (
        <div className="flex h-full flex-col items-center justify-center">
          <div className="text-ui text-text-dim">
            {message || "Joining trade..."}
          </div>
        </div>
      );
    }
    return (
      <div className="flex h-full flex-col">
        <div className="mb-2 text-ui-lg font-bold text-purple">Trade</div>

        <div className="mb-2 flex gap-1">
          <input
            className="input flex-1"
            placeholder="Friend code to trade with"
            value={targetCode}
            onChange={(e) => setTargetCode(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleCreate()}
          />
          <button className="btn" onClick={() => handleCreate()}>
            Start
          </button>
        </div>

        {message && <div className="text-ui text-red">{message}</div>}

        <div className="pt-5 text-center text-ui text-text-dim">
          Enter a friend's code to start a trade
        </div>
      </div>
    );
  }

  const myOffer = trade
    ? trade.initiatorName === herzie.name
      ? trade.initiatorOffer
      : trade.targetOffer
    : null;
  const theirOffer = trade
    ? trade.initiatorName === herzie.name
      ? trade.targetOffer
      : trade.initiatorOffer
    : null;
  const myLocked = trade
    ? trade.initiatorName === herzie.name
      ? trade.state === "initiator_locked" || trade.state === "both_locked"
      : trade.state === "target_locked" || trade.state === "both_locked"
    : false;
  const bothLocked = trade?.state === "both_locked";
  const imInitiator = trade ? trade.initiatorName === herzie.name : false;
  const myAccepted = trade
    ? imInitiator
      ? trade.initiatorAccepted
      : trade.targetAccepted
    : false;
  const theirAccepted = trade
    ? imInitiator
      ? trade.targetAccepted
      : trade.initiatorAccepted
    : false;
  const tradeOver =
    trade?.state === "completed" || trade?.state === "cancelled";

  return (
    <div className="flex h-full flex-col">
      <div className="mb-2 flex items-center justify-between">
        <div className="text-ui-lg font-bold text-purple">
          Trading with{" "}
          {trade
            ? trade.initiatorName === herzie.name
              ? trade.targetName
              : trade.initiatorName
            : "..."}
        </div>
        {!tradeOver && (
          <button
            type="button"
            className="btn text-[10px] text-red"
            onClick={handleCancelClick}
          >
            Cancel
          </button>
        )}
      </div>

      {tradeOver ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-1">
          <div
            className={cn(
              "text-ui-lg font-bold",
              trade.state === "completed" ? "text-green" : "text-text-dim",
            )}
          >
            {trade.state === "completed"
              ? "Trade completed!"
              : "Trade cancelled"}
          </div>
          <div className="text-[10px] text-text-dim">Closing…</div>
        </div>
      ) : !trade || trade.state === "pending" ? (
        <div className="pt-5 text-center text-ui text-text-dim">
          Waiting for them to join...
        </div>
      ) : (
        <>
          <div className="grid flex-1 grid-cols-2 gap-2">
            <div>
              <div className="mb-1 text-ui text-text-dim">
                Your offer {myLocked ? "🔒" : ""}
              </div>
              {myLocked ? (
                <>
                  {myOffer &&
                    Object.entries(myOffer.items).map(([id, qty]) => (
                      <div key={id} className="text-ui text-text">
                        {getItem(id)?.name ?? id} x{qty}
                      </div>
                    ))}
                  {myOffer && myOffer.currency > 0 && (
                    <div className="text-ui text-yellow">
                      ${myOffer.currency}
                    </div>
                  )}
                </>
              ) : (
                <>
                  {inventory &&
                    Object.entries(inventory)
                      .filter(([, qty]) => qty > 0)
                      .map(([id, qty]) => {
                        const item = getItem(id);
                        if (!item) return null;
                        const offered = offerItems[id] ?? 0;
                        return (
                          <div
                            key={id}
                            className="mb-0.5 flex items-center gap-1"
                          >
                            <span className="flex-1 text-[10px] text-text">
                              {item.name} ({qty})
                            </span>
                            <NumberTicker
                              value={offered}
                              max={qty}
                              size="small"
                              onChange={(v) =>
                                setOfferItems((prev) => ({ ...prev, [id]: v }))
                              }
                            />
                          </div>
                        );
                      })}
                  <div className="mt-1 flex items-center gap-1">
                    <span className="flex-1 text-[10px] text-yellow">
                      $ ({currency})
                    </span>
                    <NumberTicker
                      value={offerCurrency}
                      max={currency}
                      size="small"
                      onChange={setOfferCurrency}
                    />
                  </div>
                </>
              )}
            </div>
            <div>
              <div className="mb-1 text-ui text-text-dim">Their offer</div>
              {theirOffer &&
                Object.entries(theirOffer.items).map(([id, qty]) => (
                  <div key={id} className="text-ui text-text">
                    {id} x{qty}
                  </div>
                ))}
              {theirOffer && theirOffer.currency > 0 && (
                <div className="text-ui text-yellow">
                  ${theirOffer.currency}
                </div>
              )}
              {theirOffer &&
                Object.keys(theirOffer.items).length === 0 &&
                theirOffer.currency === 0 && (
                  <div className="text-[10px] text-text">Empty</div>
                )}
            </div>
          </div>

          <div className="mt-2 flex flex-col gap-1">
            <div className="flex flex-wrap gap-1">
              {!myLocked && (
                <button type="button" className="btn" onClick={handleLock}>
                  Lock offer
                </button>
              )}
              {bothLocked && !myAccepted && (
                <button
                  type="button"
                  className="btn text-green"
                  onClick={handleAccept}
                >
                  Accept
                </button>
              )}
            </div>
            {bothLocked && myAccepted && !theirAccepted && (
              <div className="text-ui text-text-dim">
                You confirmed — waiting for them to confirm.
              </div>
            )}
            {bothLocked && !myAccepted && theirAccepted && (
              <div className="text-ui text-text-dim">
                They confirmed — press Accept to finish.
              </div>
            )}
          </div>
        </>
      )}

      {message && !tradeOver && (
        <div className="mt-2 text-ui text-green">{message}</div>
      )}

      {confirmCancel && (
        <PromptOverlay
          title="Cancel trade?"
          titleId="cancel-trade-title"
          onEscape={() => setConfirmCancel(false)}
          actions={[
            {
              label: "Keep trading",
              colour: "text-text-dim",
              onClick: () => setConfirmCancel(false),
            },
            {
              label: "Cancel trade",
              colour: "text-red",
              onClick: () => {
                setConfirmCancel(false);
                void handleCancel();
              },
            },
          ]}
        >
          Are you sure you want to leave? This cancels the trade for both of
          you.
        </PromptOverlay>
      )}
    </div>
  );
}
