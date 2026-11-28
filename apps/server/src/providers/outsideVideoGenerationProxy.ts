import type {
  OutsideDriverKeyPlacement,
  ProviderFailure,
  ProviderFailureCategory,
  ProviderInstanceId,
  ProviderModelId,
} from "@octant/contracts";
import {
  decodeOutsideDriverInitializeResult,
  decodeOutsideDriverVideoForgetResult,
  decodeOutsideDriverVideoPollResult,
  decodeOutsideDriverVideoStartResult,
  HOST_VIDEO_GENERATION_PROTOCOL_VERSIONS,
  OUTSIDE_DRIVER_MAX_REFERENCE_IMAGES_BYTES,
  OUTSIDE_DRIVER_METHODS,
  type OutsideDriverVideoPollResult,
  type OutsideDriverVideoStartParams,
  type OutsideDriverVideoUsage,
} from "@octant/contracts/outside-driver-protocol";
import type { ImageAdapterReference } from "@octant/provider-sdk/image-generation";
import {
  isVideoStartRejection,
  type VideoAdapterForget,
  type VideoAdapterPoll,
  type VideoAdapterRequest,
  type VideoAdapterStart,
  type VideoAdapterUsage,
  type VideoGenerationPorts,
} from "@octant/provider-sdk/video-generation";
import type { ProviderCredentialResolver } from "./credentialBrokerClient";
import {
  makeOutsideDriverBroker,
  OUTSIDE_DRIVER_DEFAULT_LIMITS,
  OUTSIDE_DRIVER_FAILURE_MESSAGES,
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
import {
  extractReturnedAddresses,
  isFetchableProviderAddress,
  resolveAddresses,
  resolvesPublicly,
} from "./outsideImageGenerationProxy";

/**
 * The host side of an outside video driver: the video seam's job calls
 * crossing the same line-delimited channel, brokered `http/request` and closed
 * failures as the other outside families, so the video job service runs it as
 * it runs a bundled driver. Models and prices are not here: they are the
 * package's declaration, which the caller answers without any process.
 *
 * The driver is untrusted, and a video can cost real money, so what may have
 * been billed is decided from what the host saw leave and come back, never
 * from what the driver says about it:
 * - only a start may send a request that could start a clip, and only one that
 *   was not refused outright; a check only reads, and a stop or a removal sends
 *   one `PUT` or `DELETE`;
 * - a start that failed after a request left, with no answer that rules a job
 *   out, is reported as one that may have started, so the estimate is counted;
 * - a clip the provider accepted whose end the driver cannot state properly
 *   ends as billed;
 * - a driver names counts, never amounts.
 */

export type OutsideVideoClipPorts = Pick<
  VideoGenerationPorts,
  "fetchApprovedVideoUrl" | "sniffMediaType"
>;

/** Tells the job service which starts reached the host's port, and which left the host. */
export interface OutsideVideoSends {
  readonly reached: (signal: AbortSignal) => void;
  readonly sent: (signal: AbortSignal) => void;
}

export interface OutsideVideoGenerationProxyOptions {
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

const SAFETY_REFUSAL = "The video provider declined this request.";

/** A status check that failed this way says nothing about the clip, so it is tried again. */
const UNCONFIRMED: ReadonlySet<ProviderFailureCategory> = new Set<ProviderFailureCategory>([
  "unavailable",
  "rate-limited",
  "unauthenticated",
  "unauthorized",
]);

const clipInvalid = () =>
  outsideDriverFailure("protocol", "The video driver returned a clip Octant could not accept.");
const addressNotReturned = () =>
  outsideDriverFailure(
    "protocol",
    "The video driver named a clip address the provider did not return.",
  );

function usageOf(usage: OutsideDriverVideoUsage | undefined): {
  readonly usage?: VideoAdapterUsage;
} {
  if (usage === undefined) return {};
  return {
    usage: {
      ...(usage.inputTokens === undefined ? {} : { inputTokens: usage.inputTokens }),
      ...(usage.outputTokens === undefined ? {} : { outputTokens: usage.outputTokens }),
      ...(usage.billedSeconds === undefined ? {} : { billedSeconds: usage.billedSeconds }),
    },
  };
}

/**
 * Whether an answer proves the provider started no clip: it refused the
 * request outright. A 408 is the provider giving up waiting, which says
 * nothing, and a server error or a redirect may have come after a job began.
 */
function rulesOutStart(response: Response): boolean {
  if (isVideoStartRejection(response)) return true;
  return response.status >= 400 && response.status < 500 && response.status !== 408;
}

const readsOnly = (method: string) => method === "GET";

/** Reads, and one request of the named methods: a stop or a removal, never a start. */
function readsAndOneOf(methods: ReadonlyArray<string>): (method: string) => boolean {
  let used = false;
  return (method) => {
    if (method === "GET") return true;
    if (used || !methods.includes(method)) return false;
    used = true;
    return true;
  };
}

function wireImage(image: ImageAdapterReference) {
  return { mediaType: image.mediaType, data: Buffer.from(image.bytes).toString("base64") };
}

export function makeOutsideVideoGenerationProxy(options: OutsideVideoGenerationProxyOptions) {
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
    ownedRequestsOnly: true,
  });

  const stopped = (): ProviderFailure => {
    link.stop(outsideDriverStopped());
    return link.stopped ?? outsideDriverStopped();
  };

  /** Reads a result the driver wrote; one that does not decode stops it. */
  const read = <A>(
    decoded: { readonly _tag: "Failure" } | { readonly _tag: "Success"; readonly success: A },
  ): A => {
    if (decoded._tag === "Success") return decoded.success;
    throw stopped();
  };

  const initialize = async () => {
    const { settled } = link.call(
      OUTSIDE_DRIVER_METHODS.initialize,
      {
        protocolVersions: HOST_VIDEO_GENERATION_PROTOCOL_VERSIONS,
        configuration: { baseUrl: options.baseUrl, modelIds: options.modelIds },
      },
      { timeoutMs: limits.callTimeoutMs },
    );
    const agreed = read(decodeOutsideDriverInitializeResult(await settled));
    if (!HOST_VIDEO_GENERATION_PROTOCOL_VERSIONS.includes(agreed.protocolVersion)) {
      link.stop(outsideDriverNoAgreedProtocol());
      throw link.stopped ?? outsideDriverNoAgreedProtocol();
    }
    // Cloud sessions belong to the harness endpoint family alone.
    if (agreed.cloudSessions !== undefined) throw stopped();
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

  /** One host call that the caller's signal can end at once. */
  const callWithin = async (
    method: string,
    params: unknown,
    signal: AbortSignal | undefined,
    callOptions: Parameters<typeof link.call>[2],
  ): Promise<unknown> => {
    await ensureInitialized();
    if (signal?.aborted === true) {
      throw outsideDriverFailure("interrupted", "The provider request was cancelled.");
    }
    const call = link.call(method, params, { closeBrokeredOnSettle: true, ...callOptions });
    const cancel = () => link.cancel(call.id);
    signal?.addEventListener("abort", cancel, { once: true });
    try {
      return await call.settled;
    } finally {
      signal?.removeEventListener("abort", cancel);
    }
  };

  const start = async (
    request: VideoAdapterRequest,
    sends: OutsideVideoSends,
  ): Promise<VideoAdapterStart> => {
    sends.reached(request.signal);
    // Requests that could start a clip: the ones let through, the ones handed
    // to the network, and the ones the provider refused outright. A GET cannot
    // start one.
    let admitted = 0;
    let sent = 0;
    let refusedOutright = 0;
    const mayHaveStarted = () => sent > refusedOutright;
    const failed = (failure: ProviderFailure): VideoAdapterStart =>
      mayHaveStarted()
        ? {
            status: "failed",
            // "unavailable" is how the job service reads a start whose outcome
            // is unknown; a driver's own category must not turn one into a
            // start that was never billed.
            providerFailure: outsideDriverFailure("unavailable", failure.message),
          }
        : { status: "failed", providerFailure: failure, notStarted: true };
    try {
      const images = [
        ...(request.firstFrame === undefined ? [] : [request.firstFrame]),
        ...(request.lastFrame === undefined ? [] : [request.lastFrame]),
        ...request.references,
      ];
      const imageBytes = images.reduce((sum, image) => sum + image.bytes.byteLength, 0);
      if (imageBytes > OUTSIDE_DRIVER_MAX_REFERENCE_IMAGES_BYTES) {
        throw outsideDriverFailure(
          "invalid-configuration",
          "Images for an outside video driver cannot exceed 2.5 MiB combined.",
        );
      }
      const params: OutsideDriverVideoStartParams = {
        modelId: request.modelId,
        prompt: request.prompt,
        options: request.options,
        ...(request.firstFrame === undefined ? {} : { firstFrame: wireImage(request.firstFrame) }),
        ...(request.lastFrame === undefined ? {} : { lastFrame: wireImage(request.lastFrame) }),
        references: request.references.map(wireImage),
      };
      const result = read(
        decodeOutsideDriverVideoStartResult(
          await callWithin(OUTSIDE_DRIVER_METHODS.videoStart, params, request.signal, {
            timeoutMs: limits.sendTimeoutMs,
            // One reservation covers one clip, so a second request that could
            // start one is let through only after the first was refused.
            admitsRequest: (method) => {
              if (method === "GET") return true;
              if (method !== "POST" || admitted > refusedOutright) return false;
              admitted += 1;
              return true;
            },
            observer: {
              sent: (method) => {
                if (method === "GET") return;
                sent += 1;
                sends.sent(request.signal);
              },
              answered: (method, response) => {
                if (method !== "GET" && rulesOutStart(response)) refusedOutright += 1;
              },
            },
          }),
        ),
      );
      if (result.status === "started") return { status: "started", remoteId: result.remoteId };
      // A refusal the provider gave by rejecting the request cost nothing. One
      // that came back as an accepted answer may have been billed, and only
      // the driver says it was a refusal.
      if (!mayHaveStarted()) return { status: "refused", safetyRefusal: SAFETY_REFUSAL };
      return failed(outsideDriverFailure("unavailable", SAFETY_REFUSAL));
    } catch (error) {
      return failed(outsideDriverClosedFailure(error));
    }
  };

  /** The host's own download of a finished clip, or the failure that ends the job. */
  const collect = async (
    result: Extract<OutsideDriverVideoPollResult, { readonly status: "completed" }>,
    hasReturnedAddress: (url: string) => boolean,
    signal: AbortSignal | undefined,
    ports: OutsideVideoClipPorts,
  ): Promise<VideoAdapterPoll> => {
    const usage = usageOf(result.usage);
    const unusable = (providerFailure: ProviderFailure): VideoAdapterPoll => ({
      status: "failed",
      providerFailure,
      billed: true,
      ...usage,
    });
    if (!isFetchableProviderAddress(result.url, origin) || !hasReturnedAddress(result.url)) {
      return unusable(addressNotReturned());
    }
    if (!(await resolvesPublicly(result.url, origin, options.resolve ?? resolveAddresses))) {
      return unusable(
        outsideDriverFailure("protocol", "The video driver named a clip on a private network."),
      );
    }
    const fetched = await ports.fetchApprovedVideoUrl({
      url: result.url,
      ...(signal === undefined ? {} : { signal }),
    });
    if ("failure" in fetched) {
      const { category } = fetched.failure;
      const failure = outsideDriverFailure(category, "The finished clip could not be downloaded.");
      // A download that broke off, or that Stop or the deadline cut short, is
      // tried again by the next status check.
      return category === "unavailable" || category === "interrupted"
        ? { status: "failed", providerFailure: failure }
        : unusable(failure);
    }
    const mediaType = ports.sniffMediaType(fetched.bytes);
    if (mediaType === undefined) return unusable(clipInvalid());
    return { status: "completed", video: { bytes: fetched.bytes, mediaType }, ...usage };
  };

  /** A status check or a stop: the same answer, read the same way. */
  const jobState = async (
    method: string,
    remoteId: string,
    signal: AbortSignal | undefined,
    ports: OutsideVideoClipPorts,
    admitsRequest: (method: string) => boolean,
  ): Promise<VideoAdapterPoll> => {
    const inFlight = new Map<number, Array<string>>();
    const returned = new Set<string>();
    const hasReturnedAddress = (url: string) => {
      for (const parts of inFlight.values()) {
        extractReturnedAddresses(parts.join(""), returned, false);
      }
      return returned.has(url);
    };
    try {
      const result = read(
        decodeOutsideDriverVideoPollResult(
          await callWithin(method, { remoteId }, signal, {
            timeoutMs: limits.callTimeoutMs,
            admitsRequest,
            onRelayedResponseChunk: (httpId, text) => {
              const parts = inFlight.get(httpId);
              if (parts === undefined) inFlight.set(httpId, [text]);
              else parts.push(text);
            },
            onRelayedResponseEnd: (httpId, completedNormally) => {
              const parts = inFlight.get(httpId);
              if (parts === undefined) return;
              inFlight.delete(httpId);
              extractReturnedAddresses(parts.join(""), returned, completedNormally);
            },
          }),
        ),
      );
      switch (result.status) {
        case "running":
          return { status: "running" };
        case "completed":
          return await collect(result, hasReturnedAddress, signal, ports);
        case "refused":
          return {
            status: "refused",
            safetyRefusal: SAFETY_REFUSAL,
            ...(result.billed === true ? { billed: true } : {}),
            ...usageOf(result.usage),
          };
        case "failed":
          return {
            status: "failed",
            providerFailure: outsideDriverFailure(
              result.category,
              OUTSIDE_DRIVER_FAILURE_MESSAGES[result.category],
            ),
            ...(result.billed === true ? { billed: true } : {}),
            ...usageOf(result.usage),
          };
        case "cancelled":
          return { status: "cancelled", ...usageOf(result.usage) };
      }
    } catch (error) {
      const providerFailure = outsideDriverClosedFailure(error);
      // The provider accepted this clip. A check the host itself ended, or one
      // that says nothing about the clip, is tried again; a driver that
      // answered unreadably can no longer say how the clip ended, so the clip
      // is counted.
      const unconfirmed = signal?.aborted === true || UNCONFIRMED.has(providerFailure.category);
      return { status: "failed", providerFailure, ...(unconfirmed ? {} : { billed: true }) };
    } finally {
      inFlight.clear();
    }
  };

  return {
    start,
    poll: (remoteId: string, signal: AbortSignal, ports: OutsideVideoClipPorts) =>
      jobState(OUTSIDE_DRIVER_METHODS.videoPoll, remoteId, signal, ports, readsOnly),
    cancel: (remoteId: string, signal: AbortSignal | undefined, ports: OutsideVideoClipPorts) =>
      jobState(
        OUTSIDE_DRIVER_METHODS.videoCancel,
        remoteId,
        signal,
        ports,
        readsAndOneOf(["PUT", "DELETE"]),
      ),
    forget: async (remoteId: string): Promise<VideoAdapterForget> => {
      try {
        read(
          decodeOutsideDriverVideoForgetResult(
            await callWithin(OUTSIDE_DRIVER_METHODS.videoForget, { remoteId }, undefined, {
              timeoutMs: limits.callTimeoutMs,
              admitsRequest: readsAndOneOf(["DELETE"]),
            }),
          ),
        );
        return { status: "removed" };
      } catch (error) {
        return { status: "failed", providerFailure: outsideDriverClosedFailure(error) };
      }
    },
  };
}
