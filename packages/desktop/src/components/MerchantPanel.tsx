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
  MEDEA_EQUIPPED,
  MEDEA_KEY,
  MEDEA_NAME,
  MEDEA_SEED,
  MEDEA_STAGE,
  MEDEA_STOCK,
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
import { useHerzieStage } from "../lib/overlayStage";
import { herzies } from "../tauri-bridge";
import { Coin } from "./Coin";
import { FloatingCoins } from "./FloatingCoins";
import ItemInspectOverlay, { inspectOrigin } from "./ItemInspectOverlay";
import { ItemRow } from "./ItemRow";
import { List } from "./List";
import { NumberTicker } from "./NumberTicker";
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

/** Medea's murmurs: sweet on the surface, something older underneath. */
export const MEDEA_LINES = [
  "Sweets for the wounded. Potions for the brave.",
  "Star Candy. Picked when the sky was falling. Mostly.",
  "One bite and the bruises forget themselves.",
  "Don't ask what's in it. You'll sleep better.",
  "Hurt? Of course you are. Come closer.",
  "The boss bites. My candy bites back.",
  "I knew you'd come. They always come back.",
  "Pink for the heart, blue for the stars. Eat it all.",
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

const MEDEA: MerchantPersona = {
  name: MEDEA_NAME,
  seed: MEDEA_SEED,
  stage: MEDEA_STAGE,
  equipped: MEDEA_EQUIPPED,
  lines: MEDEA_LINES,
  shortName: MEDEA_NAME,
  colour: "cyan",
  headingClass: "text-[#ff8fd0]",
  price: (amount) => <Coin amount={amount} />,
  broke: "Insufficient funds",
  soldOut: "Medea's jars are empty.",
};

/** A resident's price list as stall lines: no caps, no limits. */
const residentStall = (
  stock: readonly { itemId: string; price: number }[],
): MerchantStockView[] =>
  stock.map((l) => ({
    ...l,
    perPlayerLimit: null,
    totalStock: null,
    remaining: null,
    yourBought: 0,
  }));

const BOBOKU_STALL = residentStall(BOBOKU_STOCK);
const MEDEA_STALL = residentStall(MEDEA_STOCK);

/** The most of one line bought at once (Boboku's and Medea's routes take
 * no more than this). */
const MAX_PER_BUY = 10;

/** How many of a line can be bought in one go: up to MAX_PER_BUY, what's
 * left, your remaining share, and what you can afford. At least 1, so a
 * blocked line still shows a sensible number. */
function maxQuantity(line: MerchantStockView, balance: number) {
  let max = MAX_PER_BUY;
  if (line.remaining != null) max = Math.min(max, line.remaining);
  if (line.perPlayerLimit != null) {
    max = Math.min(max, line.perPlayerLimit - line.yourBought);
  }
  if (line.price > 0) max = Math.min(max, Math.floor(balance / line.price));
  return Math.max(1, max);
}

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
 * live event (projected by buildMerchantConfig) — or Boboku or Medea,
 * always in Town, selling from BOBOKU_STOCK / MEDEA_STOCK with no event at
 * all. The server re-checks
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
  /** The visit behind the stall, or a resident's (Boboku, Medea), which
   * has none. */
  event: GameEvent | typeof BOBOKU_KEY | typeof MEDEA_KEY;
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
  const medea = event === MEDEA_KEY;
  const config = boboku || medea ? null : event.config;
  const [pendingItemId, setPendingItemId] = useState<string | null>(null);
  // How many of each stackable line to buy (1 unless picked).
  const [quantities, setQuantities] = useState<Record<string, number>>({});
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
    : medea
      ? MEDEA
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
    : medea
      ? MEDEA_STALL
      : ((config as unknown as MerchantView).stock ?? []);
  const stock = lines.map((line) => {
    const extra = boughtNow[line.itemId] ?? 0;
    return {
      ...line,
      yourBought: line.yourBought + extra,
      remaining: line.remaining == null ? null : line.remaining - extra,
    };
  });

  /** The quantity picker shows only for stackable items (sweets, treats):
   * a stack of copies is one bank slot, and buying several is the point. */
  const stackable = (itemId: string) => !!getItem(itemId)?.stackable;
  const quantityOf = (line: MerchantStockView) =>
    stackable(line.itemId)
      ? Math.min(quantities[line.itemId] ?? 1, maxQuantity(line, balance))
      : 1;

  const buy = async (itemId: string, quantity: number) => {
    setError(null);
    setPendingItemId(itemId);
    try {
      if (boboku) await herzies.buyFromBoboku(itemId, quantity);
      else if (medea) await herzies.buyFromMedea(itemId, quantity);
      else await herzies.buyFromMerchant(event.id, itemId, quantity);
      setBoughtNow((b) => ({ ...b, [itemId]: (b[itemId] ?? 0) + quantity }));
      // Back to 1, so the next click doesn't buy a stack by surprise.
      setQuantities((q) => ({ ...q, [itemId]: 1 }));
      const name = getItem(itemId)?.name ?? itemId;
      onLog?.(
        quantity > 1
          ? `Bought ${quantity} "${name}" from ${persona.name}`
          : `Bought "${name}" from ${persona.name}`,
      );
      onBought();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setPendingItemId(null);
    }
  };

  /** A line's Buy button, with the quantity picker beside it for
   * stackable items. */
  const buyControls = (line: MerchantStockView) => {
    const reason = blockedReason(line, balance, persona);
    const quantity = quantityOf(line);
    const button = (
      <button
        type="button"
        className="btn"
        disabled={!!reason || pendingItemId !== null}
        onClick={() => buy(line.itemId, quantity)}
      >
        {pendingItemId === line.itemId ? (
          "Buying..."
        ) : quantity > 1 ? (
          <>Buy ({persona.price(line.price * quantity)})</>
        ) : (
          "Buy"
        )}
      </button>
    );
    return (
      <div className="flex items-center gap-1">
        {stackable(line.itemId) && !reason && (
          <NumberTicker
            value={quantity}
            min={1}
            max={maxQuantity(line, balance)}
            size="small"
            onChange={(v) => setQuantities((q) => ({ ...q, [line.itemId]: v }))}
          />
        )}
        {reason ? <Tooltip label={reason}>{button}</Tooltip> : button}
      </div>
    );
  };

  const inspected = stock.find((l) => l.itemId === inspectItemId);
  const { line, typed, advance } = useChatter(persona.lines, !paused);
  // Inside a window or the visitor panel, drawn on its canvas.
  const { stage: onStage } = useHerzieStage();

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
            onStage={onStage}
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
                action={buyControls(line)}
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
          footer={buyControls(inspected)}
        />
      )}
    </div>
  );
}
