import { lookup } from "node:dns/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { Readable } from "node:stream";
import type { NativeHarnessWebFetchResult } from "./nativeHarnessTools";

const MAX_REDIRECTS = 5;
const DEFAULT_TIMEOUT_MS = 30_000;

/** One hop of a public fetch: no automatic redirects, the caller follows them. */
export type PublicFetchTransport = (
  url: URL,
  init: {
    readonly signal: AbortSignal;
    readonly headers: Readonly<Record<string, string>>;
    readonly redirect: "manual";
  },
) => Promise<Response>;

export interface FetchPublicUrlOptions {
  readonly url: string;
  readonly maxBytes: number;
  readonly signal?: AbortSignal;
  /** Defaults to the pinned transport; a test may hand in a fake. */
  readonly fetch?: PublicFetchTransport;
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
  const doFetch = options.fetch ?? createPinnedFetch();
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

/**
 * A transport that connects only to addresses that passed the private-network
 * check, at connect time. Bun's `fetch` resolves the name itself, so a name
 * could pass the check and then resolve to a private address a moment later;
 * `node:http` takes a `lookup`, so every address the name resolves to is
 * checked right where the socket opens, and the hostname still reaches the
 * server as `Host` and TLS server name.
 */
export function createPinnedFetch(
  dependencies: {
    readonly resolveAll?: (hostname: string) => Promise<ReadonlyArray<string>>;
    readonly isPrivate?: (address: string) => boolean;
  } = {},
): PublicFetchTransport {
  const resolveAll = dependencies.resolveAll ?? defaultResolveAll;
  const isPrivate = dependencies.isPrivate ?? isPrivateAddress;
  return (url, init) =>
    new Promise<Response>((resolve, reject) => {
      const secure = url.protocol === "https:";
      const lookup = (
        hostname: string,
        _options: unknown,
        callback: (
          error: Error | null,
          addresses?: ReadonlyArray<{ readonly address: string; readonly family: number }>,
        ) => void,
      ) => {
        resolveAll(hostname).then(
          (addresses) => {
            if (addresses.length === 0) {
              callback(new PublicFetchRefused("unresolvable"));
              return;
            }
            if (addresses.some((address) => isPrivate(address))) {
              callback(new PublicFetchRefused("private-destination"));
              return;
            }
            callback(
              null,
              addresses.map((address) => ({ address, family: isIP(address) })),
            );
          },
          (error: unknown) => callback(error instanceof Error ? error : new Error(String(error))),
        );
      };
      const request = (secure ? httpsRequest : httpRequest)(
        {
          host: url.hostname,
          port: url.port.length > 0 ? Number(url.port) : secure ? 443 : 80,
          path: `${url.pathname}${url.search}`,
          method: "GET",
          headers: { ...init.headers, host: url.host },
          signal: init.signal,
          lookup: lookup as never,
          ...(secure ? { servername: url.hostname } : {}),
        },
        (incoming) => {
          const headers = new Headers();
          for (const [name, value] of Object.entries(incoming.headers)) {
            if (typeof value === "string") headers.set(name, value);
            else if (Array.isArray(value)) headers.set(name, value.join(", "));
          }
          resolve(
            new Response(Readable.toWeb(incoming) as unknown as ReadableStream<Uint8Array>, {
              status: incoming.statusCode ?? 0,
              headers,
            }),
          );
        },
      );
      request.on("error", reject);
      request.end();
    });
}

async function defaultResolveAll(hostname: string): Promise<ReadonlyArray<string>> {
  const bare = hostname.startsWith("[") ? hostname.slice(1, -1) : hostname;
  if (isIP(bare) !== 0) return [bare];
  const results = await lookup(hostname, { all: true });
  return results.map((result) => result.address);
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
  if (family === 4) return isPrivateIpv4(address);
  if (family === 6) return isPrivateIpv6(address);
  return true;
}

function isPrivateIpv4(address: string): boolean {
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

/**
 * Judged on the address's value, not its spelling. Matching text prefixes let
 * `0:0:0:0:0:ffff:7f00:1` through, which connects to loopback, and missed
 * most of fe80::/10. Forms that carry an IPv4 address — mapped, NAT64, 6to4 —
 * are judged by the address they carry, because that is where the packet goes.
 */
function isPrivateIpv6(address: string): boolean {
  const words = ipv6Words(address);
  if (words === undefined) return true;
  const [w0 = 0, w1 = 0, w2 = 0, w3 = 0, w4 = 0, w5 = 0, w6 = 0, w7 = 0] = words;
  const carried = (high: number, low: number) =>
    `${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`;
  if (w0 === 0 && w1 === 0 && w2 === 0 && w3 === 0) {
    // ::ffff:0:0/96 is IPv4-mapped; the rest of ::/64 is unspecified,
    // loopback, IPv4-compatible, or reserved, none of it a public destination.
    return w4 === 0 && w5 === 0xffff ? isPrivateIpv4(carried(w6, w7)) : true;
  }
  if (w0 === 0x64 && w1 === 0xff9b) {
    // 64:ff9b::/96 is NAT64; 64:ff9b:1::/48 is reserved for local NAT64 use.
    return w2 === 0 && w3 === 0 && w4 === 0 && w5 === 0 ? isPrivateIpv4(carried(w6, w7)) : true;
  }
  if (w0 === 0x2002) return isPrivateIpv4(carried(w1, w2));
  return (
    (w0 & 0xfe00) === 0xfc00 || // fc00::/7 unique local
    (w0 & 0xffc0) === 0xfe80 || // fe80::/10 link-local
    (w0 & 0xffc0) === 0xfec0 || // fec0::/10 site-local
    (w0 & 0xff00) === 0xff00 // ff00::/8 multicast
  );
}

/** The eight 16-bit words of an address `isIP` already accepted as IPv6. */
function ipv6Words(address: string): ReadonlyArray<number> | undefined {
  let text = address.toLowerCase();
  const zone = text.indexOf("%");
  if (zone !== -1) text = text.slice(0, zone);
  const lastColon = text.lastIndexOf(":");
  const tail = text.slice(lastColon + 1);
  if (tail.includes(".")) {
    if (isIP(tail) !== 4) return undefined;
    const [a = 0, b = 0, c = 0, d = 0] = tail.split(".").map(Number);
    text = `${text.slice(0, lastColon + 1)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const halves = text.split("::");
  if (halves.length > 2) return undefined;
  const parse = (part: string | undefined) =>
    part === undefined || part.length === 0
      ? []
      : part.split(":").map((word) => parseInt(word, 16));
  const head = parse(halves[0]);
  const rest = halves.length === 2 ? parse(halves[1]) : [];
  const gap = halves.length === 2 ? 8 - head.length - rest.length : 0;
  if (gap < 0) return undefined;
  const words = [...head, ...Array.from({ length: gap }, () => 0), ...rest];
  if (words.length !== 8 || words.some((word) => !(word >= 0 && word <= 0xffff))) return undefined;
  return words;
}
