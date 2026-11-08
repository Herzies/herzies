import type {
  ArtItem,
  CardArtEntry,
  ItemArtData,
  PixelArt,
} from "@/lib/item-art";

export type { ArtItem, CardArtEntry, ItemArtData, PixelArt };

/** The item art workshop's API (see api/admin/item-art). */
export async function artRequest<T>(
  secret: string,
  path: string,
  init?: RequestInit,
): Promise<T> {
  const res = await fetch(`/api/admin/item-art${path}`, {
    ...init,
    headers: {
      ...(secret ? { "x-admin-secret": secret } : {}),
      ...init?.headers,
    },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(
      (body as { error?: string }).error ?? `Request failed (${res.status})`,
    );
  }
  return body as T;
}

export function postJson<T>(
  secret: string,
  path: string,
  body: unknown,
  method = "POST",
): Promise<T> {
  return artRequest<T>(secret, path, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** An uploaded original, decoded. The request carries the admin auth, so
 * it's fetched rather than pointed at by an <img src>. */
export async function loadOriginal(
  secret: string,
  name: string,
): Promise<HTMLImageElement> {
  const res = await fetch(
    `/api/admin/item-art/file/source/${encodeURIComponent(name)}`,
    { headers: secret ? { "x-admin-secret": secret } : {}, cache: "no-store" },
  );
  if (!res.ok) throw new Error("Could not load the original");
  const url = URL.createObjectURL(await res.blob());
  try {
    return await new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error("Could not decode the original"));
      img.src = url;
    });
  } finally {
    // The decoded image keeps its pixels.
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}
