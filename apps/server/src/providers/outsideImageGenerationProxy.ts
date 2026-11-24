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
 * The most `image/chunk` notifications one image may stream. Bounds per-chunk
 * allocation overhead so a driver cannot exhaust host memory by sending
 * millions of four-character chunks within the byte ceiling.
 */
const MAX_CHUNKS_PER_IMAGE = 1_024;

interface StreamedImageChunks {
  readonly buffers: Array<Buffer>;
  bytes: number;
  ended: boolean;
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
    relayed: ReadonlyArray<string>,
    streamed: StreamedImageChunks | undefined,
    signal: AbortSignal | undefined,
    ports: OutsideImageJobPorts,
  ): Promise<ImageAdapterImage> => {
    let bytes: Uint8Array;
    let named: ImageArtifactMediaType | undefined;
    if ("data" in image) {
      bytes = Uint8Array.from(Buffer.from(image.data, "base64"));
      named = image.mediaType;
    } else if ("chunked" in image) {
      if (streamed === undefined || streamed.buffers.length === 0) throw imageInvalid();
      bytes = Uint8Array.from(Buffer.concat(streamed.buffers, streamed.bytes));
      named = image.mediaType;
    } else {
      if (
        !isFetchableImageAddress(image.url, origin) ||
        !returnedAddresses(relayed).has(image.url)
      ) {
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
    // Chunks are decoded on arrival and bounded by both chunk count and decoded
    // bytes per image, so a driver cannot amplify host memory with tiny chunks.
    const chunks = new Map<number, StreamedImageChunks>();
    let oversized = false;
    const call = link.call(OUTSIDE_DRIVER_METHODS.imageGenerate, params, {
      timeoutMs: limits.sendTimeoutMs,
      keepRelayed: true,
      onProviderResponse,
      onImageChunk: (image, data) => {
        if (oversized) return;
        const state = chunks.get(image) ?? { buffers: [], bytes: 0, ended: false };
        if (image >= variantCount || state.ended || state.buffers.length >= MAX_CHUNKS_PER_IMAGE) {
          oversized = true;
          chunks.clear();
          link.cancel(call.id);
          return;
        }
        const piece = Buffer.from(data, "base64");
        if (state.bytes + piece.byteLength > MAX_GENERATED_IMAGE_BYTES) {
          oversized = true;
          chunks.clear();
          link.cancel(call.id);
          return;
        }
        state.buffers.push(piece);
        state.bytes += piece.byteLength;
        state.ended = data.includes("=");
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
        images.push(await accept(image, call.relayed, chunks.get(index), request.signal, ports));
      }
      return { status: "completed", images };
    } finally {
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
 * Every complete address the provider's relayed answers contain, as whole
 * tokens. JSON responses are parsed so exact decoded string values stay intact
 * (including valid URL characters like apostrophes); non-JSON responses fall
 * back to whole-token URL scanning. The driver's address must equal one of
 * them, so a prefix or a longer address that merely contains it
 * (`https://images.example.test.attacker.invalid/…`) authorizes nothing.
 */
function returnedAddresses(relayed: ReadonlyArray<string>): ReadonlySet<string> {
  const addresses = new Set<string>();
  for (const responseText of relayed) {
    const trimmed = responseText.trim();
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      try {
        collectJsonAddresses(JSON.parse(trimmed), addresses);
        continue;
      } catch {
        // Non-JSON or multi-document body (e.g. NDJSON/SSE); scan tokens below.
      }
    }
    // Plain-text or framed responses may still carry JSON-escaped `/` or `\uXXXX`.
    const text = responseText
      .replace(/\\u([0-9a-fA-F]{4})/g, (_escape, hex: string) =>
        String.fromCharCode(Number.parseInt(hex, 16)),
      )
      .replaceAll("\\/", "/");
    for (const match of text.match(/https?:\/\/[^\s"'<>\\`{}|^]+/g) ?? []) {
      addresses.add(match);
    }
  }
  return addresses;
}

function collectJsonAddresses(root: unknown, out: Set<string>): void {
  const stack: Array<unknown> = [root];
  while (stack.length > 0) {
    const value = stack.pop();
    if (typeof value === "string") {
      if (value.startsWith("http://") || value.startsWith("https://")) out.add(value);
      continue;
    }
    if (Array.isArray(value)) {
      for (const item of value) stack.push(item);
      continue;
    }
    if (value !== null && typeof value === "object") {
      for (const entry of Object.values(value)) stack.push(entry);
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
