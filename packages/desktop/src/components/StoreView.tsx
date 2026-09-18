import type { Equipped, Inventory, PremiumItem } from "@herzies/shared";
import { getItem, hasRoomFor, ITEMS } from "@herzies/shared";
import { useEffect, useRef, useState } from "react";
import { formatAmount, formatPrice } from "../lib/utils";
import { herzies, useWindowFocused } from "../tauri-bridge";
import { Coin } from "./Coin";
import ItemInspectOverlay from "./ItemInspectOverlay";
import { ItemRow } from "./ItemRow";
import { List } from "./List";
import { TabButton } from "./TabButton";
import { Tooltip } from "./Tooltip";

/** Two shelves, split by what you pay with rather than by what you get. */
type StoreTab = "premium" | "coins";

const BUYABLE_ITEMS = ITEMS.filter((item) => item.buyPrice != null);

export function StoreView({
  inventory: cachedInventory,
  currency: cachedCurrency,
  equipped,
  active = true,
  onLog,
}: {
  inventory: Inventory | null;
  currency: number;
  /** Current deck, used to show set progress in the item preview. */
  equipped: Equipped;
  /** False while another tab is shown. */
  active?: boolean;
  onLog?: (msg: string) => void;
}) {
  const [tab, setTab] = useState<StoreTab>("premium");
  const [inventory, setInventory] = useState(cachedInventory);
  const [currency, setCurrency] = useState(cachedCurrency);
  const [premium, setPremium] = useState<PremiumItem[] | null>(null);
  const [pendingProductId, setPendingProductId] = useState<string | null>(null);
  const [pendingItemId, setPendingItemId] = useState<string | null>(null);
  const [inspectItem, setInspectItem] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const focused = useWindowFocused();
  const prevFocusedRef = useRef(focused);

  useEffect(() => {
    setInventory(cachedInventory);
    setCurrency(cachedCurrency);
  }, [cachedInventory, cachedCurrency]);

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

  const handleBuyItem = async (itemId: string) => {
    setError(null);
    setPendingItemId(itemId);
    try {
      const result = await herzies.buyItem(itemId, 1);
      setInventory(result.inventory);
      setCurrency(result.newCurrency);
      onLog?.(`Bought "${getItem(itemId)?.name ?? itemId}"`);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setPendingItemId(null);
    }
  };

  /** Premium listings by item id — the join back to the bundled catalog. */
  const premiumByItem = new Map((premium ?? []).map((p) => [p.itemId, p]));

  /**
   * Everything Stripe is selling, as catalog entries. A premium listing wins
   * over a coin price for the same item, so putting something up in Stripe
   * moves it to this shelf by itself — there is no second place to remember
   * to take it off the coin one.
   */
  const premiumItems = (premium ?? []).flatMap((p) => {
    const def = getItem(p.itemId);
    return def ? [def] : [];
  });
  const coinItems = BUYABLE_ITEMS.filter((item) => !premiumByItem.has(item.id));
  const shopItems = tab === "premium" ? premiumItems : coinItems;

  const inspected = inspectItem ? getItem(inspectItem) : null;
  const inspectedOwned = inspectItem ? (inventory?.[inspectItem] ?? 0) : 0;
  const inspectedPrice = inspected?.buyPrice ?? 0;
  // Same rule as the list: owning one is no reason not to buy another, but
  // having nowhere to put it is.
  const inspectedNoRoom =
    !!inspectItem && !hasRoomFor(inventory, equipped, inspectItem);

  return (
    <div className="flex h-full flex-col">
      <div className="z-50 mb-4 flex items-center justify-between">
        <h1 className="text-ui-lg font-bold text-yellow">Store</h1>
        <Tooltip label={`${formatAmount(currency)} herzie coins`}>
          <div className="text-ui text-yellow">
            <Coin amount={currency} animate />
          </div>
        </Tooltip>
      </div>

      <div className="mb-2 flex gap-1 border-b border-border">
        <TabButton
          active={tab === "premium"}
          onClick={() => setTab("premium")}
          colour="yellow"
        >
          Premium
        </TabButton>
        <TabButton
          active={tab === "coins"}
          onClick={() => setTab("coins")}
          colour="yellow"
        >
          <span className="italic">H</span> coins
        </TabButton>
      </div>

      <p className="mb-2 text-[11px] text-text-dim leading-snug">
        {/* Deliberately doesn't claim these are unobtainable elsewhere: a
            premium listing is just a Stripe product, so nothing stops a
            droppable card being sold here too — and every item is tradable,
            so even a shop-only one can reach a player who never paid. */}
        {tab === "premium"
          ? "Herzies is a one-person passion project. Buying here supports its development."
          : "Spend coins you've earned on cards for your herzie. Purchases land straight in your inventory."}
      </p>
      <List className="min-h-0 flex-1">
        {tab === "premium" && premium === null ? (
          <div className="pt-5 text-center text-ui text-text-dim">
            Loading...
          </div>
        ) : shopItems.length === 0 ? (
          <div className="pt-5 text-center text-ui text-text-dim">
            {tab === "premium"
              ? "Nothing in the premium shop right now."
              : "No cards available right now."}
          </div>
        ) : (
          shopItems.map((item) => {
            const paid = premiumByItem.get(item.id);
            const owned = inventory?.[item.id] ?? 0;
            const price = item.buyPrice ?? 0;
            const canAfford = paid ? true : currency >= price;
            const insufficientFunds = !canAfford;
            // Duplicates are fine — items are tradable, so a spare is a
            // legitimate thing to buy. Having nowhere to put it is not:
            // the bank is a fixed 18 slots and anything past that doesn't
            // render, so it would be bought and invisible. The server
            // refuses this too; disabling here just explains why.
            const noRoom = !hasRoomFor(inventory, equipped, item.id);
            // Paid purchases leave for the browser and are credited by the
            // webhook, so they share the coin-pack pending state and its
            // refresh-on-return — not handleBuyItem, which spends coins.
            const pending = paid
              ? pendingProductId === item.id
              : pendingItemId === item.id;
            const buyButton = (
              <button
                type="button"
                className="btn"
                disabled={!canAfford || noRoom || pending}
                onClick={() =>
                  paid ? handleBuyCurrency(item.id) : handleBuyItem(item.id)
                }
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
                    {paid ? (
                      formatPrice(paid.amount, paid.currency)
                    ) : (
                      <Coin amount={price} />
                    )}
                    {owned > 0 && ` · ${owned} owned`}
                  </>
                }
                action={
                  noRoom ? (
                    <Tooltip label="Bank full — sell something first">
                      {buyButton}
                    </Tooltip>
                  ) : insufficientFunds ? (
                    <Tooltip label="Insufficient funds">{buyButton}</Tooltip>
                  ) : (
                    buyButton
                  )
                }
              />
            );
          })
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

      {inspectItem && inspected && (
        <ItemInspectOverlay
          itemId={inspectItem}
          onClose={() => setInspectItem(null)}
          equipped={equipped}
          meta={
            <>
              <Coin amount={inspectedPrice} />
              {inspectedOwned > 0 && ` · ${inspectedOwned} owned`}
            </>
          }
          footer={
            inspected.buyPrice != null &&
            (() => {
              const insufficientFunds = currency < inspectedPrice;
              const buyButton = (
                <button
                  type="button"
                  className="btn"
                  disabled={
                    insufficientFunds ||
                    inspectedNoRoom ||
                    pendingItemId === inspectItem
                  }
                  onClick={() => handleBuyItem(inspectItem)}
                >
                  {pendingItemId === inspectItem ? (
                    "Buying..."
                  ) : (
                    <>
                      Buy (<Coin amount={inspectedPrice} />)
                    </>
                  )}
                </button>
              );
              return inspectedNoRoom ? (
                <Tooltip label="Bank full — sell something first">
                  {buyButton}
                </Tooltip>
              ) : insufficientFunds ? (
                <Tooltip label="Insufficient funds">{buyButton}</Tooltip>
              ) : (
                buyButton
              );
            })()
          }
        />
      )}
    </div>
  );
}
