import { MAX_GENERATED_IMAGE_BYTES } from "@octant/contracts";
import type {
  ImageArtifactMediaType,
  OutsideDriverKeyPlacement,
  ProviderFailure,
  ProviderInstanceId,
  ProviderModelId,
} from "@octant/contracts";
import {
  decodeOutsideDriverImageGenerateResult,
  decodeOutsideDriverInitializeResult,
  HOST_IMAGE_GENERATION_PROTOCOL_VERSIONS,
  OUTSIDE_DRIVER_MAX_REFERENCE_IMAGES_BYTES,
  OUTSIDE_DRIVER_METHODS,
  type OutsideDriverGeneratedImage,
  type OutsideDriverImageGenerateParams,
} from "@octant/contracts/outside-driver-protocol";
import { isPublicNetworkAddress } from "@octant/domain/network-address-policy";
import { parseNetworkAddress } from "@octant/domain/safe-network-policy";
import type {
  ImageAdapterImage,
  ImageAdapterRequest,
  ImageAdapterResult,
  ImageGenerationPorts,
} from "@octant/provider-sdk/image-generation";
import { lookup } from "node:dns/promises";
import type { ProviderCredentialResolver } from "./credentialBrokerClient";
import {
  makeOutsideDriverBroker,
  OUTSIDE_DRIVER_DEFAULT_LIMITS,
  OutsideDriverLink,
  outsideDriverClosedFailure,
  outsideDriverConfiguredOrigin,
  outsideDriverFailure,
  outsideDriverNoAgreedProtocol,
  outsideDriverStopped,
  type OutsideDriverChannel,
  type OutsideDriverFetch,
  type OutsideDriverLimits,
} from "./outsideHarnessEndpointProxy";

/**
 * The host side of an outside image driver: an `ImageGenerationAdapter`
 * whose one call crosses the same line-delimited JSON-RPC channel, the same
 * brokered `http/request`, and the same closed failures as an outside harness
 * endpoint, so the image job service runs it exactly as it runs a bundled
 * image driver: the same card, price, spend reservation, storage and restart
 * handling, all of which stay in the job service.
 *
 * What only this family needs, the host decides itself:
 * - at most `variantCount` images come back, or the job fails as `protocol`
 *   and stores none;
 * - every image's bytes are sniffed by the host, and a media type the driver
 *   names that the bytes do not bear out fails the job;
 * - an address the driver returns is fetched by the host, once, without the
 *   key, over HTTPS or the configured origin, and only when that exact
 *   address appeared in a response the host relayed for this job;
 * - a safety refusal carries no driver text; the host writes the sentence.
 */

export type OutsideImageJobPorts = Pick<
  ImageGenerationPorts,
  "fetchApprovedImageUrl" | "sniffMediaType"
>;

export interface OutsideImageGenerationProxyOptions {
  readonly instanceId: ProviderInstanceId;
  readonly channel: OutsideDriverChannel;
  /** The address the person configured; a brokered request reaches only its origin. */
  readonly baseUrl: string;
  readonly key: OutsideDriverKeyPlacement | undefined;
  /** The models the person listed, each one the package declares. */
  readonly modelIds: ReadonlyArray<ProviderModelId>;
  readonly credentialResolver?: ProviderCredentialResolver;
  readonly fetch?: OutsideDriverFetch;
  readonly limits?: Partial<OutsideDriverLimits>;
  /** Called once when the driver is stopped, with the closed reason. */
  readonly onStopped?: (failure: ProviderFailure) => void;
  /** Resolves a host name to its addresses; the system resolver by default. */
  readonly resolve?: (hostname: string) => Promise<ReadonlyArray<string>>;
}

async function resolveAddresses(hostname: string): Promise<ReadonlyArray<string>> {
  return (await lookup(hostname, { all: true })).map((entry) => entry.address);
}

/**
 * Whether every address an image's host name resolves to is one the internet
 * routes to, or the address is on the configured origin. A name that does not
 * resolve is refused. The fetch resolves again, so this narrows rather than
 * closes the window for a name that changes between the two answers.
 */
