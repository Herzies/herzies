import type { CSSProperties, ReactNode } from "react";
import { cn } from "../lib/utils";

/**
 * The app's checkbox: a square in the same 1px-border language as `btn` and
 * `input`, filled with `accent` and a pixel check when on. The whole thing —
 * box and whatever's passed as children — is one button, so the label is
 * part of the hit target instead of a separate click-to-focus <label>.
 *
 * `accent` is a CSS colour, not a class, so a caller can tie it to what the
 * box stands for (e.g. a rarity colour) rather than a theme token.
 */
export function Checkbox({
  checked,
  onChange,
  disabled = false,
  accent = "var(--color-cyan)",
  className,
  style,
  children,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  accent?: string;
  className?: string;
  style?: CSSProperties;
  children?: ReactNode;
}) {
  return (
    // biome-ignore lint/a11y/useSemanticElements: a native checkbox can't be styled like this or wrap the row it labels; role + aria-checked give it the same semantics.
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        "flex items-center gap-2 bg-transparent text-left text-text",
        disabled ? "cursor-not-allowed" : "cursor-pointer",
        className,
      )}
      style={style}
    >
      <span
        aria-hidden="true"
        className={cn(
          "flex h-3 w-3 shrink-0 items-center justify-center border transition-colors duration-100",
          !checked && "border-[#555]",
          disabled && "border-dashed",
        )}
        style={
          checked ? { background: accent, borderColor: accent } : undefined
        }
      >
        {checked && (
          // A 6x5 pixel check, drawn on the pixel grid so it stays crisp
          // at this size instead of anti-aliasing into a smudge.
          <svg
            aria-hidden="true"
            viewBox="0 0 6 5"
            className="h-[7px] w-[8px]"
            shapeRendering="crispEdges"
          >
            <path
              d="M0 2h1v1H0zM1 3h1v1H1zM2 4h1v1H2zM3 3h1v1H3zM4 2h1v1H4zM5 1h1v1H5zM5 0h1v1H5z"
              fill="var(--color-bg)"
            />
          </svg>
        )}
      </span>
      {children}
    </button>
  );
}
