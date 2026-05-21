import { cn } from "../lib/utils";

export function NumberTicker({
  value,
  min = 0,
  max,
  onChange,
  size = "normal",
}: {
  value: number;
  min?: number;
  max: number;
  onChange: (v: number) => void;
  size?: "normal" | "small";
}) {
  const small = size === "small";
  const clamped = Math.max(min, Math.min(value, max));

  return (
    <>
      <button
        className={cn("btn", small && "text-ui-sm px-[5px] py-px")}
        onClick={() => onChange(Math.max(min, clamped - 1))}
      >
        −
      </button>
      <input
        type="number"
        min={min}
        max={max}
        value={clamped}
        onChange={(e) =>
          onChange(Math.max(min, Math.min(max, Number(e.target.value))))
        }
        className={cn(
          "input text-center",
          small ? "w-9 text-ui-sm px-0.5 py-px" : "w-[60px]",
        )}
      />
      <button
        className={cn("btn", small && "text-ui-sm px-[5px] py-px")}
        onClick={() => onChange(Math.min(max, clamped + 1))}
      >
        +
      </button>
    </>
  );
}