async function resolvesPublicly(
  url: string,
  origin: string | undefined,
  resolve: (hostname: string) => Promise<ReadonlyArray<string>>,
): Promise<boolean> {
  const target = new URL(url);
  if (origin !== undefined && `${target.protocol}//${target.host}` === origin) return true;
  const host = target.hostname.replace(/^\[|\]$/g, "");
  if (parseNetworkAddress(host) !== undefined) return isPublicNetworkAddress(host);
  try {
    const addresses = await resolve(host);
    return addresses.length > 0 && addresses.every((address) => isPublicNetworkAddress(address));
  } catch {
    return false;
  }
}

const SAFETY_REFUSAL = "The image provider declined this request.";

/**
 * Decoded `image/chunk` bytes are copied into fixed-size blocks as they arrive
 * so allocation overhead stays bounded (at most ~80 blocks for 20 MiB) even
 * when a driver streams many small or independently-padded chunks.
 */
const STREAMED_IMAGE_BLOCK_BYTES = 256 * 1024;

/** Maximum unique provider-returned URLs retained across one image job. */
const MAX_RELAYED_ADDRESSES_PER_JOB = 1_024;
const MAX_RELAYED_ADDRESS_LENGTH = 8_192;

interface StreamedImageBlocks {
  readonly blocks: Array<Uint8Array>;
  bytes: number;
  offsetInLast: number;
}

function appendStreamedImageBytes(state: StreamedImageBlocks, piece: Uint8Array): void {
  let remainingOffset = 0;
  while (remainingOffset < piece.byteLength) {
    let tail = state.blocks[state.blocks.length - 1];
    if (tail === undefined || state.offsetInLast === tail.byteLength) {
      tail = new Uint8Array(STREAMED_IMAGE_BLOCK_BYTES);
      state.blocks.push(tail);
      state.offsetInLast = 0;
    }
    const copyLength = Math.min(
      piece.byteLength - remainingOffset,
      tail.byteLength - state.offsetInLast,
    );
    tail.set(piece.subarray(remainingOffset, remainingOffset + copyLength), state.offsetInLast);
    state.offsetInLast += copyLength;
    state.bytes += copyLength;
    remainingOffset += copyLength;
  }
}

function assembleStreamedImageBlocks(state: StreamedImageBlocks): Uint8Array {
  const result = new Uint8Array(state.bytes);
  let written = 0;
  for (let i = 0; i < state.blocks.length; i += 1) {
    const block = state.blocks[i];
    if (block === undefined) continue;
    const slice = i === state.blocks.length - 1 ? block.subarray(0, state.offsetInLast) : block;
    result.set(slice, written);
    written += slice.byteLength;
  }
  return result;
}

const imageInvalid = () =>
  outsideDriverFailure("protocol", "The image driver returned an image Octant could not accept.");
const tooLarge = () =>
  outsideDriverFailure("protocol", "The image driver sent more image data than Octant accepts.");
const tooManyImages = () =>
  outsideDriverFailure("protocol", "The provider returned more images than requested.");

