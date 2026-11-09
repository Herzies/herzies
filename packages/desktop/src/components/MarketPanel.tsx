import {
  DEFAULT_Y_ANGLE,
  type Equipped,
  getItem,
  type ItemUnit,
  MARKET_EQUIPPED,
  MARKET_LISTING_HOURS,
  MARKET_MAX_LISTINGS,
  MARKET_MAX_STACK,
  MARKET_NAME,
  MARKET_SEED,
  MARKET_STAGE,
  type MarketListing,
  type MarketStall,
  marketCost,
  marketFee,
  marketMaxEach,
  marketMinPrice,
  marketPayout,
  marketPriceEach,
  SpeechBubble,
  useChatter,
} from "@herzies/shared";
import { HerzieView } from "@herzies/shared/gl";
import { useEffect, useState } from "react";
import {
  collectLabel,
  type ListableCopies,
  listableCopies,
  matchMarketItems,
} from "../lib/market";
import { notify } from "../lib/notices";
import { useHerzieStage } from "../lib/overlayStage";
import { herzies } from "../tauri-bridge";
import { Coin, CoinBalance } from "./Coin";
import ItemInspectOverlay, { inspectOrigin } from "./ItemInspectOverlay";
import { ItemRow } from "./ItemRow";
import { List } from "./List";
import { QuantityModal } from "./QuantityModal";
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
/** How long typing must pause before the board is searched. */
const SEARCH_DEBOUNCE_MS = 250;

type Tab = "browse" | "sell" | "stall";

/** "+2" after a name, for an upgraded copy. */
function Level({ level }: { level: number }) {
  return level > 0 ? <span className="text-cyan"> +{level}</span> : null;
}

/** A listing's line under its name on the Browse tab. */
/** "x3 · " for a stack, nothing for a single copy. */
function stackOf(l: MarketListing) {
  return l.quantity > 1 ? `x${l.quantity} · ` : "";
}

/** A listing's price: "12 each" for a stack that can be bought a few at a
 * time, the lot's price otherwise. */
function ListingPrice({ l }: { l: MarketListing }) {
  const each = l.quantity > 1 ? marketPriceEach(l) : null;
  return each !== null ? (
    <>
      <Coin amount={each} /> each
    </>
  ) : (
    <>
      <Coin amount={l.price} />
      {l.quantity > 1 && " for all"}
    </>
  );
}

function listingSubtitle(l: MarketListing, owned: number) {
  return (
    <>
      {stackOf(l)}
      <ListingPrice l={l} />
      <Level level={l.upgradeLevel} /> · {l.sellerName ?? "someone"}
      {owned > 0 && ` · ${owned} owned`}
    </>
  );
}

