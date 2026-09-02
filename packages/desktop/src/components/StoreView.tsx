import type { Inventory, StoreProduct } from "@herzies/shared";
import { getItem, ITEMS } from "@herzies/shared";
import { useEffect, useRef, useState } from "react";
import { cn, formatAmount } from "../lib/utils";
import { herzies, useWindowFocused } from "../tauri-bridge";
import { Coin } from "./Coin";
import ItemInspectOverlay from "./ItemInspectOverlay";
import { Tooltip } from "./Tooltip";

type StoreTab = "items" | "currency";

const BUYABLE_ITEMS = ITEMS.filter((item) => item.buyPrice != null);

/** Flip this back on once currency purchases are ready to ship. */
const CURRENCY_PURCHASES_ENABLED = false;

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "cursor-pointer border-none bg-transparent px-1.5 pb-1.5 pt-0.5 text-ui",
        active ? "font-bold text-yellow" : "text-text-dim hover:text-text",
      )}
    >
      {children}
    </button>
  );
}

export function StoreView({
  inventory: cachedInventory,
  currency: cachedCurrency,
  active = true,
  onLog,
}: {
  inventory: Inventory | null;
  currency: number;
  /** False while another tab is shown. */
  active?: boolean;
  onLog?: (msg: string) => void;
}) {
  const [tab, setTab] = useState<StoreTab>("items");
  const [inventory, setInventory] = useState(cachedInventory);
  const [currency, setCurrency] = useState(cachedCurrency);
  const [products, setProducts] = useState<StoreProduct[] | null>(null);
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
    herzies
      .fetchStoreProducts()
      .then(setProducts)
      .catch(() => setProducts([]));
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
      onLog?.(`Bought ${getItem(itemId)?.name ?? itemId}`);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setPendingItemId(null);
    }
  };

  const loading = products === null;
  const currencyProducts = products ?? [];

  const inspected = inspectItem ? getItem(inspectItem) : null;
  const inspectedOwned = inspectItem ? (inventory?.[inspectItem] ?? 0) : 0;
  const inspectedAlreadyOwned =
    !!inspected && !inspected.stackable && inspectedOwned > 0;
  const inspectedPrice = inspected?.buyPrice ?? 0;

  return (
    <div className="flex h-full flex-col">
      <div className="z-50 mb-4 flex items-center justify-between">
        <h1 className="text-ui-lg font-bold text-yellow">Store</h1>
        <Tooltip label={`${formatAmount(currency)} herzie coins`}>
          <div className="text-ui text-yellow">
            <Coin amount={currency} />
          </div>
        </Tooltip>
      </div>

      <div className="mb-2 flex gap-1 border-b border-border">
        <TabButton active={tab === "items"} onClick={() => setTab("items")}>
          Cards
        </TabButton>
        <TabButton
          active={tab === "currency"}
          onClick={() => setTab("currency")}
        >
          <span className="italic">H</span> coins
        </TabButton>
      </div>

      {tab === "items" ? (
        <>
          <p className="mb-2 text-[11px] text-text-dim leading-snug">
            Spend coins on cards for your herzie. Purchases land straight in
            your inventory.
          </p>
          <div className="min-h-0 flex-1 overflow-auto">
            {BUYABLE_ITEMS.length === 0 ? (
              <div className="pt-5 text-center text-ui text-text-dim">
                No cards available right now.
              </div>
            ) : (
              BUYABLE_ITEMS.map((item) => {
                const owned = inventory?.[item.id] ?? 0;
                const alreadyOwned = !item.stackable && owned > 0;
                const price = item.buyPrice ?? 0;
                const canAfford = currency >= price;
                return (
                  <div
                    key={item.id}
                    className="flex items-center justify-between gap-2 border-b border-[#222] py-2"
                  >
                    <button
                      type="button"
                      onClick={() => setInspectItem(item.id)}
                      className="min-w-0 flex-1 cursor-pointer text-left"
                      title="Inspect card"
                    >
                      <div className="truncate text-ui hover:underline">
                        {item.name}
                      </div>
                      <div className="text-[10px] text-text-dim">
                        {alreadyOwned ? "Owned" : <Coin amount={price} />}
                      </div>
                    </button>
                    <button
                      type="button"
                      className={cn(
                        "btn shrink-0",
                        alreadyOwned && "cursor-default",
                      )}
                      disabled={
                        alreadyOwned || !canAfford || pendingItemId === item.id
                      }
                      onClick={() => handleBuyItem(item.id)}
                    >
                      {pendingItemId === item.id
                        ? "Buying..."
                        : alreadyOwned
                          ? "Owned"
                          : "Buy"}
                    </button>
                  </div>
                );
              })
            )}
          </div>
        </>
      ) : (
        <>
          <p className="mb-2 text-[11px] text-text-dim leading-snug">
            Herzies is a one-person passion project. If you'd like to support
            its development, you can grab coins here to purchase limited cards.
          </p>
          {!CURRENCY_PURCHASES_ENABLED && (
            <p className="mb-2 text-[11px] text-yellow leading-snug">
              Coming soon...
            </p>
          )}
          <div className="min-h-0 flex-1 overflow-auto">
            {loading ? (
              <div className="pt-5 text-center text-ui text-text-dim">
                Loading...
              </div>
            ) : currencyProducts.length === 0 ? (
              <div className="pt-5 text-center text-ui text-text-dim">
                No products available right now.
              </div>
            ) : (
              currencyProducts.map((p) => (
                <div
                  key={p.id}
                  className="flex items-center justify-between gap-2 border-b border-[#222] py-2"
                >
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-ui">{p.name}</div>
                    <div className="text-[10px] text-text-dim">
                      {formatAmount(p.currencyAmount)} coins · $
                      {(p.priceUsdCents / 100).toFixed(2)}
                    </div>
                  </div>
                  <button
                    type="button"
                    className={cn(
                      "btn shrink-0",
                      !CURRENCY_PURCHASES_ENABLED && "cursor-not-allowed",
                    )}
                    disabled={
                      !CURRENCY_PURCHASES_ENABLED || pendingProductId === p.id
                    }
                    onClick={() => handleBuyCurrency(p.id)}
                  >
                    {!CURRENCY_PURCHASES_ENABLED
                      ? "Coming soon"
                      : pendingProductId === p.id
                        ? "Waiting..."
                        : "Buy"}
                  </button>
                </div>
              ))
            )}
          </div>

          {pendingProductId && (
            <div className="border-t border-border pt-2 text-center text-[10px] text-text-dim">
              Complete your purchase in the browser — your balance updates
              automatically.
            </div>
          )}
        </>
      )}

      {error && (
        <div className="pt-1 text-center text-[10px] text-red">{error}</div>
      )}

      {inspectItem && inspected && (
        <ItemInspectOverlay
          itemId={inspectItem}
          onClose={() => setInspectItem(null)}
          meta={
            inspectedAlreadyOwned ? "Owned" : <Coin amount={inspectedPrice} />
          }
          footer={
            inspected.buyPrice != null && (
              <button
                type="button"
                className={cn("btn", inspectedAlreadyOwned && "cursor-default")}
                disabled={
                  inspectedAlreadyOwned ||
                  currency < inspectedPrice ||
                  pendingItemId === inspectItem
                }
                onClick={() => handleBuyItem(inspectItem)}
              >
                {pendingItemId === inspectItem ? (
                  "Buying..."
                ) : inspectedAlreadyOwned ? (
                  "Owned"
                ) : (
                  <>
                    Buy (<Coin amount={inspectedPrice} />)
                  </>
                )}
              </button>
            )
          }
        />
      )}
    </div>
  );
}
