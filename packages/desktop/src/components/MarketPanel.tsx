import {
  DEFAULT_Y_ANGLE,
  type Equipped,
  getItem,
  type ItemUnit,
  MARKET_EQUIPPED,
  MARKET_LISTING_HOURS,
  MARKET_MAX_LISTINGS,
  MARKET_MAX_PRICE,
  MARKET_NAME,
  MARKET_SEED,
  MARKET_STAGE,
  type MarketListing,
  type MarketStall,
  marketFee,
  marketMinPrice,
  marketPayout,
  SpeechBubble,
  useChatter,
} from "@herzies/shared";
import { HerzieView } from "@herzies/shared/gl";
import { useEffect, useState } from "react";
import {
  collectLabel,
  type ListableCopies,
  listableCopies,
} from "../lib/market";
import { notify } from "../lib/notices";
import { useHerzieStage } from "../lib/overlayStage";
import { herzies } from "../tauri-bridge";
import { Coin } from "./Coin";
import ItemInspectOverlay, { inspectOrigin } from "./ItemInspectOverlay";
import { ItemRow } from "./ItemRow";
import { List } from "./List";
import { TabButton } from "./TabButton";
import { Tooltip } from "./Tooltip";
import { formatIn } from "./TownScene";

/** Plutus's patter: he keeps the board, takes his cut, and asks nothing. */
export const MARKET_LINES = [
  "Leave it with me. Someone always wants it.",
  "Five in every hundred is mine. The rest waits for you.",
  "I don't ask where it came from. I ask what you want for it.",
  "Two days on the board. Then it comes home to you.",
  "Everything here belonged to someone once.",
  "Price it fair and it won't be here when you're back.",
  "The game pays pennies. Players pay what it's worth.",
  "Go on, go listen to something. I'll mind the stall.",
];

/** One page of the board, as /market/browse returns it. */
const PAGE_SIZE = 50;

type Tab = "browse" | "sell" | "stall";

/** "+2" after a name, for an upgraded copy. */
function Level({ level }: { level: number }) {
  return level > 0 ? <span className="text-cyan"> +{level}</span> : null;
}

/** A listing's line under its name on the Browse tab. */
function listingSubtitle(l: MarketListing) {
  return (
    <>
      <Coin amount={l.price} />
      <Level level={l.upgradeLevel} /> · {l.sellerName ?? "someone"}
    </>
  );
}

/** Where a listing of yours stands, on the My stall tab. */
function stallSubtitle(l: MarketListing) {
  switch (l.status) {
    case "active":
      return (
        <>
          <Coin amount={l.price} />
          <Level level={l.upgradeLevel} /> · {formatIn(l.expiresAt)} left
        </>
      );
    case "sold":
      return (
        <>
          Sold · you get <Coin amount={l.price - l.fee} />
        </>
      );
    case "cancelled":
      return "Taken down · waiting for you";
    case "expired":
      return "Didn't sell · waiting for you";
  }
}

/**
 * Plutus's market board, always in Town: players leave a copy with him at a
 * fixed price, and anyone can buy it while they're away. Browse what's up,
 * Sell (list a copy from the bank), and My stall (your listings, and coins
 * and unsold copies to collect). `stall` is the player's side of the board
 * (null while it loads), fetched by EventsView, which also lights his "!"
 * from it. The server re-checks everything, so the disabled states here are
 * only a courtesy.
 */
