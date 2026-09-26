import type {
  Equipped,
  GameEvent,
  MerchantStockView,
  MerchantView,
} from "@herzies/shared";
import {
  DEFAULT_Y_ANGLE,
  GOLD_SCHEME_ID,
  getItem,
  MERCHANT_NAME,
  Herzie3D as SharedHerzie3D,
} from "@herzies/shared";
import { useEffect, useState } from "react";
import { herzies } from "../tauri-bridge";
import { Coin } from "./Coin";
import { FloatingCoins } from "./FloatingCoins";
import ItemInspectOverlay from "./ItemInspectOverlay";
import { ItemRow } from "./ItemRow";
import { List } from "./List";
import { SpeechBubble, useChatter } from "./SpeechBubble";
import { Tooltip } from "./Tooltip";

/** George's look: one fixed seed, so he's the same herzie for everyone —
 * painted solid gold, because George is rich and wants you to know it. */
const GEORGE_SEED = "npc:good-ol-george";
const GEORGE_EQUIPPED = { color: GOLD_SCHEME_ID };

/** Good ol' George's sales patter, cycled in a speech bubble like the boss. */
const GEORGE_LINES = [
  "Psst. Over here. Good ol' George has what you need.",
  "Everything's legit. Mostly.",
  "Prices this good? I must be out of my mind.",
  "No refunds. No questions. No problem.",
  "Don't tell the other herzies about these prices.",
  "I've got a guy who's got a guy.",
  "You look like someone with taste. And coins.",
  "Fell off the back of a tour bus, this lot.",
  "Limited stock, friend. I can't hold it forever.",
  "Solid gold, baby. Hand-polished every morning.",
  "Business is booming. Thanks to people like you.",
  "Tell you what — for you? Same price. But with a smile.",
];

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
  paused,
}: {
  event: GameEvent;
  /** Tab hidden or window unfocused — stop the 3D frame timer and chatter. */
  paused: boolean;
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
  const { line, typed } = useChatter(GEORGE_LINES, !paused);

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      {/* His name as the heading, as BossFightPanel does with the boss's. */}
      <div className="text-center text-ui-2xl font-bold text-yellow">
        {MERCHANT_NAME}
      </div>

      {/* Same staging as BossFightPanel: George square-on, not spinning, with
          his patter in a bubble at his feet. A fixed height rather than
          flex-1, because here the stock list below is what needs the room. */}
      <div className="relative flex h-[190px] shrink-0 flex-col">
        <div className="flex min-h-0 flex-1 items-center justify-center overflow-hidden">
          <SharedHerzie3D
            userId={GEORGE_SEED}
            stage={2}
            size={5}
            cols={64}
            equipped={GEORGE_EQUIPPED}
            animate={false}
            defaultAngle={-DEFAULT_Y_ANGLE}
            draggable={false}
            paused={paused}
            ariaLabel="Good ol' George"
          />
        </div>
        <FloatingCoins paused={paused} />
        <SpeechBubble line={line} typed={typed} />
      </div>

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