export function makeOutsideImageGenerationProxy(options: OutsideImageGenerationProxyOptions) {
  const limits: OutsideDriverLimits = { ...OUTSIDE_DRIVER_DEFAULT_LIMITS, ...options.limits };
  const origin = outsideDriverConfiguredOrigin(options.baseUrl);
  let handshake: Promise<void> | undefined;

  const link = new OutsideDriverLink({
    channel: options.channel,
    limits,
    broker: makeOutsideDriverBroker({
      instanceId: options.instanceId,
      origin,
      key: options.key,
      credentialResolver: options.credentialResolver,
      fetch: options.fetch ?? ((input, init) => fetch(input, init)),
      limits,
    }),
    onStopped: (reason) => options.onStopped?.(reason),
  });

  const stopped = (): ProviderFailure => {
    link.stop(outsideDriverStopped());
    return link.stopped ?? outsideDriverStopped();
  };

  const initialize = async () => {
    const { settled } = link.call(
      OUTSIDE_DRIVER_METHODS.initialize,
      {
        protocolVersions: HOST_IMAGE_GENERATION_PROTOCOL_VERSIONS,
        configuration: { baseUrl: options.baseUrl, modelIds: options.modelIds },
      },
      { timeoutMs: limits.callTimeoutMs },
    );
    const decoded = decodeOutsideDriverInitializeResult(await settled);
    if (decoded._tag === "Left") throw stopped();
    if (!HOST_IMAGE_GENERATION_PROTOCOL_VERSIONS.includes(decoded.right.protocolVersion)) {
      link.stop(outsideDriverNoAgreedProtocol());
      throw link.stopped ?? outsideDriverNoAgreedProtocol();
    }
    // Cloud sessions belong to the harness endpoint family alone.
    if (decoded.right.cloudSessions !== undefined) throw stopped();
  };
  const ensureInitialized = async () => {
    if (link.stopped !== undefined) throw link.stopped;
    handshake ??= initialize().catch((error: unknown) => {
      // A handshake that did not stop the driver (a timeout) may be tried again.
      handshake = undefined;
      throw error;
    });
    await handshake;
  };

  /** One image's bytes as the host accepts them, or a closed failure. */
  const accept = async (
    image: OutsideDriverGeneratedImage,
    hasReturnedAddress: (url: string) => boolean,
    streamed: StreamedImageBlocks | undefined,
    signal: AbortSignal | undefined,
    ports: OutsideImageJobPorts,
  ): Promise<ImageAdapterImage> => {
    let bytes: Uint8Array;
    let named: ImageArtifactMediaType | undefined;
    if ("data" in image) {
      bytes = Uint8Array.from(Buffer.from(image.data, "base64"));
      named = image.mediaType;
    } else if ("chunked" in image) {
      if (streamed === undefined || streamed.bytes === 0) throw imageInvalid();
      bytes = assembleStreamedImageBlocks(streamed);
      named = image.mediaType;
    } else {
      if (!isFetchableImageAddress(image.url, origin) || !hasReturnedAddress(image.url)) {
        throw outsideDriverFailure(
          "unauthorized",
          "The image driver named an image address the provider did not return.",
        );
      }
      if (!(await resolvesPublicly(image.url, origin, options.resolve ?? resolveAddresses))) {
        throw outsideDriverFailure(
          "unauthorized",
          "The image driver named an image address on a private network.",
        );
      }
      const fetched = await ports.fetchApprovedImageUrl({
        url: image.url,
        ...(signal === undefined ? {} : { signal }),
      });
      if ("failure" in fetched) {
        throw outsideDriverFailure(fetched.failure.category, fetched.failure.message);
      }
      bytes = fetched.bytes;
    }
    const sniffed = ports.sniffMediaType(bytes);
    if (sniffed === undefined || (named !== undefined && named !== sniffed)) throw imageInvalid();
    return { bytes, mediaType: sniffed };
  };

  const generate = async (
    request: ImageAdapterRequest,
    ports: OutsideImageJobPorts,
    onProviderResponse: () => void,
  ): Promise<ImageAdapterResult> => {
    const totalReferenceBytes = (request.references ?? []).reduce(
      (sum, reference) => sum + reference.bytes.byteLength,
      0,
    );
    if (totalReferenceBytes > OUTSIDE_DRIVER_MAX_REFERENCE_IMAGES_BYTES) {
      throw outsideDriverFailure(
        "invalid-configuration",
        "Reference images for an outside image driver cannot exceed 2.5 MiB combined.",
      );
    }
    await ensureInitialized();
    if (request.signal?.aborted === true) {
      throw outsideDriverFailure("interrupted", "The provider request was cancelled.");
    }
    const variantCount = request.variantCount ?? 1;
    const params: OutsideDriverImageGenerateParams = {
      modelId: request.modelId,
      prompt: request.prompt,
      variantCount,
      references: (request.references ?? []).map((reference) => ({
        mediaType: reference.mediaType,
        data: Buffer.from(reference.bytes).toString("base64"),
      })),
      ...(request.quality === undefined ? {} : { quality: request.quality }),
      ...(request.size === undefined ? {} : { size: request.size }),
      ...(request.aspectRatio === undefined ? {} : { aspectRatio: request.aspectRatio }),
      ...(request.resolution === undefined ? {} : { resolution: request.resolution }),
    };
    // Chunks are decoded on arrival into fixed-size blocks bounded by
    // MAX_GENERATED_IMAGE_BYTES per image, independent of wire chunk count.
    const chunks = new Map<number, StreamedImageBlocks>();
    // Completed brokered responses immediately release their raw text after
    // bounded URL extraction, while in-flight streams expose every chunk
    // already sent to the driver before `http/end`.
    const inFlightResponses = new Map<number, Array<string>>();
    const settledAddresses = new Set<string>();
    const hasReturnedAddress = (url: string): boolean => {
      if (settledAddresses.has(url)) return true;
      for (const parts of inFlightResponses.values()) {
        const live = new Set<string>();
        extractReturnedAddresses(parts.join(""), live, false);
        if (live.has(url)) return true;
      }
      return false;
    };
    let oversized = false;
    const call = link.call(OUTSIDE_DRIVER_METHODS.imageGenerate, params, {
      timeoutMs: limits.sendTimeoutMs,
      closeBrokeredOnSettle: true,
      onProviderResponse,
      onRelayedResponseChunk: (httpId, text) => {
        const parts = inFlightResponses.get(httpId);
        if (parts === undefined) inFlightResponses.set(httpId, [text]);
        else parts.push(text);
      },
      onRelayedResponseEnd: (httpId, completedNormally) => {
        const parts = inFlightResponses.get(httpId);
        if (parts === undefined) return;
        inFlightResponses.delete(httpId);
        extractReturnedAddresses(parts.join(""), settledAddresses, completedNormally);
      },
      onImageChunk: (image, data) => {
        if (oversized) return;
        if (image >= variantCount) {
          oversized = true;
          chunks.clear();
          link.cancel(call.id);
          return;
        }
        const piece = Buffer.from(data, "base64");
        const state = chunks.get(image) ?? { blocks: [], bytes: 0, offsetInLast: 0 };
        if (state.bytes + piece.byteLength > MAX_GENERATED_IMAGE_BYTES) {
          oversized = true;
          chunks.clear();
          link.cancel(call.id);
          return;
        }
        appendStreamedImageBytes(state, piece);
        chunks.set(image, state);
      },
    });
    const cancel = () => link.cancel(call.id);
    request.signal?.addEventListener("abort", cancel, { once: true });
    try {
      let settled: unknown;
      try {
        settled = await call.settled;
      } catch (error) {
        if (oversized) throw tooLarge();
        throw error;
      }
      const decoded = decodeOutsideDriverImageGenerateResult(settled);
      if (decoded._tag === "Left") throw stopped();
      const result = decoded.right;
      if (result.status === "refused") return { status: "refused", safetyRefusal: SAFETY_REFUSAL };
      if (result.images.length > variantCount) throw tooManyImages();
      const images: Array<ImageAdapterImage> = [];
      for (const [index, image] of result.images.entries()) {
        const streamed = chunks.get(index);
        chunks.delete(index);
        images.push(await accept(image, hasReturnedAddress, streamed, request.signal, ports));
      }
      return { status: "completed", images };
    } finally {
      chunks.clear();
      inFlightResponses.clear();
      request.signal?.removeEventListener("abort", cancel);
    }
  };

  return {
    // `generate` never rejects: a broken driver ends as a recorded failure.
    generate: async (
      request: ImageAdapterRequest,
      ports: OutsideImageJobPorts,
      onProviderResponse: () => void,
    ): Promise<ImageAdapterResult> => {
      try {
        return await generate(request, ports, onProviderResponse);
      } catch (error) {
        return { status: "failed", providerFailure: outsideDriverClosedFailure(error) };
      }
    },
  };
}

