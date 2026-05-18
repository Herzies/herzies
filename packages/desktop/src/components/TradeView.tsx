import type { Herzie, Inventory, Trade } from "@herzies/shared";
import { getItem } from "@herzies/shared";
import { useCallback, useEffect, useRef, useState } from "react";
import { herzies, useWindowFocused } from "../tauri-bridge";
import { NumberTicker } from "./NumberTicker";
import { btnStyle, inputStyle } from "./styles";

export function TradeView({
  herzie,
  initialTarget,
  initialTradeId,
  onClose,
}: {
  herzie: Herzie;
  initialTarget?: string | null;
  initialTradeId?: string | null;
  onClose: () => void;
}) {
  const [targetCode, setTargetCode] = useState(initialTarget ?? "");
  const [tradeId, setTradeId] = useState<string | null>(initialTradeId ?? null);
  const [trade, setTrade] = useState<Trade | null>(null);
  const [message, setMessage] = useState("");
  const creatingRef = useRef(false);
  const joiningRef = useRef(false);
  const [inventory, setInventory] = useState<Inventory | null>(null);
  const [offerItems, setOfferItems] = useState<Record<string, number>>({});
  const [offerCurrency, setOfferCurrency] = useState(0);
  const [currency, setCurrency] = useState(herzie.currency);
  const focused = useWindowFocused();

  useEffect(() => {
    herzies.fetchInventory().then((data) => {
      if (data) {
        setInventory(data.inventory);
        setCurrency(data.currency);
      }
    });
  }, []);

  // Poll active trade — pauses while window is hidden; the user can't act on
  // a trade they can't see, and the sync_loop will surface trade requests via
  // notifications when the window reopens.
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

  // Auto-start trade when opened from friends list
  useEffect(() => {
    if (initialTarget && !tradeId) {
      handleCreate(initialTarget);
    }
  }, [initialTarget]); // eslint-disable-line react-hooks/exhaustive-deps

  // Auto-join an incoming trade when opened from a notification
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
    await herzies.tradeOffer(tradeId, { items, currency: offerCurrency });
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

  // No active trade — show create form or loading if auto-starting
  if (!tradeId) {
    if (initialTarget) {
      return (
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            height: "100%",
            justifyContent: "center",
            alignItems: "center",
          }}
        >
          <div style={{ fontSize: 12, color: "#888" }}>
            {message || "Starting trade..."}
          </div>
        </div>
      );
    }
    return (
      <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
        <div
          style={{
            fontSize: 13,
            fontWeight: "bold",
            color: "#c084fc",
            marginBottom: 8,
          }}
        >
          Trade
        </div>

        <div style={{ display: "flex", gap: 4, marginBottom: 8 }}>
          <input
            style={{ ...inputStyle, flex: 1 }}
            placeholder="Friend code to trade with"
            value={targetCode}
            onChange={(e) => setTargetCode(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleCreate()}
          />
          <button style={btnStyle} onClick={() => handleCreate()}>
            Start
          </button>
        </div>

        {message && (
          <div style={{ fontSize: 11, color: "#f87171" }}>{message}</div>
        )}

        <div
          style={{
            fontSize: 12,
            color: "#555",
            textAlign: "center",
            paddingTop: 20,
          }}
        >
          Enter a friend's code to start a trade
        </div>
      </div>
    );
  }

  // Active trade
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
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginBottom: 8,
        }}
      >
        <div style={{ fontSize: 13, fontWeight: "bold", color: "#c084fc" }}>
          Trading with{" "}
          {trade
            ? trade.initiatorName === herzie.name
              ? trade.targetName
              : trade.initiatorName
            : "..."}
        </div>
        <button
          style={{ ...btnStyle, fontSize: 10, color: "#f87171" }}
          onClick={handleCancel}
        >
          Cancel
        </button>
      </div>

      {!trade || trade.state === "pending" ? (
        <div
          style={{
            fontSize: 12,
            color: "#555",
            textAlign: "center",
            paddingTop: 20,
          }}
        >
          Waiting for them to join...
        </div>
      ) : (
        <>
          {/* Offers side by side */}
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "1fr 1fr",
              gap: 8,
              flex: 1,
            }}
          >
            <div>
              <div style={{ fontSize: 11, color: "#888", marginBottom: 4 }}>
                Your offer {myLocked ? "🔒" : ""}
              </div>
              {myLocked ? (
                <>
                  {myOffer &&
                    Object.entries(myOffer.items).map(([id, qty]) => (
                      <div key={id} style={{ fontSize: 11, color: "#ccc" }}>
                        {getItem(id)?.name ?? id} x{qty}
                      </div>
                    ))}
                  {myOffer && myOffer.currency > 0 && (
                    <div style={{ fontSize: 11, color: "#facc15" }}>
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
                            style={{
                              display: "flex",
                              alignItems: "center",
                              gap: 4,
                              marginBottom: 2,
                            }}
                          >
                            <span
                              style={{ fontSize: 10, color: "#ccc", flex: 1 }}
                            >
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
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 4,
                      marginTop: 4,
                    }}
                  >
                    <span style={{ fontSize: 10, color: "#facc15", flex: 1 }}>
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
              <div style={{ fontSize: 11, color: "#888", marginBottom: 4 }}>
                Their offer
              </div>
              {theirOffer &&
                Object.entries(theirOffer.items).map(([id, qty]) => (
                  <div key={id} style={{ fontSize: 11, color: "#ccc" }}>
                    {id} x{qty}
                  </div>
                ))}
              {theirOffer && theirOffer.currency > 0 && (
                <div style={{ fontSize: 11, color: "#facc15" }}>
                  ${theirOffer.currency}
                </div>
              )}
              {theirOffer &&
                Object.keys(theirOffer.items).length === 0 &&
                theirOffer.currency === 0 && (
                  <div style={{ fontSize: 10, color: "#ccc" }}>Empty</div>
                )}
            </div>
          </div>

          {/* Actions */}
          <div style={{ display: "flex", gap: 4, marginTop: 8 }}>
            {!myLocked && (
              <button style={btnStyle} onClick={handleLock}>
                Lock offer
              </button>
            )}
            {bothLocked && (
              <button
                style={{ ...btnStyle, color: "#4ade80" }}
                onClick={handleAccept}
              >
                Accept
              </button>
            )}
          </div>
        </>
      )}

      {message && (
        <div style={{ fontSize: 11, color: "#4ade80", marginTop: 8 }}>
          {message}
        </div>
      )}
    </div>
  );
}
