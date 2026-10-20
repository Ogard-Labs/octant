export const IMAGE_MEDIA_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);

export type ReadBytesResult =
  | { readonly status: "ok"; readonly bytes: Uint8Array }
  | { readonly status: "unreadable" };

/** A picked file that cannot be fetched must not upload the error body as an image. */
export async function readUriBytes(uri: string): Promise<ReadBytesResult> {
  const response = await fetch(uri);
  if (!response.ok) return { status: "unreadable" };
  return { status: "ok", bytes: new Uint8Array(await response.arrayBuffer()) };
}

export function guessImageMediaType(uri: string, reported?: string | null): string {
  if (reported !== undefined && reported !== null && IMAGE_MEDIA_TYPES.has(reported)) {
    return reported;
  }
  const lower = uri.toLowerCase();
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".webp")) return "image/webp";
  if (lower.endsWith(".gif")) return "image/gif";
  return "image/jpeg";
}
