import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import type { NativeHarnessWebFetchResult } from "./nativeHarnessTools";

const MAX_REDIRECTS = 5;
const DEFAULT_TIMEOUT_MS = 30_000;

export interface FetchPublicUrlOptions {
  readonly url: string;
  readonly maxBytes: number;
  readonly signal?: AbortSignal;
  readonly fetch?: typeof fetch;
  readonly resolveAddress?: (hostname: string) => Promise<string>;
  readonly timeoutMs?: number;
}

export class PublicFetchRefused extends Error {
  override readonly name = "PublicFetchRefused";
  constructor(readonly reason: string) {
    super(reason);
  }
}

/**
 * Fetch a URL the model chose, without letting it reach the host's own
 * network. Every hop — the first request and each redirect — is resolved and
 * checked before it is followed, so a public name that answers with a private
 * address, or redirects into one, is refused rather than fetched.
 */
export async function fetchPublicUrl(
  options: FetchPublicUrlOptions,
): Promise<NativeHarnessWebFetchResult> {
  const doFetch = options.fetch ?? fetch;
  const resolveAddress = options.resolveAddress ?? defaultResolve;
  let current = new URL(options.url);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    if (current.protocol !== "http:" && current.protocol !== "https:") {
      throw new PublicFetchRefused("scheme-not-allowed");
    }
    if (current.username.length > 0 || current.password.length > 0) {
      throw new PublicFetchRefused("credentials-in-url");
    }
    const address = await resolveAddress(current.hostname);
    if (isPrivateAddress(address)) throw new PublicFetchRefused("private-destination");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    const onAbort = () => controller.abort();
    options.signal?.addEventListener("abort", onAbort, { once: true });
    try {
      const response = await doFetch(current, {
        redirect: "manual",
        signal: controller.signal,
        headers: { accept: "text/html, text/plain, application/json, */*;q=0.5" },
      });
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        if (location === null) throw new PublicFetchRefused("redirect-without-location");
        current = new URL(location, current);
        continue;
      }
      const contentType = response.headers.get("content-type") ?? undefined;
      const { text, truncated } = await readBounded(response, options.maxBytes);
      return {
        status: response.status,
        ...(contentType === undefined ? {} : { contentType }),
        text: contentType?.includes("text/html") === true ? htmlToText(text) : text,
        truncated,
        finalUrl: current.toString(),
      };
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
    }
  }
  throw new PublicFetchRefused("too-many-redirects");
}

async function defaultResolve(hostname: string): Promise<string> {
  if (isIP(hostname) !== 0) return hostname;
  const bare = hostname.startsWith("[") ? hostname.slice(1, -1) : hostname;
  if (isIP(bare) !== 0) return bare;
  const result = await lookup(hostname);
  return result.address;
}

async function readBounded(
  response: Response,
  maxBytes: number,
): Promise<{ readonly text: string; readonly truncated: boolean }> {
  if (response.body === null) return { text: "", truncated: false };
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value === undefined) continue;
    if (total + value.byteLength > maxBytes) {
      chunks.push(value.subarray(0, maxBytes - total));
      total = maxBytes;
      truncated = true;
      await reader.cancel();
      break;
    }
    chunks.push(value);
    total += value.byteLength;
  }
  return { text: Buffer.concat(chunks).toString("utf8"), truncated };
}

/** A readable reduction of markup; scripts and styles are dropped entirely. */
export function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<\/(p|div|li|h[1-6]|tr|br|section|article)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function isPrivateAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) {
    const [a = 0, b = 0] = address.split(".").map(Number);
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127) ||
      a >= 224
    );
  }
  if (family === 6) {
    const lower = address.toLowerCase();
    if (lower === "::" || lower === "::1") return true;
    if (lower.startsWith("fe80:") || lower.startsWith("fc") || lower.startsWith("fd")) return true;
    if (lower.startsWith("::ffff:")) return isPrivateAddress(lower.slice("::ffff:".length));
    return false;
  }
  return true;
}
