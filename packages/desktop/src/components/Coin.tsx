import { useEffect, useRef, useState } from "react";
import { cn, formatAmount } from "../lib/utils";

const COUNT_MS = 550;

function easeOutCubic(t: number) {
  return 1 - (1 - t) ** 3;
}

/** Inline "H 1,234" currency readout — italic H marks herzie coins. */
export function Coin({
  amount,
  animate = false,
}: {
  amount: number;
  /** Pulse and count the digits when the balance changes. Opt in only for
   * real balance readouts (e.g. header totals) — leave off for one-off
   * price previews (buy/sell buttons, trade offers). */
  animate?: boolean;
}) {
  const [displayed, setDisplayed] = useState(amount);
  const [direction, setDirection] = useState<"up" | "down" | null>(null);
  const [bumpSeq, setBumpSeq] = useState(0);
  const prevRef = useRef(amount);

  useEffect(() => {
    if (!animate || amount === prevRef.current) {
      prevRef.current = amount;
      setDisplayed(amount);
      return;
    }

    const from = prevRef.current;
    const to = amount;
    prevRef.current = amount;
    setDirection(to > from ? "up" : "down");
    setBumpSeq((s) => s + 1);

    let frame: number;
    const start = performance.now();
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / COUNT_MS);
      setDisplayed(Math.round(from + (to - from) * easeOutCubic(t)));
      if (t < 1) {
        frame = requestAnimationFrame(tick);
      } else {
        setDirection(null);
      }
    };
    frame = requestAnimationFrame(tick);

    return () => cancelAnimationFrame(frame);
  }, [amount, animate]);

  if (!animate) {
    return (
      <>
        <span className="italic">H</span> {formatAmount(amount)}
      </>
    );
  }

  return (
    <span
      key={bumpSeq}
      className={cn(
        direction === "up" && "text-green animate-coin-bump",
        direction === "down" && "text-red animate-coin-bump",
      )}
    >
      <span className="italic">H</span> {formatAmount(displayed)}
    </span>
  );
}