/**
 * Extracts every complete address from one provider response into `out`,
 * capped at `MAX_RELAYED_ADDRESSES_PER_JOB`. Completed JSON responses are
 * parsed directly, SSE responses are framed by line and event so comments and
 * metadata never interfere with `data:` payloads, and partial JSON uses a
 * linear string-literal scanner (no backtracking regexes and no bare-URL
 * fallback over raw JSON escapes). A truncated chunk cannot authorize a URL
 * prefix, and an embedded query parameter cannot authorize an inner URL.
 */
function extractReturnedAddresses(responseText: string, out: Set<string>, complete: boolean): void {
  const add = (candidate: string) => {
    if (out.size >= MAX_RELAYED_ADDRESSES_PER_JOB) return;
    if (candidate.length <= MAX_RELAYED_ADDRESS_LENGTH) out.add(candidate);
  };
  if (complete) {
    const trimmed = responseText.trim();
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      try {
        collectJsonAddresses(JSON.parse(trimmed), add);
        return;
      } catch {
        // Non-JSON or multi-document body (e.g. NDJSON/SSE); frame lines below.
      }
    }
  }
  const lines = responseText.split(/\r\n|\n|\r/);
  const endsWithNewline = /(?:\r\n|\n|\r)$/.test(responseText);
  if (endsWithNewline) lines.pop();
  const sseDataLines: Array<string> = [];
  const flushSse = () => {
    if (sseDataLines.length === 0) return;
    extractPayloadAddresses(sseDataLines.join("\n"), add, true);
    sseDataLines.length = 0;
  };
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line === undefined) continue;
    const lineComplete = complete || endsWithNewline || index < lines.length - 1;
    if (line.length === 0) {
      flushSse();
      continue;
    }
    // SSE comments (`: ...`) and control fields never hold image payloads.
    if (line.startsWith(":")) continue;
    if (/^(?:event|id|retry):/.test(line)) continue;
    if (line.startsWith("data:")) {
      const value = line.startsWith("data: ") ? line.slice(6) : line.slice(5);
      if (lineComplete) {
        sseDataLines.push(value);
        // Also inspect each complete single-line `data:` value immediately so
        // live streams that answer before the trailing blank line still work.
        extractPayloadAddresses(value, add, true);
      } else {
        extractPayloadAddresses(value, add, false);
      }
      continue;
    }
    flushSse();
    extractPayloadAddresses(line, add, lineComplete);
  }
  if (complete) flushSse();
}

