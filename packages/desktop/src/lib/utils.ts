import { type ClassValue, clsx } from "clsx";

export function cn(...inputs: ClassValue[]) {
  return clsx(inputs);
}

/** Formats a whole-number amount with a comma as the thousands separator (e.g. 10000 -> "10,000"). */
export function formatAmount(n: number): string {
  return Math.trunc(n)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

const nokFormatter = new Intl.NumberFormat("nb-NO", {
  style: "currency",
  currency: "NOK",
});

/** Formats a whole-øre amount as a NOK price string (e.g. 2000 -> "20,00 kr"). */
export function formatNok(ore: number): string {
  return nokFormatter.format(ore / 100);
}

/**
 * Formats a minor-unit amount in whatever currency Stripe reports, so nothing
 * client-side has to assume NOK — switching the store to USD or EUR is then a
 * Stripe-side change with no app release.
 *
 * Rendered in the user's own locale rather than nb-NO: the currency is fixed
 * by what they'll be charged, but the grouping and symbol placement should
 * read naturally wherever they are. Falls back to a bare amount if the code
 * isn't one Intl recognises, since it arrives from an external service.
 */
export function formatPrice(minorUnits: number, currency: string): string {
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency: currency.toUpperCase(),
    }).format(minorUnits / 100);
  } catch {
    return `${(minorUnits / 100).toFixed(2)} ${currency.toUpperCase()}`;
  }
}

/** Stable per-user chat name colour (360 hues; avoids 8-bucket collisions on display names). */
export function chatUserColor(userKey: string): string {
  let hash = 0;
  for (let i = 0; i < userKey.length; i++) {
    hash = (hash * 31 + userKey.charCodeAt(i)) | 0;
  }
  const hue = Math.abs(hash) % 360;
  return `hsl(${hue} 65% 72%)`;
}
