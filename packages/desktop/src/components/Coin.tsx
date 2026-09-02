import { formatAmount } from "../lib/utils";

/** Inline "H 1,234" currency readout — italic H marks herzie coins. */
export function Coin({ amount }: { amount: number }) {
  return (
    <>
      <span className="italic">H</span> {formatAmount(amount)}
    </>
  );
}
