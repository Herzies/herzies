import type {
  Equipped,
  GameEvent,
  MerchantStockView,
  MerchantView,
} from "@herzies/shared";
import { getItem } from "@herzies/shared";
import { useEffect, useState } from "react";
import { herzies } from "../tauri-bridge";
import { Coin } from "./Coin";
import ItemInspectOverlay from "./ItemInspectOverlay";
import { ItemRow } from "./ItemRow";
import { List } from "./List";
import { Tooltip } from "./Tooltip";

/** Why a line can't be bought right now, or null if it can. */
function blockedReason(line: MerchantStockView, currency: number) {
  if (line.remaining === 0) return "Sold out";
  if (line.perPlayerLimit != null && line.yourBought >= line.perPlayerLimit) {
    return "You've bought your share";
  }
  if (currency < line.price) return "Insufficient funds";
  return null;
}

/**
 * Good ol' George's stall. Prices and limits come from the live merchant
 * event (projected by buildMerchantConfig); the server re-checks everything
 * on buy, so the disabled states here are only a courtesy.
 */
export function MerchantPanel({
  event,
  currency,
  equipped,
  onBought,
  onLog,
}: {
  event: GameEvent;
  currency: number;
  equipped?: Equipped | null;
  /** Refetch events so remaining stock and "bought" counts catch up. */
  onBought: () => void;
  onLog?: (msg: string) => void;
}) {
  const view = event.config as unknown as MerchantView;
  const [pendingItemId, setPendingItemId] = useState<string | null>(null);
  const [inspectItemId, setInspectItemId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Optimistic "bought" bumps until the next poll brings real counts.
  const [boughtNow, setBoughtNow] = useState<Record<string, number>>({});
  // Fresh counts from the server already include those buys.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset on each new poll result
  useEffect(() => setBoughtNow({}), [event.config]);

  const stock = (view.stock ?? []).map((line) => {
    const extra = boughtNow[line.itemId] ?? 0;
    return {
      ...line,
      yourBought: line.yourBought + extra,
      remaining: line.remaining == null ? null : line.remaining - extra,
    };
  });

  const buy = async (itemId: string) => {
    setError(null);
    setPendingItemId(itemId);
    try {
      await herzies.buyFromMerchant(event.id, itemId, 1);
      setBoughtNow((b) => ({ ...b, [itemId]: (b[itemId] ?? 0) + 1 }));
      onLog?.(`Bought "${getItem(itemId)?.name ?? itemId}" from George`);
      onBought();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setPendingItemId(null);
    }
  };

  const inspected = stock.find((l) => l.itemId === inspectItemId);

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      {event.description ? (
        <div className="text-ui text-text-dim">{event.description}</div>
      ) : null}

      <List className="min-h-0 flex-1">
        {stock.length === 0 ? (
          <div className="text-ui text-text-dim">
            George has nothing left to sell.
          </div>
        ) : (
          stock.map((line) => {
            const reason = blockedReason(line, currency);
            const pending = pendingItemId === line.itemId;
            const button = (
              <button
                type="button"
                className="btn"
                disabled={!!reason || pendingItemId !== null}
                onClick={() => buy(line.itemId)}
              >
                {pending ? "Buying..." : "Buy"}
              </button>
            );
            const details = [
              line.remaining != null ? `${line.remaining} left` : null,
              line.perPlayerLimit != null
                ? `${line.yourBought}/${line.perPlayerLimit} bought`
                : line.yourBought > 0
                  ? `${line.yourBought} bought`
                  : null,
            ].filter(Boolean);
            return (
              <ItemRow
                key={line.itemId}
                itemId={line.itemId}
                onInspect={setInspectItemId}
                inspectTitle="Inspect card"
                colour="yellow"
                subtitle={
                  <>
                    <Coin amount={line.price} />
                    {details.length > 0 && ` · ${details.join(" · ")}`}
                  </>
                }
                action={
                  reason ? <Tooltip label={reason}>{button}</Tooltip> : button
                }
              />
            );
          })
        )}
      </List>

      {error && (
        <div className="pt-1 text-center text-[10px] text-red">{error}</div>
      )}

      {inspected && (
        <ItemInspectOverlay
          itemId={inspected.itemId}
          onClose={() => setInspectItemId(null)}
          equipped={equipped}
          meta={<Coin amount={inspected.price} />}
          footer={
            <button
              type="button"
              className="btn"
              disabled={
                !!blockedReason(inspected, currency) || pendingItemId !== null
              }
              onClick={() => buy(inspected.itemId)}
            >
              {pendingItemId === inspected.itemId ? "Buying..." : "Buy"}
            </button>
          }
        />
      )}
    </div>
  );
}
