/**
 * A page's declared icon, fetched once by the host through the page's own
 * session so it follows the profile and network rules the page already has.
 * The result is a bounded `data:` URL held in memory for the tab; nothing is
 * written to disk and the address (which may carry a query string) is never
 * logged. Any failure leaves the tab without an icon, which the renderer draws
 * as the globe.
 */

export const FAVICON_MAX_BYTES = 64 * 1024;
export const FAVICON_TIMEOUT_MS = 5_000;

const IMAGE_TYPES: ReadonlySet<string> = new Set([
  "image/png",
  "image/x-icon",
  "image/vnd.microsoft.icon",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/svg+xml",
]);

export interface FaviconSession {
  fetch(
    url: string,
    init: { readonly signal: AbortSignal; readonly credentials: "omit" },
  ): Promise<Response>;
}

/** The image type the bytes themselves show, never the address's extension. */
export function sniffImageType(bytes: Uint8Array): string | undefined {
  const at = (index: number) => bytes[index];
  if (bytes.length >= 8 && at(0) === 0x89 && at(1) === 0x50 && at(2) === 0x4e && at(3) === 0x47)
    return "image/png";
  if (bytes.length >= 4 && at(0) === 0 && at(1) === 0 && at(2) === 1 && at(3) === 0)
    return "image/x-icon";
  if (bytes.length >= 3 && at(0) === 0xff && at(1) === 0xd8 && at(2) === 0xff) return "image/jpeg";
  if (bytes.length >= 6 && at(0) === 0x47 && at(1) === 0x49 && at(2) === 0x46 && at(3) === 0x38)
    return "image/gif";
  if (
    bytes.length >= 12 &&
    at(0) === 0x52 &&
    at(1) === 0x49 &&
    at(2) === 0x46 &&
    at(3) === 0x46 &&
    at(8) === 0x57 &&
    at(9) === 0x45 &&
    at(10) === 0x42 &&
    at(11) === 0x50
  )
    return "image/webp";
  const head = new TextDecoder().decode(bytes.subarray(0, 512)).trimStart().toLowerCase();
  if (head.startsWith("<svg") || (head.startsWith("<?xml") && head.includes("<svg")))
    return "image/svg+xml";
  return undefined;
}

/** The first http(s) address among a page's declared icons. */
export function firstHttpIcon(favicons: readonly unknown[]): string | undefined {
  for (const candidate of favicons) {
    if (typeof candidate !== "string" || candidate.length > 4_096) continue;
    try {
      const url = new URL(candidate);
      if (url.protocol === "http:" || url.protocol === "https:") return url.href;
    } catch {
      // Not an address; the next one may be.
    }
  }
  return undefined;
}

export async function fetchFaviconDataUrl(
  session: FaviconSession,
  iconUrl: string,
  options: { readonly timeoutMs?: number } = {},
): Promise<string | undefined> {
  let scheme: string;
  try {
    scheme = new URL(iconUrl).protocol;
  } catch {
    return undefined;
  }
  if (scheme !== "http:" && scheme !== "https:") return undefined;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? FAVICON_TIMEOUT_MS);
  try {
    const response = await session.fetch(iconUrl, {
      signal: controller.signal,
      credentials: "omit",
    });
    if (!response.ok || response.body === null) return undefined;
    const declared = (response.headers.get("content-type") ?? "")
      .split(";")[0]
      ?.trim()
      .toLowerCase();
    if (declared === undefined || !IMAGE_TYPES.has(declared)) return undefined;
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      if (next.value === undefined) continue;
      total += next.value.byteLength;
      if (total > FAVICON_MAX_BYTES) {
        await reader.cancel().catch(() => undefined);
        return undefined;
      }
      chunks.push(next.value);
    }
    if (total === 0) return undefined;
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const sniffed = sniffImageType(bytes);
    if (sniffed === undefined) return undefined;
    return `data:${sniffed};base64,${Buffer.from(bytes).toString("base64")}`;
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}
