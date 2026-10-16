import type {
  Equipped,
  GameEvent,
  ItemUnit,
  MerchantStockView,
  MerchantView,
} from "@herzies/shared";
import {
  BOBOKU_EQUIPPED,
  BOBOKU_KEY,
  BOBOKU_NAME,
  BOBOKU_SEED,
  BOBOKU_STAGE,
  BOBOKU_STOCK,
  DEFAULT_Y_ANGLE,
  GEORGE_EQUIPPED,
  GEORGE_SEED,
  getItem,
  MERCHANT_NAME,
  NANDOR_EQUIPPED,
  NANDOR_SEED,
  SpeechBubble,
  TREAT_ITEM_ID,
  TREAT_TRADER_NAME,
  useChatter,
} from "@herzies/shared";
import { HerzieView } from "@herzies/shared/gl";
import { type ReactNode, useEffect, useState } from "react";
import { herzies } from "../tauri-bridge";
import { Coin } from "./Coin";
import { FloatingCoins } from "./FloatingCoins";
import ItemInspectOverlay, { inspectOrigin } from "./ItemInspectOverlay";
import { ItemRow } from "./ItemRow";
import { List } from "./List";
import type { TabColour } from "./TabButton";
import { Tooltip } from "./Tooltip";

/** Good ol' George's sales patter, cycled in a speech bubble like the boss. */
export const GEORGE_LINES = [
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

/** Nandor the Treatless's patter: a centuries-old warlord, deadly serious
 * about sweets. */
export const NANDOR_LINES = [
  "I am Nandor the Treatless. Bring me treats.",
  "In my village we paid in treats. Also in goats.",
  "Once I conquered a thousand villages. Now I want a lollipop.",
  "You may approach. Slowly. With the treats in front.",
  "Do not ask what happened to my old treats. It was a war.",
  "These wares are cursed. Only a little. Hardly at all.",
  "The fangs are real. The patience is not.",
  "Trick? No. I am too old for tricks. Treat.",
  "Every treat you give me makes me slightly less relentless.",
  "Guillermo usually carries the treats. Guillermo is busy.",
];

/** Boboku's patter: a mellow old session player who's seen every gig. */
export const BOBOKU_LINES = [
  "Every legend started on a beat-up instrument. Like these.",
  "Broke yours? Happens to the best of us.",
  "Lutes, discs, sticks, cymbals. The basics never go out of style.",
  "Tune it, play it, roll some dice on it. That's the life.",
  "I've been here since before the plaza had benches.",
  "Pick your weapon. I mean instrument. Same thing.",
  "No rush, friend. I'm not going anywhere.",
  "Scratches add character. Ask any Record Slinger.",
];

/** Treats as a price or balance, the treat counterpart of <Coin>. */
function Treats({ amount }: { amount: number }) {
  return (
    <>
      {amount} {amount === 1 ? "treat" : "treats"}
    </>
  );
}

/** Who is behind the stall and what they take, per event type. */
interface MerchantPersona {
  name: string;
  seed: string;
  /** How grown up they're drawn (2 unless said). */
  stage?: number;
  /** Camera zoom on the stage (below 1: further back), so a taller one
   * isn't cut off at the head. */
  zoom?: number;
  equipped: Equipped;
  lines: readonly string[];
  /** Short name for the log line and button labels. */
  shortName: string;
  /** Heading and row-hover colour. */
  colour: TabColour;
  headingClass: string;
  /** What floats around them on the stage, if anything. */
  Props?: (p: { paused: boolean }) => ReactNode;
  price: (amount: number) => ReactNode;
  /** The tooltip on a line the player can't afford. */
  broke: string;
  soldOut: string;
}

const GEORGE: MerchantPersona = {
  name: MERCHANT_NAME,
  seed: GEORGE_SEED,
  equipped: GEORGE_EQUIPPED,
  lines: GEORGE_LINES,
  shortName: "George",
  colour: "yellow",
  headingClass: "text-yellow",
  Props: FloatingCoins,
  price: (amount) => <Coin amount={amount} />,
  broke: "Insufficient funds",
  soldOut: "George has nothing left to sell.",
};

const NANDOR: MerchantPersona = {
  name: TREAT_TRADER_NAME,
  seed: NANDOR_SEED,
  equipped: NANDOR_EQUIPPED,
  lines: NANDOR_LINES,
  shortName: "Nandor",
  colour: "red",
  headingClass: "text-red",
  price: (amount) => <Treats amount={amount} />,
  broke: "Not enough treats",
  soldOut: "Nandor has nothing left. He is furious about it.",
};

const BOBOKU: MerchantPersona = {
  name: BOBOKU_NAME,
  seed: BOBOKU_SEED,
  stage: BOBOKU_STAGE,
  zoom: 0.8,
  equipped: BOBOKU_EQUIPPED,
  lines: BOBOKU_LINES,
  shortName: BOBOKU_NAME,
  colour: "cyan",
  headingClass: "text-[#ffb45c]",
  price: (amount) => <Coin amount={amount} />,
  broke: "Insufficient funds",
  soldOut: "Boboku's shelves are bare.",
};

/** Boboku's price list as stall lines: no caps, no limits. */
const BOBOKU_STALL: MerchantStockView[] = BOBOKU_STOCK.map((l) => ({
  ...l,
  perPlayerLimit: null,
  totalStock: null,
  remaining: null,
  yourBought: 0,
}));

/** Why a line can't be bought right now, or null if it can. */
function blockedReason(
  line: MerchantStockView,
  balance: number,
  persona: MerchantPersona,
) {
  if (line.remaining === 0) return "Sold out";
  if (line.perPlayerLimit != null && line.yourBought >= line.perPlayerLimit) {
    return "You've bought your share";
  }
  if (balance < line.price) return persona.broke;
  return null;
}

/**
 * A merchant's stall: Good ol' George (`merchant`, coins) or Nandor the
 * Treatless (`treat_trader`, treats), whose prices and limits come from the
 * live event (projected by buildMerchantConfig) — or Boboku, always in Town,
 * selling from BOBOKU_STOCK with no event at all. The server re-checks
 * everything on buy, so the disabled states here are only a courtesy.
 */
export function MerchantPanel({
  event,
  currency,
  equipped,
  units,
  onBought,
  onLog,
  paused,
}: {
  /** The visit behind the stall, or Boboku's, which has none. */
  event: GameEvent | typeof BOBOKU_KEY;
  /** Tab hidden or window unfocused — stop the 3D frame timer and chatter. */
  paused: boolean;
  currency: number;
  equipped?: Equipped | null;
  /** Every owned copy (worn or not), for each line's "N owned". */
  units: readonly ItemUnit[];
  /** Refetch events so remaining stock and "bought" counts catch up. */
  onBought: () => void;
  onLog?: (msg: string) => void;
}) {
  const boboku = event === BOBOKU_KEY;
  const config = boboku ? null : event.config;
  const [pendingItemId, setPendingItemId] = useState<string | null>(null);
  const [inspectItemId, setInspectItemId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Optimistic "bought" bumps until the next poll brings real counts.
  const [boughtNow, setBoughtNow] = useState<Record<string, number>>({});
  // Fresh counts from the server already include those buys.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset on each new poll result
  useEffect(() => setBoughtNow({}), [config]);

  const owned = (itemId: string) =>
    units.filter((u) => u.itemId === itemId).length;

  const persona = boboku
    ? BOBOKU
    : event.type === "treat_trader"
      ? NANDOR
      : GEORGE;
  // Nandor is paid in unworn treats; George in coins.
  const balance =
    persona === NANDOR
      ? units.filter((u) => u.itemId === TREAT_ITEM_ID && !u.equippedSlot)
          .length
      : currency;

  const lines = boboku
    ? BOBOKU_STALL
    : ((config as unknown as MerchantView).stock ?? []);
  const stock = lines.map((line) => {
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
      if (boboku) await herzies.buyFromBoboku(itemId, 1);
      else await herzies.buyFromMerchant(event.id, itemId, 1);
      setBoughtNow((b) => ({ ...b, [itemId]: (b[itemId] ?? 0) + 1 }));
      onLog?.(
        `Bought "${getItem(itemId)?.name ?? itemId}" from ${persona.name}`,
      );
      onBought();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setPendingItemId(null);
    }
  };

  const inspected = stock.find((l) => l.itemId === inspectItemId);
  const { line, typed, advance } = useChatter(persona.lines, !paused);

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      {/* His name as the heading, as BossFightPanel does with the boss's. */}
      <div
        className={`text-center text-[16px] font-bold ${persona.headingClass}`}
      >
        {persona.name}
      </div>
      {persona === NANDOR && (
        <div className="-mt-2 text-center text-[10px] text-text-dim">
          You have <Treats amount={balance} />
        </div>
      )}

      {/* Same staging as BossFightPanel: George square-on, not spinning, with
          his patter in a bubble at his feet. A fixed height rather than
          flex-1, because here the stock list below is what needs the room. */}
      <div className="relative flex h-[190px] shrink-0 flex-col">
        <div className="flex min-h-0 flex-1 items-center justify-center overflow-hidden">
          <HerzieView
            userId={persona.seed}
            stage={persona.stage ?? 2}
            zoom={persona.zoom}
            size={5}
            cols={64}
            equipped={persona.equipped}
            animate={false}
            defaultAngle={-DEFAULT_Y_ANGLE}
            draggable={false}
            paused={paused}
            ariaLabel={persona.name}
          />
        </div>
        {persona.Props && <persona.Props paused={paused} />}
        {/* Clicking George hurries him along: the line he's on shows in full,
            or he moves on to the next. z-[2]: over the canvas, which sets its
            own z-index of 1; under the bubble (z-10, no pointer events). */}
        <button
          type="button"
          aria-label={`Talk to ${persona.shortName}`}
          onClick={advance}
          className="absolute inset-0 z-[2] cursor-pointer border-none bg-transparent p-0"
        />
        <SpeechBubble line={line} typed={typed} />
      </div>

      <List className="min-h-0 flex-1">
        {stock.length === 0 ? (
          <div className="text-ui text-text-dim">{persona.soldOut}</div>
        ) : (
          stock.map((line) => {
            const reason = blockedReason(line, balance, persona);
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
              owned(line.itemId) > 0 ? `${owned(line.itemId)} owned` : null,
            ].filter(Boolean);
            return (
              <ItemRow
                key={line.itemId}
                itemId={line.itemId}
                onInspect={setInspectItemId}
                inspectTitle="Inspect card"
                colour={persona.colour}
                subtitle={
                  <>
                    {persona.price(line.price)}
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
          origin={inspectOrigin(inspected.itemId)}
          onClose={() => setInspectItemId(null)}
          equipped={equipped}
          meta={persona.price(inspected.price)}
          footer={
            <button
              type="button"
              className="btn"
              disabled={
                !!blockedReason(inspected, balance, persona) ||
                pendingItemId !== null
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
