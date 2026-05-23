import type { Herzie, Inventory, Trade } from "@herzies/shared";
import { getItem } from "@herzies/shared";
import { useCallback, useEffect, useRef, useState } from "react";
import { herzies, useWindowFocused } from "../tauri-bridge";
import { NumberTicker } from "./NumberTicker";

export function TradeView({
  herzie,
  initialTarget,
  initialTradeId,
  inventory: cachedInventory,
  currency: cachedCurrency,
  onClose,
}: {
  herzie: Herzie;
  initialTarget?: string | null;
  initialTradeId?: string | null;
  inventory: Inventory | null;
  currency: number;
  onClose: () => void;
}) {
  const [targetCode, setTargetCode] = useState(initialTarget ?? "");
  const [tradeId, setTradeId] = useState<string | null>(initialTradeId ?? null);
  const [trade, setTrade] = useState<Trade | null>(null);
  const [message, setMessage] = useState("");
  const creatingRef = useRef(false);
  const joiningRef = useRef(false);
  const [inventory, setInventory] = useState<Inventory | null>(cachedInventory);
  const [offerItems, setOfferItems] = useState<Record<string, number>>({});
  const [offerCurrency, setOfferCurrency] = useState(0);
  const [currency, setCurrency] = useState(cachedCurrency || herzie.currency);
  const lastSentOfferRef = useRef<string | null>(null);
  const focused = useWindowFocused();

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

  useEffect(() => {
    if (!tradeId) return;
    if (!focused) return;
    const interval = setInterval(async () => {
      const t = await herzies.tradePoll(tradeId);
      if (t) setTrade(t);
      if (t?.state === "completed" || t?.state === "cancelled") {
        setMessage(
          t.state === "completed" ? "Trade completed!" : "Trade cancelled",
        );
        setTimeout(() => {
          onClose();
        }, 2000);
      }
    }, 1500);
    return () => clearInterval(interval);
  }, [tradeId, onClose, focused]);

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
    if (!initialTradeId || joiningRef.current) return;
    joiningRef.current = true;
    (async () => {
      const ok = await herzies.tradeJoin(initialTradeId);
      if (!ok) setMessage("Couldn't join trade — it may have expired");
    })();
  }, [initialTradeId]);

  const handleCancel = async () => {
    if (tradeId) await herzies.tradeCancel(tradeId);
    onClose();
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
    if (tradeId) {
      await handleSendOffer();
      await herzies.tradeLock(tradeId);
    }
  };
  const handleAccept = async () => {
    if (tradeId) await herzies.tradeAccept(tradeId);
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
        <button className="btn text-[10px] text-red" onClick={handleCancel}>
          Cancel
        </button>
      </div>

      {!trade || trade.state === "pending" ? (
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

          <div className="mt-2 flex gap-1">
            {!myLocked && (
              <button className="btn" onClick={handleLock}>
                Lock offer
              </button>
            )}
            {bothLocked && (
              <button className="btn text-green" onClick={handleAccept}>
                Accept
              </button>
            )}
          </div>
        </>
      )}

      {message && <div className="mt-2 text-ui text-green">{message}</div>}
    </div>
  );
}