/** Where a listing of yours stands, on the My stall tab. */
function stallSubtitle(l: MarketListing) {
  switch (l.status) {
    case "active":
      return (
        <>
          {stackOf(l)}
          <ListingPrice l={l} />
          <Level level={l.upgradeLevel} /> · {formatIn(l.expiresAt)} left
        </>
      );
    case "sold":
      return (
        <>
          {stackOf(l)}Sold · you get <Coin amount={l.price - l.fee} />
        </>
      );
    case "cancelled":
      return `${stackOf(l)}Taken down · waiting for you`;
    case "expired":
      return `${stackOf(l)}Didn't sell · waiting for you`;
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
  /** How many copies of each item you have, worn or not: each Browse row's
   * "N owned" (as at George's). */
  const owned = new Map<string, number>();
  for (const u of units) owned.set(u.itemId, (owned.get(u.itemId) ?? 0) + 1);
  /** The button busy with a request (a listing id, "list", "collect" or
   * "more"). */
  const [pending, setPending] = useState<string | null>(null);

  // Browse: one item's listings ("More like this"), what a search matched,
  // or everyone's.
  const [filter, setFilter] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  /** The query once typing pauses: what the board is searched for. */
  const [search, setSearch] = useState("");
  const [listings, setListings] = useState<MarketListing[] | null>(null);
  const [more, setMore] = useState(false);
  const [browseKey, setBrowseKey] = useState(0);
  const [inspecting, setInspecting] = useState<MarketListing | null>(null);
  /** A stack whose "how many?" is open, before it's bought. */
  const [buying, setBuying] = useState<MarketListing | null>(null);

  // Sell: the copies picked, how many of them go up, and the price asked for
  // each (the lot's price is that times the count, so it splits evenly and
  // buyers can take a few).
  const [selling, setSelling] = useState<ListableCopies | null>(null);
  const [sellCount, setSellCount] = useState(1);
  /** A stack whose "how many?" is open, before it's priced. */
  const [counting, setCounting] = useState<ListableCopies | null>(null);
  const [priceText, setPriceText] = useState("");
  /** The cheapest copy of the picked item already on the board (a stack's
   * price split across its copies), as a guide. */
  const [cheapest, setCheapest] = useState<number | null>(null);

  /** Copies left waiting at the last collect, for want of bank room. */
  const [bankFull, setBankFull] = useState(false);

  const { line, typed, advance } = useChatter(MARKET_LINES, !paused);
  const { stage: onStage } = useHerzieStage();

  useEffect(() => {
    const t = setTimeout(() => setSearch(query.trim()), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [query]);

  /** The items the board is narrowed to, or null for everything. Joined, so
   * the fetch below re-runs only when they change. */
  const narrowedTo =
    filter ?? (search ? matchMarketItems(search).join(",") : null);
  const itemIds =
    narrowedTo === null ? null : narrowedTo.split(",").filter(Boolean);

  // biome-ignore lint/correctness/useExhaustiveDependencies: browseKey re-runs the fetch; narrowedTo stands for itemIds
  useEffect(() => {
    if (tab !== "browse") return;
    // A search that names no item has nothing to show: no need to ask.
    if (itemIds?.length === 0) {
      setListings([]);
      setMore(false);
      return;
    }
    let cancelled = false;
    setListings(null);
    herzies
      .marketBrowse(itemIds, 0)
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
  }, [tab, narrowedTo, browseKey]);

  const loadMore = async () => {
    if (!listings || pending !== null) return;
    setPending("more");
    try {
      const next = await herzies.marketBrowse(itemIds, listings.length);
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
      .marketBrowse([selling.itemId], 0)
      .then(({ listings }) => {
        if (cancelled) return;
        const each = listings.map((l) => Math.ceil(l.price / l.quantity));
        setCheapest(each.length > 0 ? Math.min(...each) : null);
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

  /** A stack that can be bought a few copies at a time. */
  const splits = (l: MarketListing) =>
    l.quantity > 1 && marketPriceEach(l) !== null;

  /** Why a listing can't be bought right now, or null if it can. The least
   * that can be bought is one copy of a stack that splits. */
  const blocked = (l: MarketListing) =>
    mine.has(l.id)
      ? "That's yours"
      : currency < marketCost(l, splits(l) ? 1 : l.quantity)
        ? "Insufficient funds"
        : null;

  const buy = (l: MarketListing, count = l.quantity) =>
    run(l.id, async () => {
      const got = await herzies
        .marketBuy(l.id, count < l.quantity ? count : undefined)
        .catch((e: unknown) => {
          // Most likely someone got there first: show the board as it is now.
          setBuying(null);
          setBrowseKey((k) => k + 1);
          throw e;
        });
      // A stack with copies left stays up, smaller.
      const left =
        got.listing.status === "active"
          ? { ...l, quantity: got.listing.quantity, price: got.listing.price }
          : null;
      setListings(
        (ls) =>
          ls?.flatMap((x) => (x.id !== l.id ? [x] : left ? [left] : [])) ??
          null,
      );
      setInspecting((i) => (i?.id === l.id ? left : i));
      setBuying(null);
      const what =
        got.quantity > 1
          ? `${got.quantity} "${name(l.itemId)}"`
          : `"${name(l.itemId)}"`;
      notify(`Bought ${what}`, { kind: "success" });
      onLog?.(
        `Bought ${what} from ${l.sellerName ?? "someone"} at ${MARKET_NAME}'s board for ${got.spent}`,
      );
    });

  const buyButton = (l: MarketListing) => {
    const reason = blocked(l);
    const button = (
      <button
        type="button"
        className="btn"
        disabled={!!reason || pending !== null}
        onClick={() => (splits(l) ? setBuying(l) : buy(l))}
      >
        {pending === l.id ? "Buying..." : "Buy"}
      </button>
    );
    return reason ? <Tooltip label={reason}>{button}</Tooltip> : button;
  };

  const browse = (
    <>
      <input
        className="input mb-1"
        placeholder="Search by name, rarity or slot"
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setFilter(null);
        }}
      />
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
              : search
                ? "Nothing on the board matches that."
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
                subtitle={listingSubtitle(l, owned.get(l.itemId) ?? 0)}
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
  /** The asking price is per copy; the listing's is that for them all. */
  const minEach = marketMinPrice(sellDef?.sellPrice);
  const maxEach = marketMaxEach(sellCount);
  const each = Number(priceText);
  const price = each * sellCount;
  const priceOk = Number.isInteger(each) && each >= minEach && each <= maxEach;

  const priceStack = (row: ListableCopies, count: number) => {
    setError(null);
    setCounting(null);
    setSellCount(count);
    setSelling(row);
    setPriceText(String(marketMinPrice(getItem(row.itemId)?.sellPrice)));
  };
  /** Several copies of something stackable ask how many go up first. */
  const pick = (row: ListableCopies) => {
    if (getItem(row.itemId)?.stackable && row.unitIds.length > 1) {
      setCounting(row);
    } else priceStack(row, 1);
  };

  const list = () =>
    run("list", async () => {
      if (!selling) return;
      await herzies.marketList(selling.unitIds[0], price, sellCount);
      const what =
        sellCount > 1
          ? `${sellCount} "${name(selling.itemId)}"`
          : `"${name(selling.itemId)}"`;
      onLog?.(`Left ${what} with ${MARKET_NAME} for ${price}`);
      setSelling(null);
      onChanged();
    });

  const listReason = full
    ? "Your stall is full"
    : !priceOk
      ? each > maxEach
        ? "That price is too high"
        : `At least ${minEach}${sellCount > 1 ? " each" : ""}`
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

      <CoinBalance amount={currency} />

      {inspecting && (
        <ItemInspectOverlay
          itemId={inspecting.itemId}
          origin={inspectOrigin(inspecting.itemId)}
          onClose={() => setInspecting(null)}
          equipped={equipped}
          level={inspecting.upgradeLevel}
          meta={
            <>
              {stackOf(inspecting)}
              <ListingPrice l={inspecting} />
            </>
          }
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
                        setQuery("");
                        setSearch("");
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
            sellCount > 1 || cheapest !== null ? (
              <>
                {sellCount > 1 && `Selling ${sellCount}, priced each`}
                {sellCount > 1 && cheapest !== null && " · "}
                {cheapest !== null && (
                  <>
                    Cheapest on the board: <Coin amount={cheapest} />
                    {sellDef?.stackable && " each"}
                  </>
                )}
              </>
            ) : undefined
          }
          footer={
            <div className="flex flex-col items-center gap-1">
              <div className="flex items-center gap-2">
                <input
                  type="number"
                  className="input w-[110px] text-center"
                  aria-label={sellCount > 1 ? "Price each" : "Price"}
                  min={minEach}
                  max={maxEach}
                  value={priceText}
                  onChange={(e) => setPriceText(e.target.value)}
                />
                {listButton}
              </div>
              <div className="text-[10px] text-text-dim">
                {priceOk ? (
                  <>
                    {sellCount > 1 && (
                      <>
                        {sellCount} for <Coin amount={price} /> ·{" "}
                      </>
                    )}
                    Fee <Coin amount={marketFee(price)} />, you'll get{" "}
                    <Coin amount={marketPayout(price)} />
                  </>
                ) : (
                  <>
                    At least <Coin amount={minEach} />
                    {sellCount > 1 && " each"}
                  </>
                )}
              </div>
              {error && <div className="text-[10px] text-red">{error}</div>}
            </div>
          }
        />
      )}

      {buying && (
        <QuantityModal
          max={Math.min(
            buying.quantity,
            Math.floor(currency / (marketPriceEach(buying) ?? buying.price)),
          )}
          confirmLabel="Buy"
          busy={pending === buying.id}
          busyLabel="Buying..."
          total={(n) => <Coin amount={marketCost(buying, n)} />}
          onConfirm={(n) => buy(buying, n)}
          onCancel={() => setBuying(null)}
        />
      )}

      {counting && (
        <QuantityModal
          max={Math.min(counting.unitIds.length, MARKET_MAX_STACK)}
          initial={counting.unitIds.length}
          confirmLabel="Next"
          total={(n) => `${n} of ${counting.unitIds.length} owned`}
          onConfirm={(n) => priceStack(counting, n)}
          onCancel={() => setCounting(null)}
        />
      )}
    </div>
  );
}