export function MarketPanel({
  stall,
  currency,
  equipped,
  units,
  onChanged,
  onLog,
  paused,
}: {
  stall: MarketStall | null;
  currency: number;
  /** Your deck, for the inspect card's set progress. */
  equipped?: Equipped | null;
  /** Every owned copy: the unworn ones are what can be listed. */
  units: readonly ItemUnit[];
  /** Fetch the stall again: something was listed, taken down or collected. */
  onChanged: () => void;
  onLog?: (msg: string) => void;
  /** Tab hidden or window unfocused — stop the 3D frame timer and chatter. */
  paused: boolean;
}) {
  // Something waiting opens on it: that's what his "!" was for.
  const waiting = !!stall && (stall.coinsWaiting > 0 || stall.itemsWaiting > 0);
  const [tab, setTab] = useState<Tab>(waiting ? "stall" : "browse");
  const [error, setError] = useState<string | null>(null);
  /** The button busy with a request (a listing id, "list", "collect" or
   * "more"). */
  const [pending, setPending] = useState<string | null>(null);

  // Browse: one item's listings, or everyone's.
  const [filter, setFilter] = useState<string | null>(null);
  const [listings, setListings] = useState<MarketListing[] | null>(null);
  const [more, setMore] = useState(false);
  const [browseKey, setBrowseKey] = useState(0);
  const [inspecting, setInspecting] = useState<MarketListing | null>(null);

  // Sell: the copies picked, and the price asked for one of them.
  const [selling, setSelling] = useState<ListableCopies | null>(null);
  const [priceText, setPriceText] = useState("");
  /** The cheapest of the picked item already on the board, as a guide. */
  const [cheapest, setCheapest] = useState<number | null>(null);

  /** Copies left waiting at the last collect, for want of bank room. */
  const [bankFull, setBankFull] = useState(false);

  const { line, typed, advance } = useChatter(MARKET_LINES, !paused);
  const { stage: onStage } = useHerzieStage();

  // biome-ignore lint/correctness/useExhaustiveDependencies: browseKey re-runs the fetch
  useEffect(() => {
    if (tab !== "browse") return;
    let cancelled = false;
    setListings(null);
    herzies
      .marketBrowse(filter, 0)
      .then(({ listings }) => {
        if (cancelled) return;
        setListings(listings);
        setMore(listings.length === PAGE_SIZE);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setListings([]);
        setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [tab, filter, browseKey]);

  const loadMore = async () => {
    if (!listings || pending !== null) return;
    setPending("more");
    try {
      const next = await herzies.marketBrowse(filter, listings.length);
      setListings([...listings, ...next.listings]);
      setMore(next.listings.length === PAGE_SIZE);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setPending(null);
    }
  };

  // The board's going rate for what's being sold.
  useEffect(() => {
    if (!selling) return;
    let cancelled = false;
    setCheapest(null);
    herzies
      .marketBrowse(selling.itemId, 0)
      .then(({ listings }) => {
        if (!cancelled) setCheapest(listings[0]?.price ?? null);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [selling]);

  const run = async (key: string, action: () => Promise<void>) => {
    setError(null);
    setPending(key);
    try {
      await action();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setPending(null);
    }
  };

  const name = (itemId: string) => getItem(itemId)?.name ?? itemId;
  const mine = new Set(stall?.active.map((l) => l.id) ?? []);
  const full = (stall?.active.length ?? 0) >= MARKET_MAX_LISTINGS;

  // --- Browse -------------------------------------------------------------

  /** Why a listing can't be bought right now, or null if it can. */
  const blocked = (l: MarketListing) =>
    mine.has(l.id)
      ? "That's yours"
      : currency < l.price
        ? "Insufficient funds"
        : null;

  const buy = (l: MarketListing) =>
    run(l.id, async () => {
      await herzies.marketBuy(l.id).catch((e: unknown) => {
        // Most likely someone got there first: show the board as it is now.
        setBrowseKey((k) => k + 1);
        throw e;
      });
      setListings((ls) => ls?.filter((x) => x.id !== l.id) ?? null);
      setInspecting(null);
      onLog?.(
        `Bought "${name(l.itemId)}" from ${l.sellerName ?? "someone"} at ${MARKET_NAME}'s board`,
      );
    });

  const buyButton = (l: MarketListing) => {
    const reason = blocked(l);
    const button = (
      <button
        type="button"
        className="btn"
        disabled={!!reason || pending !== null}
        onClick={() => buy(l)}
      >
        {pending === l.id ? "Buying..." : "Buy"}
      </button>
    );
    return reason ? <Tooltip label={reason}>{button}</Tooltip> : button;
  };

  const browse = (
    <>
      {filter && (
        <div className="flex items-center justify-between gap-2 pb-1 text-[10px] text-text-dim">
          <span className="truncate">Only "{name(filter)}"</span>
          <button
            type="button"
            className="cursor-pointer border-none bg-transparent p-0 text-[10px] text-cyan"
            onClick={() => setFilter(null)}
          >
            Show everything
          </button>
        </div>
      )}
      <List className="min-h-0 flex-1">
        {!listings ? (
          <div className="text-ui text-text-dim">...</div>
        ) : listings.length === 0 ? (
          <div className="text-ui text-text-dim">
            {filter
              ? "Nobody's selling one right now."
              : "The board's empty. Be the first to leave something."}
          </div>
        ) : (
          <>
            {listings.map((l) => (
              <ItemRow
                key={l.id}
                itemId={l.itemId}
                onInspect={() => setInspecting(l)}
                inspectTitle="Inspect card"
                subtitle={listingSubtitle(l)}
                action={buyButton(l)}
              />
            ))}
            {more && (
              <button
                type="button"
                className="btn mt-2 w-full"
                onClick={loadMore}
              >
                Load more
              </button>
            )}
          </>
        )}
      </List>
    </>
  );

  // --- Sell ---------------------------------------------------------------

  const copies = listableCopies(units);
  const sellDef = selling ? getItem(selling.itemId) : undefined;
  const minPrice = marketMinPrice(sellDef?.sellPrice);
  const price = Number(priceText);
  const priceOk =
    Number.isInteger(price) && price >= minPrice && price <= MARKET_MAX_PRICE;

  const pick = (row: ListableCopies) => {
    setError(null);
    setSelling(row);
    setPriceText(String(marketMinPrice(getItem(row.itemId)?.sellPrice)));
  };

  const list = () =>
    run("list", async () => {
      if (!selling) return;
      await herzies.marketList(selling.unitIds[0], price);
      onLog?.(
        `Left "${name(selling.itemId)}" with ${MARKET_NAME} for ${price}`,
      );
      setSelling(null);
      onChanged();
    });

  const listReason = full
    ? "Your stall is full"
    : !priceOk
      ? price > MARKET_MAX_PRICE
        ? "That price is too high"
        : `At least ${minPrice}`
      : null;
  const listButton = (() => {
    const button = (
      <button
        type="button"
        className="btn"
        disabled={!!listReason || pending !== null}
        onClick={list}
      >
        {pending === "list" ? "Listing..." : "List"}
      </button>
    );
    return listReason ? <Tooltip label={listReason}>{button}</Tooltip> : button;
  })();

  const sell = (
    <>
      <div className="pb-1 text-[10px] text-text-dim">
        {stall?.active.length ?? 0}/{MARKET_MAX_LISTINGS} listings · up for{" "}
        {MARKET_LISTING_HOURS}h
      </div>
      <List className="min-h-0 flex-1">
        {copies.length === 0 ? (
          <div className="text-ui text-text-dim">
            Nothing in your bank he can take. Worn and class gear stays with
            you.
          </div>
        ) : (
          copies.map((row) => (
            <ItemRow
              key={`${row.itemId}:${row.upgradeLevel}`}
              itemId={row.itemId}
              onInspect={() => pick(row)}
              inspectTitle="Price it"
              subtitle={[
                row.upgradeLevel > 0 ? `+${row.upgradeLevel}` : null,
                row.unitIds.length > 1 ? `${row.unitIds.length} owned` : null,
                getItem(row.itemId)?.sellPrice
                  ? `the game pays ${getItem(row.itemId)?.sellPrice}`
                  : null,
              ]
                .filter(Boolean)
                .join(" · ")}
              action={
                <button
                  type="button"
                  className="btn"
                  disabled={full}
                  onClick={() => pick(row)}
                >
                  Sell
                </button>
              }
            />
          ))
        )}
      </List>
    </>
  );

  // --- My stall -----------------------------------------------------------

  const collect = () =>
    run("collect", async () => {
      const got = await herzies.marketCollect();
      setBankFull(got.itemsLeft > 0);
      const what = collectLabel(got.coins, got.items)?.replace("Collect ", "");
      if (what) {
        notify(`Collected ${what}`, { kind: "success" });
        onLog?.(`Collected ${what} from ${MARKET_NAME}`);
      }
      onChanged();
    });

  const cancel = (l: MarketListing) =>
    run(l.id, async () => {
      await herzies.marketCancel(l.id);
      onLog?.(`Took "${name(l.itemId)}" off ${MARKET_NAME}'s board`);
      onChanged();
    });

  const label = stall
    ? collectLabel(stall.coinsWaiting, stall.itemsWaiting)
    : null;
  const mineAll = stall ? [...stall.uncollected, ...stall.active] : [];

  const myStall = (
    <>
      {label && (
        <button
          type="button"
          className="btn mb-1 w-full"
          disabled={pending !== null}
          onClick={collect}
        >
          {pending === "collect" ? "Collecting..." : label}
        </button>
      )}
      {bankFull && !!stall?.itemsWaiting && (
        <div className="pb-1 text-center text-[10px] text-yellow">
          Your bank is full: {stall.itemsWaiting}{" "}
          {stall.itemsWaiting === 1 ? "copy is" : "copies are"} still waiting.
        </div>
      )}
      <List className="min-h-0 flex-1">
        {!stall ? (
          <div className="text-ui text-text-dim">...</div>
        ) : mineAll.length === 0 ? (
          <div className="text-ui text-text-dim">
            Nothing on the board. Leave something with him on the Sell tab.
          </div>
        ) : (
          mineAll.map((l) => (
            <ItemRow
              key={l.id}
              itemId={l.itemId}
              onInspect={() => setInspecting(l)}
              inspectTitle="Inspect card"
              subtitle={stallSubtitle(l)}
              action={
                l.status === "active" ? (
                  <button
                    type="button"
                    className="btn"
                    disabled={pending !== null}
                    onClick={() => cancel(l)}
                  >
                    {pending === l.id ? "..." : "Cancel"}
                  </button>
                ) : undefined
              }
            />
          ))
        )}
      </List>
    </>
  );

  const switchTab = (t: Tab) => {
    setError(null);
    setTab(t);
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      <div className="text-center text-[16px] font-bold text-[#b49cff]">
        {MARKET_NAME}
      </div>

      {/* Staged as the merchants are: square on, his line at his feet. A
          little shorter than theirs, for the tabs below. */}
      <div className="relative flex h-[160px] shrink-0 flex-col">
        <div className="flex min-h-0 flex-1 items-center justify-center overflow-hidden">
          <HerzieView
            onStage={onStage}
            userId={MARKET_SEED}
            stage={MARKET_STAGE}
            zoom={0.8}
            size={5}
            cols={64}
            equipped={MARKET_EQUIPPED}
            animate={false}
            defaultAngle={-DEFAULT_Y_ANGLE}
            draggable={false}
            paused={paused}
            ariaLabel={MARKET_NAME}
          />
        </div>
        <button
          type="button"
          aria-label={`Talk to ${MARKET_NAME}`}
          onClick={advance}
          className="absolute inset-0 z-[2] cursor-pointer border-none bg-transparent p-0"
        />
        <SpeechBubble line={line} typed={typed} />
      </div>

      <div className="flex justify-center gap-1 border-b border-white/15">
        <TabButton
          active={tab === "browse"}
          onClick={() => switchTab("browse")}
        >
          Browse
        </TabButton>
        <TabButton active={tab === "sell"} onClick={() => switchTab("sell")}>
          Sell
        </TabButton>
        <TabButton active={tab === "stall"} onClick={() => switchTab("stall")}>
          My stall{waiting ? " !" : ""}
        </TabButton>
      </div>

      <div className="flex min-h-0 flex-1 flex-col">
        {tab === "browse" ? browse : tab === "sell" ? sell : myStall}
      </div>

      {error && (
        <div className="pt-1 text-center text-[10px] text-red">{error}</div>
      )}

      {inspecting && (
        <ItemInspectOverlay
          itemId={inspecting.itemId}
          origin={inspectOrigin(inspecting.itemId)}
          onClose={() => setInspecting(null)}
          equipped={equipped}
          level={inspecting.upgradeLevel}
          meta={<Coin amount={inspecting.price} />}
          footer={
            tab === "browse" ? (
              <div className="flex flex-col items-center gap-1">
                <div className="flex items-center gap-2">
                  {buyButton(inspecting)}
                  {filter !== inspecting.itemId && (
                    <button
                      type="button"
                      className="btn"
                      onClick={() => {
                        setFilter(inspecting.itemId);
                        setInspecting(null);
                      }}
                    >
                      More like this
                    </button>
                  )}
                </div>
                {error && <div className="text-[10px] text-red">{error}</div>}
              </div>
            ) : undefined
          }
        />
      )}

      {selling && (
        <ItemInspectOverlay
          itemId={selling.itemId}
          origin={inspectOrigin(selling.itemId)}
          onClose={() => setSelling(null)}
          equipped={equipped}
          level={selling.upgradeLevel}
          meta={
            cheapest !== null ? (
              <>
                Cheapest on the board: <Coin amount={cheapest} />
              </>
            ) : undefined
          }
          footer={
            <div className="flex flex-col items-center gap-1">
              <div className="flex items-center gap-2">
                <input
                  type="number"
                  className="input w-[110px] text-center"
                  aria-label="Price"
                  min={minPrice}
                  max={MARKET_MAX_PRICE}
                  value={priceText}
                  onChange={(e) => setPriceText(e.target.value)}
                />
                {listButton}
              </div>
              <div className="text-[10px] text-text-dim">
                {priceOk ? (
                  <>
                    Fee <Coin amount={marketFee(price)} />, you'll get{" "}
                    <Coin amount={marketPayout(price)} />
                  </>
                ) : (
                  <>
                    At least <Coin amount={minPrice} />
                  </>
                )}
              </div>
              {error && <div className="text-[10px] text-red">{error}</div>}
            </div>
          }
        />
      )}
    </div>
  );
}
