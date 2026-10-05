import type { Equipped, Inventory, PremiumItem } from "@herzies/shared";
import {
  BANK_EXPANSION,
  bankCapacity,
  getItem,
  hasRoomFor,
  MAX_BANK_EXPANSIONS,
} from "@herzies/shared";
import { useEffect, useRef, useState } from "react";
import { formatAmount, formatPrice } from "../lib/utils";
import { herzies, useWindowFocused } from "../tauri-bridge";
import { Coin } from "./Coin";
import { ExpansionInspectOverlay } from "./ExpansionInspectOverlay";
import ItemInspectOverlay, { inspectOrigin } from "./ItemInspectOverlay";
import { ItemRow } from "./ItemRow";
import { BankExpansionIcon } from "./icons/BankExpansionIcon";
import { List } from "./List";
import { Tooltip } from "./Tooltip";

/**
 * The Premium tab: Inventory Expansions and whatever Stripe lists. It sells
 * nothing for coins — coins are spent with Good ol' George during his visits,
 * which is what keeps his stock worth turning up for. The balance still shows
 * here so the header reads the same on every tab.
 */

export function StoreView({
  inventory,
  currency,
  equipped,
  bankExpansions,
  active = true,
}: {
  inventory: Inventory | null;
  currency: number;
  /** Current deck, used to show set progress in the item preview. */
  equipped: Equipped;
  /** Inventory Expansions already bought — sets the bank's capacity. */
  bankExpansions: number;
  /** False while another tab is shown. */
  active?: boolean;
}) {
  const capacity = bankCapacity(bankExpansions);
  const [premium, setPremium] = useState<PremiumItem[] | null>(null);
  const [pendingProductId, setPendingProductId] = useState<string | null>(null);
  const [inspectItem, setInspectItem] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const focused = useWindowFocused();
  const prevFocusedRef = useRef(focused);

  useEffect(() => {
    // Falls back to an empty list so a broken feed can't blank the store —
    // but says so first. Silently swallowing made "the call failed" and
    // "nothing is for sale" look identical, which is precisely the case you
    // need to tell apart when a product isn't showing up.
    herzies
      .fetchPremiumItems()
      .then(setPremium)
      .catch((e: unknown) => {
        console.error("[store] fetchPremiumItems failed:", e);
        setPremium([]);
      });
  }, []);

  // Currency purchases complete in the browser and are credited by a
  // webhook — there is no synchronous "done" signal. Once the window regains
  // focus (the user came back from checkout), clear the pending state and
  // refetch the balance so a completed purchase shows up without restarting
  // the app.
  useEffect(() => {
    if (!prevFocusedRef.current && focused) {
      setPendingProductId(null);
      if (active) herzies.fetchInventory();
    }
    prevFocusedRef.current = focused;
  }, [focused, active]);

  const handleBuyCurrency = async (productId: string) => {
    setError(null);
    setPendingProductId(productId);
    try {
      const openedBrowser = await herzies.startPurchase(productId);
      // Test-mode bypass: the order was already fulfilled server-side and
      // AppState was refreshed before this resolved, so there's nothing to
      // wait for.
      if (!openedBrowser) setPendingProductId(null);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
      setPendingProductId(null);
    }
  };

  /** Premium listings by item id — the join back to the bundled catalog. */
  const premiumByItem = new Map((premium ?? []).map((p) => [p.itemId, p]));

  /** Everything Stripe is selling, as catalog entries. */
  // The Inventory Expansion arrives in the same list but is not a catalog item,
  // so it is picked out here and rendered on its own (first on the shelf).
  const expansionListing = premiumByItem.get(BANK_EXPANSION.id);
  const expansionMaxed = bankExpansions >= MAX_BANK_EXPANSIONS;
  const expansionPending = pendingProductId === BANK_EXPANSION.id;
  const premiumItems = (premium ?? []).flatMap((p) => {
    const def = getItem(p.itemId);
    return def ? [def] : [];
  });

  const inspected = inspectItem ? getItem(inspectItem) : null;
  const inspectedIsExpansion = inspectItem === BANK_EXPANSION.id;
  const inspectedOwned = inspectItem ? (inventory?.[inspectItem] ?? 0) : 0;
  // Same rule as the list: owning one is no reason not to buy another, but
  // having nowhere to put it is.
  const inspectedNoRoom =
    !!inspectItem &&
    !!inspected &&
    !hasRoomFor(inventory, equipped, inspectItem, capacity);
  const inspectedPaid = inspectItem
    ? premiumByItem.get(inspectItem)
    : undefined;

  // Built as parts rather than one fragment so a card with no listing (one
  // inspected after Stripe dropped it) shows no price rather than a bare 0.
  const inspectedPriceNode = inspectedPaid
    ? formatPrice(inspectedPaid.amount, inspectedPaid.currency)
    : null;
  const inspectedOwnedText =
    inspectedOwned > 0 ? `${inspectedOwned} owned` : null;
  const inspectedMeta =
    inspectedPriceNode && inspectedOwnedText ? (
      <>
        {inspectedPriceNode} · {inspectedOwnedText}
      </>
    ) : (
      (inspectedPriceNode ?? inspectedOwnedText ?? undefined)
    );

  return (
    <div className="flex h-full flex-col">
      <div className="z-50 mb-4 flex items-center justify-between">
        <h1 className="text-ui-lg font-bold text-yellow">Premium</h1>
        <Tooltip label={`${formatAmount(currency)} herzie coins`}>
          <div className="text-ui text-yellow">
            <Coin amount={currency} animate />
          </div>
        </Tooltip>
      </div>

      <p className="mb-2 text-[11px] text-text-dim leading-snug">
        {/* Deliberately doesn't claim these are unobtainable elsewhere: a
            listing is just a Stripe product, so nothing stops a droppable card
            being sold here too — and every item is tradable, so even a
            shop-only one can reach a player who never paid. */}
        Herzies is a one-person passion project. Buying here supports its
        development.
      </p>
      <List className="min-h-0 flex-1">
        {premium === null ? (
          <div className="pt-5 text-center text-ui text-text-dim">
            Loading...
          </div>
        ) : premiumItems.length === 0 && !expansionListing ? (
          <div className="pt-5 text-center text-ui text-text-dim">
            Nothing here right now.
          </div>
        ) : (
          <>
            {expansionListing && (
              <ItemRow
                itemId={BANK_EXPANSION.id}
                name={BANK_EXPANSION.name}
                icon={
                  <BankExpansionIcon className="h-6 w-6 shrink-0 text-yellow" />
                }
                onInspect={setInspectItem}
                inspectTitle="Inspect expansion"
                colour="yellow"
                subtitle={
                  <>
                    {formatPrice(
                      expansionListing.amount,
                      expansionListing.currency,
                    )}
                    {bankExpansions > 0 &&
                      ` · ${bankExpansions}/${MAX_BANK_EXPANSIONS} bought`}
                  </>
                }
                action={
                  expansionMaxed ? (
                    <Tooltip label="You already have the maximum inventory size">
                      <button type="button" className="btn" disabled>
                        Maxed
                      </button>
                    </Tooltip>
                  ) : (
                    <button
                      type="button"
                      className="btn"
                      disabled={expansionPending}
                      onClick={() => handleBuyCurrency(BANK_EXPANSION.id)}
                    >
                      {expansionPending ? "Buying..." : "Buy"}
                    </button>
                  )
                }
              />
            )}
            {premiumItems.map((item) => {
              const paid = premiumByItem.get(item.id);
              if (!paid) return null;
              const owned = inventory?.[item.id] ?? 0;
              // Duplicates are fine — items are tradable, so a spare is a
              // legitimate thing to buy. Having nowhere to put it is not:
              // anything past the bank's capacity doesn't render, so it would
              // be bought and invisible. The webhook can't refuse after
              // payment, so this check is the one that matters.
              const noRoom = !hasRoomFor(
                inventory,
                equipped,
                item.id,
                capacity,
              );
              // Purchases leave for the browser and are credited by the
              // webhook — see the refresh-on-return effect above.
              const pending = pendingProductId === item.id;
              const buyButton = (
                <button
                  type="button"
                  className="btn"
                  disabled={noRoom || pending}
                  onClick={() => handleBuyCurrency(item.id)}
                >
                  {pending ? "Buying..." : "Buy"}
                </button>
              );
              return (
                <ItemRow
                  key={item.id}
                  itemId={item.id}
                  onInspect={setInspectItem}
                  inspectTitle="Inspect card"
                  colour="yellow"
                  // The price always shows, since it can always be bought
                  // again; how many you already hold rides alongside it
                  // rather than replacing it.
                  subtitle={
                    <>
                      {formatPrice(paid.amount, paid.currency)}
                      {owned > 0 && ` · ${owned} owned`}
                    </>
                  }
                  action={
                    noRoom ? (
                      <Tooltip label="Bank full — sell something first">
                        {buyButton}
                      </Tooltip>
                    ) : (
                      buyButton
                    )
                  }
                />
              );
            })}
          </>
        )}
      </List>

      {pendingProductId && (
        <div className="border-t border-border pt-2 text-center text-[10px] text-text-dim">
          Complete your purchase in the browser — your balance updates
          automatically.
        </div>
      )}

      {error && (
        <div className="pt-1 text-center text-[10px] text-red">{error}</div>
      )}

      {inspectedIsExpansion && expansionListing && (
        <ExpansionInspectOverlay
          onClose={() => setInspectItem(null)}
          meta={
            <>
              {formatPrice(expansionListing.amount, expansionListing.currency)}
              {` · ${bankExpansions}/${MAX_BANK_EXPANSIONS} bought`}
            </>
          }
          footer={
            <button
              type="button"
              className="btn"
              disabled={expansionMaxed || expansionPending}
              onClick={() => handleBuyCurrency(BANK_EXPANSION.id)}
            >
              {expansionMaxed
                ? "Maxed"
                : expansionPending
                  ? "Buying..."
                  : `Buy (${formatPrice(expansionListing.amount, expansionListing.currency)})`}
            </button>
          }
        />
      )}

      {inspectItem && inspected && (
        <ItemInspectOverlay
          itemId={inspectItem}
          origin={inspectOrigin(inspectItem)}
          onClose={() => setInspectItem(null)}
          equipped={equipped}
          meta={inspectedMeta}
          footer={
            // Cards are bought the same way here as in the list:
            // through the browser, credited by the webhook. Without this the
            // overlay was a dead end for exactly the cards the store most
            // wants to sell.
            inspectedPaid
              ? (() => {
                  const pending = pendingProductId === inspectItem;
                  const paidButton = (
                    <button
                      type="button"
                      className="btn"
                      disabled={inspectedNoRoom || pending}
                      onClick={() => handleBuyCurrency(inspectItem)}
                    >
                      {pending
                        ? "Buying..."
                        : `Buy (${formatPrice(inspectedPaid.amount, inspectedPaid.currency)})`}
                    </button>
                  );
                  return inspectedNoRoom ? (
                    <Tooltip label="Bank full — sell something first">
                      {paidButton}
                    </Tooltip>
                  ) : (
                    paidButton
                  );
                })()
              : undefined
          }
        />
      )}
    </div>
  );
}
