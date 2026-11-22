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
  ImageGenerationAdapter,
  ImageGenerationPorts,
} from "@octant/provider-sdk/image-generation";
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

export interface OutsideImageGenerationProxyOptions {
  readonly instanceId: ProviderInstanceId;
  readonly channel: OutsideDriverChannel;
  /** The address the person configured; a brokered request reaches only its origin. */
  readonly baseUrl: string;
  readonly key: OutsideDriverKeyPlacement | undefined;
  /** The models the person listed, each one the package declares. */
  readonly modelIds: ReadonlyArray<ProviderModelId>;
  /** The host's own image fetch and sniffing, as every image driver receives them. */
  readonly ports: Pick<ImageGenerationPorts, "fetchApprovedImageUrl" | "sniffMediaType">;
  readonly credentialResolver?: ProviderCredentialResolver;
  readonly fetch?: OutsideDriverFetch;
  readonly limits?: Partial<OutsideDriverLimits>;
  /** Called once when the driver is stopped, with the closed reason. */
  readonly onStopped?: (failure: ProviderFailure) => void;
}

const SAFETY_REFUSAL = "The image provider declined this request.";

const imageInvalid = () =>
  outsideDriverFailure("protocol", "The image driver returned an image Octant could not accept.");
const tooManyImages = () =>
  outsideDriverFailure("protocol", "The provider returned more images than requested.");

export function makeOutsideImageGenerationProxy(
  options: OutsideImageGenerationProxyOptions,
): ImageGenerationAdapter {
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
    signal: AbortSignal | undefined,
  ): Promise<ImageAdapterImage> => {
    let bytes: Uint8Array;
    let named: ImageArtifactMediaType | undefined;
    if ("data" in image) {
      bytes = Uint8Array.from(Buffer.from(image.data, "base64"));
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
      const fetched = await options.ports.fetchApprovedImageUrl({
        url: image.url,
        ...(signal === undefined ? {} : { signal }),
      });
      if ("failure" in fetched) {
        throw outsideDriverFailure(fetched.failure.category, fetched.failure.message);
      }
      bytes = fetched.bytes;
    }
    const sniffed = options.ports.sniffMediaType(bytes);
    if (sniffed === undefined || (named !== undefined && named !== sniffed)) throw imageInvalid();
    return { bytes, mediaType: sniffed };
  };

  const generate = async (request: ImageAdapterRequest): Promise<ImageAdapterResult> => {
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
    const call = link.call(OUTSIDE_DRIVER_METHODS.imageGenerate, params, {
      timeoutMs: limits.sendTimeoutMs,
      keepRelayed: true,
    });
    const cancel = () => link.cancel(call.id);
    request.signal?.addEventListener("abort", cancel, { once: true });
    try {
      const decoded = decodeOutsideDriverImageGenerateResult(await call.settled);
      if (decoded._tag === "Left") throw stopped();
      const result = decoded.right;
      if (result.status === "refused") return { status: "refused", safetyRefusal: SAFETY_REFUSAL };
      if (result.images.length > variantCount) throw tooManyImages();
      const images: Array<ImageAdapterImage> = [];
      for (const image of result.images) {
        images.push(await accept(image, call.relayed, request.signal));
      }
      return { status: "completed", images };
    } finally {
      request.signal?.removeEventListener("abort", cancel);
    }
  };

  return {
    // `generate` never rejects: a broken driver ends as a recorded failure.
    generate: async (request) => {
      try {
        return await generate(request);
      } catch (error) {
        return { status: "failed", providerFailure: outsideDriverClosedFailure(error) };
      }
    },
  };
}

/**
 * Every complete address the provider's relayed answers contain, as whole
 * tokens: a JSON string's `\/` escapes undone, and each address ending at the
 * first character an address cannot hold unescaped. The driver's address must
 * equal one of them, so a prefix or a longer address that merely contains it
 * (`https://images.example.test.attacker.invalid/…`) authorizes nothing.
 */
function returnedAddresses(relayed: ReadonlyArray<string>): ReadonlySet<string> {
  const text = relayed.join("").replaceAll("\\/", "/");
  return new Set(text.match(/https?:\/\/[^\s"'<>\\`{}|^]+/g) ?? []);
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
