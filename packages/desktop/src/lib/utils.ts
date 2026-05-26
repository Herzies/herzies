import { type ClassValue, clsx } from "clsx";

export function cn(...inputs: ClassValue[]) {
  return clsx(inputs);
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
