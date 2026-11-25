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
 * parsed so exact decoded keys and values stay intact (including apostrophes,
 * pipes, and delimited links like `<https://...>`), while non-JSON or partial
 * streaming responses scan only complete delimited tokens so a truncated
 * chunk cannot authorize a URL prefix and an embedded query parameter cannot
 * authorize an inner URL.
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
        // Non-JSON or multi-document body (e.g. SSE); scan delimited tokens below.
      }
    }
  }
  const text = responseText
    .replace(/\\u([0-9a-fA-F]{4})/g, (_escape, hex: string) =>
      String.fromCharCode(Number.parseInt(hex, 16)),
    )
    .replaceAll("\\/", "/");
  // Complete double-quoted strings (e.g. JSON inside SSE chunks) may contain
  // apostrophes or pipes; requiring both unescaped quotes ensures truncated
  // chunks never match a partial URL.
  for (const match of text.matchAll(/(?<!\\)"(https?:\/\/[^"\\\s<>`{}^]+)(?<!\\)"/g)) {
    if (match[1] !== undefined) add(match[1]);
  }
  for (const match of text.matchAll(/(?:^|\s)<(https?:\/\/[^\s"<>\\`{}^]+)>/g)) {
    if (match[1] !== undefined) add(match[1]);
  }
  const bare = complete
    ? /(?:^|[\s(\[{])(https?:\/\/[^\s"<>\\`{}^)\]}]+)(?=$|[\s"<>\\`{}^)\]}])/g
    : /(?:^|[\s(\[{])(https?:\/\/[^\s"<>\\`{}^)\]}]+)(?=[\s"<>\\`{}^)\]}])/g;
  for (const match of text.matchAll(bare)) {
    if (match[1] !== undefined) add(match[1]);
  }
}

function collectJsonStringAddresses(text: string, add: (candidate: string) => void): void {
  if ((text.startsWith("http://") || text.startsWith("https://")) && !/[\s"<>\\`{}^]/.test(text)) {
    add(text);
    return;
  }
  for (const match of text.matchAll(/(?:^|\s)<(https?:\/\/[^\s"<>\\`{}^]+)>/g)) {
    if (match[1] !== undefined) add(match[1]);
  }
  for (const match of text.matchAll(
    /(?:^|[\s"(\[{])(https?:\/\/[^\s"<>\\`{}^)\]}]+)(?=$|[\s"<>\\`{}^)\]}])/g,
  )) {
    if (match[1] !== undefined) add(match[1]);
  }
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