function extractPayloadAddresses(
  payload: string,
  add: (candidate: string) => void,
  payloadComplete: boolean,
): void {
  const trimmed = payload.trim();
  if (trimmed.length === 0) return;
  // Distinguish JSON objects/arrays from bracket-led Markdown links like
  // `[View image](https://...)` so Markdown destinations are still extracted
  // while malformed/partial JSON stays on the JSON-string-only scanner.
  const jsonShaped =
    trimmed.startsWith("{") ||
    (/^\[[\s\r\n]*(?:["{\[\]-]|true\b|false\b|null\b|[0-9])/.test(trimmed) &&
      !/^\[[^"\[\]]*\]\(/.test(trimmed));
  if (payloadComplete && jsonShaped) {
    try {
      collectJsonAddresses(JSON.parse(trimmed), add);
      return;
    } catch {
      // Partial or malformed JSON; scan complete JSON string literals below.
    }
  }
  if (jsonShaped) {
    scanJsonStringLiterals(payload, add);
    return;
  }
  if (
    payloadComplete &&
    (trimmed.startsWith("http://") || trimmed.startsWith("https://")) &&
    !/\s/.test(trimmed)
  ) {
    if (!/["<>\\`{}^]/.test(trimmed)) add(trimmed);
    return;
  }
  scanJsonStringLiterals(payload, add);
  scanProseAddresses(payload, add, payloadComplete);
}

function isAsciiWhitespace(code: number): boolean {
  return code === 32 || code === 9 || code === 10 || code === 13 || code === 12;
}

function isUrlForbiddenChar(code: number): boolean {
  // `"`, `<`, `>`, `\`, `` ` ``, `{`, `}`, `^`
  return (
    code === 34 ||
    code === 60 ||
    code === 62 ||
    code === 92 ||
    code === 96 ||
    code === 123 ||
    code === 125 ||
    code === 94
  );
}

function skipToWhitespace(text: string, from: number): number {
  let index = from;
  while (index < text.length) {
    const code = text.charCodeAt(index);
    if (isAsciiWhitespace(code) || (code > 127 && /\s/.test(text[index] ?? ""))) break;
    index += 1;
  }
  return index;
}

function isValidProseUrlTerminator(
  prev: string,
  stopChar: string,
  nextChar: string,
  afterNextChar: string,
  stoppedAtWhitespace: boolean,
  complete: boolean,
  openParens: number,
  openBrackets: number,
): boolean {
  if (prev === '"') return stopChar === '"' || stoppedAtWhitespace;
  if (prev === "'") return stopChar === "'" || stoppedAtWhitespace;
  if (prev === "`") return stopChar === "`" || stoppedAtWhitespace;
  if (prev === "(") return openParens === 0 && (stopChar === ")" || stoppedAtWhitespace);
  if (prev === "[") return openBrackets === 0 && (stopChar === "]" || stoppedAtWhitespace);
  if (prev === "{") return stopChar === "}" || stoppedAtWhitespace;
  if (stopChar === "") return complete;
  if (stoppedAtWhitespace) return true;
  if (stopChar === ")" || stopChar === "]" || stopChar === "}") {
    if (openParens !== 0 || openBrackets !== 0) return false;
    if (nextChar === "" || /[\s)\]}"']/.test(nextChar)) return true;
    return /[.,;:!?]/.test(nextChar) && (afterNextChar === "" || /\s/.test(afterNextChar));
  }
  return false;
}

/**
 * Linear, balanced-delimiter URL scanner for Markdown, prose, and plain-text
 * payloads. Tracks nested `()` and `[]` so Markdown destinations such as
 * `[View](https://cdn.example/a(1)/b.png)` authorize only the full URL and
 * never an intermediate prefix ending before an inner `)` or `]`.
 */
function scanProseAddresses(
  text: string,
  add: (candidate: string) => void,
  complete: boolean,
): void {
  let index = 0;
  let nextHttp = text.indexOf("http://", 0);
  let nextHttps = text.indexOf("https://", 0);
  while (index < text.length) {
    if (nextHttp !== -1 && nextHttp < index) nextHttp = text.indexOf("http://", index);
    if (nextHttps !== -1 && nextHttps < index) nextHttps = text.indexOf("https://", index);
    const start =
      nextHttp === -1 ? nextHttps : nextHttps === -1 ? nextHttp : Math.min(nextHttp, nextHttps);
    if (start === -1) break;
    const schemeEnd = start + (start === nextHttps ? 8 : 7);
    const prev = start === 0 ? "" : (text[start - 1] ?? "");

    if (prev === "<") {
      const beforeAngle = start < 2 ? "" : (text[start - 2] ?? "");
      if (beforeAngle === "" || /\s/.test(beforeAngle) || beforeAngle === "(") {
        let end = schemeEnd;
        while (end < text.length) {
          const code = text.charCodeAt(end);
          if (code === 62) break;
          if (
            isAsciiWhitespace(code) ||
            (code > 127 && /\s/.test(text[end] ?? "")) ||
            isUrlForbiddenChar(code)
          ) {
            break;
          }
          end += 1;
        }
        if (end > schemeEnd && end < text.length && text.charCodeAt(end) === 62) {
          add(text.slice(start, end));
          index = end + 1;
          continue;
        }
        index = skipToWhitespace(text, end);
        continue;
      }
      index = schemeEnd;
      continue;
    }

    const validOpener =
      prev === "" ||
      /\s/.test(prev) ||
      prev === "(" ||
      prev === "[" ||
      prev === "{" ||
      prev === '"' ||
      prev === "'" ||
      prev === "`";
    if (!validOpener) {
      index = schemeEnd;
      continue;
    }

    const unwrapped = prev === "" || /\s/.test(prev);
    const trackParens = prev === "(" || unwrapped;
    const trackBrackets = prev === "[" || unwrapped;
    let end = schemeEnd;
    let openParens = 0;
    let openBrackets = 0;
    while (end < text.length) {
      const code = text.charCodeAt(end);
      if (isAsciiWhitespace(code) || (code > 127 && /\s/.test(text[end] ?? ""))) break;
      if (trackParens && code === 40) {
        openParens += 1;
        end += 1;
        continue;
      }
      if (trackParens && code === 41) {
        if (openParens > 0) {
          openParens -= 1;
          end += 1;
          continue;
        }
        break;
      }
      if (trackBrackets && code === 91) {
        openBrackets += 1;
        end += 1;
        continue;
      }
      if (trackBrackets && code === 93) {
        if (openBrackets > 0) {
          openBrackets -= 1;
          end += 1;
          continue;
        }
        break;
      }
      if (code === 39 && prev === "'") break;
      if (isUrlForbiddenChar(code)) break;
      end += 1;
    }

    const stopChar = end < text.length ? (text[end] ?? "") : "";
    const nextChar = end + 1 < text.length ? (text[end + 1] ?? "") : "";
    const afterNextChar = end + 2 < text.length ? (text[end + 2] ?? "") : "";
    const stoppedAtWhitespace = stopChar !== "" && /\s/.test(stopChar);
    if (
      end > schemeEnd &&
      isValidProseUrlTerminator(
        prev,
        stopChar,
        nextChar,
        afterNextChar,
        stoppedAtWhitespace,
        complete,
        openParens,
        openBrackets,
      )
    ) {
      add(text.slice(start, end));
      index = end < text.length ? end + 1 : end;
    } else if (stopChar !== "" && !stoppedAtWhitespace) {
      index = skipToWhitespace(text, end + 1);
    } else {
      index = end < text.length ? end + 1 : end;
    }
  }
}

/**
 * Linear, non-backtracking scanner for complete JSON string literals inside
 * partial JSON or mixed text. Oversized literals (such as inline base64
 * images) are skipped without `JSON.parse` or regex recursion.
 */
function scanJsonStringLiterals(text: string, add: (candidate: string) => void): void {
  const maxLiteralLength = MAX_RELAYED_ADDRESS_LENGTH * 6;
  let index = 0;
  while (index < text.length) {
    const start = text.indexOf('"', index);
    if (start === -1) break;
    let end = start + 1;
    let closed = false;
    while (end < text.length) {
      const code = text.charCodeAt(end);
      if (code === 92) {
        // Skip escaped character (`\`).
        end += 2;
        continue;
      }
      if (code === 34) {
        closed = true;
        break;
      }
      end += 1;
    }
    if (!closed) break;
    if (end - start <= maxLiteralLength) {
      try {
        const decoded: unknown = JSON.parse(text.slice(start, end + 1));
        if (typeof decoded === "string") collectJsonStringAddresses(decoded, add);
      } catch {
        // Non-JSON quoted text; ignore.
      }
    }
    index = end + 1;
  }
}

function collectJsonStringAddresses(text: string, add: (candidate: string) => void): void {
  // Treat any whitespace-free string starting with http(s):// as an atomic URL:
  // accept it only if it contains no forbidden characters, and never fall
  // through to prose-link scanning that could split on embedded quotes.
  if ((text.startsWith("http://") || text.startsWith("https://")) && !/\s/.test(text)) {
    if (!/["<>\\`{}^]/.test(text)) add(text);
    return;
  }
  scanProseAddresses(text, add, true);
}

function collectJsonAddresses(root: unknown, add: (candidate: string) => void): void {
  const stack: Array<unknown> = [root];
  while (stack.length > 0) {
    const value = stack.pop();
    if (typeof value === "string") {
      collectJsonStringAddresses(value, add);
      continue;
    }
    if (Array.isArray(value)) {
      for (const item of value) stack.push(item);
      continue;
    }
    if (value !== null && typeof value === "object") {
      for (const [key, entry] of Object.entries(value)) {
        collectJsonStringAddresses(key, add);
        stack.push(entry);
      }
    }
  }
}

/**
 * Where the host fetches an image the driver names: HTTPS on the default
 * port, as provider image stores answer, or the configured origin itself.
 * Never another scheme, a credential in the address, or a loopback address
 * the person did not configure.
 */
function isFetchableImageAddress(url: string, origin: string | undefined): boolean {
  let target: URL;
  try {
    target = new URL(url);
  } catch {
    return false;
  }
  if (target.username !== "" || target.password !== "") return false;
  if (origin !== undefined && `${target.protocol}//${target.host}` === origin) return true;
  return target.protocol === "https:" && target.port === "" && !isLoopbackOrPrivate(target);
}

/** A literal address the internet does not route to, or a `localhost` name. */
function isLoopbackOrPrivate(target: URL): boolean {
  const host = target.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  return parseNetworkAddress(host) !== undefined && !isPublicNetworkAddress(host);
}
