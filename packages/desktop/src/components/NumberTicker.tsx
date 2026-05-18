import { btnStyle, inputStyle } from "./styles";

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
  const bStyle = {
    ...btnStyle,
    ...(small ? { fontSize: 9, padding: "1px 5px" } : {}),
  };
  const iStyle = {
    ...inputStyle,
    width: small ? 36 : 60,
    textAlign: "center" as const,
    ...(small ? { fontSize: 9, padding: "1px 2px" } : {}),
  };
  const clamped = Math.max(min, Math.min(value, max));

  return (
    <>
      <button
        style={bStyle}
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
        style={iStyle}
      />
      <button
        style={bStyle}
        onClick={() => onChange(Math.min(max, clamped + 1))}
      >
        +
      </button>
    </>
  );
}
