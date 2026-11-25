import { decodeProviderFailure, type ProviderFailureCategory } from "@octant/contracts";
import {
  decodeVideoModelCapabilities,
  type VideoModelCapabilities,
} from "@octant/contracts/video-generation";
import {
  isVideoEndpointAllowed,
  videoFailure,
  type VideoAdapterForget,
  type VideoAdapterPoll,
  type VideoAdapterRequest,
  type VideoAdapterStart,
  type VideoGenerationAdapter,
  type VideoGenerationDriver,
  type VideoGenerationPorts,
  type VideoGenerationProfile,
  type VideoHttpRequest,
} from "./videoGeneration";

export interface VideoGenerationConformanceFixture {
  readonly driver: VideoGenerationDriver;
  readonly profile: VideoGenerationProfile;
  /** A request the profile accepts. The harness supplies its own signal. */
  readonly request: Omit<VideoAdapterRequest, "signal">;
  /**
   * Answers each provider call of one successful generation, polls, cancel
   * and delete included. Called with a fresh script for every scenario.
   */
  readonly respond: () => (request: VideoHttpRequest) => Response;
  /** What the approved-URL port returns when the adapter downloads a clip. */
  readonly approvedVideoBytes?: Uint8Array;
}

export interface VideoGenerationConformanceEvidence {
  readonly declaredModelsDecode: true;
  readonly discoveryStopsWhenCancelled: true;
  readonly cancelledBeforeAnyCall: true;
  readonly emptyPromptRefusedBeforeAnyCall: true;
  readonly outsideDeclarationRefusedBeforeAnyCall: true;
  readonly unreachableProviderClassified: true;
  readonly unexpectedErrorContained: true;
  readonly completedWithHostMediaType: true;
  readonly hostMediaRefusalHonored: true;
  readonly calledOnlyDeclaredEndpoints: true;
  readonly cancelAndForgetResolve: true;
}

/** The smallest MP4 the host's check accepts: a `ftyp` box. */
export const CONFORMANCE_MP4_BYTES = new Uint8Array([
  0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 0, 0, 0, 0, 0x69, 0x73, 0x6f, 0x6d,
  0x6d, 0x70, 0x34, 0x32,
]);

/** Whether bytes start with an MP4 `ftyp` box, as the host's own check does. */
export function looksLikeMp4(bytes: Uint8Array): boolean {
  return (
    bytes.length >= 12 &&
    bytes[4] === 0x66 &&
    bytes[5] === 0x74 &&
    bytes[6] === 0x79 &&
    bytes[7] === 0x70
  );
}

const MAX_CONFORMANCE_POLLS = 20;
/** How long a cancelled discovery may take to end. */
const CANCELLED_DISCOVERY_MS = 1_000;

interface RecordingPorts {
  readonly ports: VideoGenerationPorts;
  readonly calls: () => number;
  readonly urls: () => ReadonlyArray<string>;
}

function recordingPorts(options: {
  readonly request: VideoGenerationPorts["request"];
  readonly approvedVideoBytes: Uint8Array;
  readonly sniff: VideoGenerationPorts["sniffMediaType"];
}): RecordingPorts {
  let calls = 0;
  const urls: Array<string> = [];
  return {
    ports: {
      request: async (request) => {
        calls += 1;
        urls.push(request.url);
        return options.request(request);
      },
      fetchApprovedVideoUrl: async () => {
        calls += 1;
        return { bytes: options.approvedVideoBytes };
      },
      sniffMediaType: options.sniff,
    },
    calls: () => calls,
    urls: () => urls,
  };
}

const sniffMp4 = (bytes: Uint8Array): "video/mp4" | undefined =>
  looksLikeMp4(bytes) ? "video/mp4" : undefined;

function assertConformance(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(`Video generation conformance failed: ${message}`);
}

async function contained<T>(name: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch {
    throw new Error(`Video generation conformance failed: ${name} rejected instead of failing`);
  }
}

function failureCategory(
  result: VideoAdapterStart | VideoAdapterPoll | VideoAdapterForget,
): ProviderFailureCategory | undefined {
  if (result.status !== "failed") return undefined;
  try {
    return decodeProviderFailure(result.providerFailure).category;
  } catch {
    return undefined;
  }
}

async function runToEnd(
  adapter: VideoGenerationAdapter,
  request: VideoAdapterRequest,
): Promise<{ readonly start: VideoAdapterStart; readonly end?: VideoAdapterPoll }> {
  const start = await contained("start", () => adapter.start(request));
  if (start.status !== "started") return { start };
  for (let poll = 0; poll < MAX_CONFORMANCE_POLLS; poll += 1) {
    const result = await contained("poll", () =>
      adapter.poll(start.remoteId, new AbortController().signal),
    );
    if (result.status !== "running") return { start, end: result };
  }
  return { start };
}

function outsideDeclaration(
  models: ReadonlyArray<VideoModelCapabilities>,
  request: Omit<VideoAdapterRequest, "signal">,
): Omit<VideoAdapterRequest, "signal"> {
  const model = models.find((candidate) => String(candidate.modelId) === String(request.modelId));
  const longest =
    model === undefined
      ? 0
      : model.durations.kind === "range"
        ? model.durations.max
        : Math.max(...model.durations.values);
  return { ...request, options: { ...request.options, durationSeconds: longest + 1 } };
}

/**
 * Proves a video driver keeps the seam's promises with ports the harness
 * controls: its declared models decode; a discovery that reads them from the
 * provider ends when it is cancelled; it stops before calling out when
 * cancelled, given an empty prompt, or asked for an option its model does not
 * declare; it records an unreachable provider and an unexpected error as
 * failures; it returns only bytes the host's MP4 check accepted; it calls only
 * the hosts it declares; and its cancel and forget resolve rather than reject.
 */
export async function runVideoGenerationConformance(
  fixture: VideoGenerationConformanceFixture,
): Promise<VideoGenerationConformanceEvidence> {
  const approvedVideoBytes = fixture.approvedVideoBytes ?? CONFORMANCE_MP4_BYTES;
  const scripted = (sniff: VideoGenerationPorts["sniffMediaType"] = sniffMp4) => {
    const respond = fixture.respond();
    return recordingPorts({
      request: async (request) => respond(request),
      approvedVideoBytes,
      sniff,
    });
  };
  const build = (ports: VideoGenerationPorts) =>
    fixture.driver.create({ profile: fixture.profile, ports });

  const declaring = scripted();
  const models = await contained("models", () => build(declaring.ports).models());
  assertConformance(models.length > 0, "the profile declared no models");
  for (const model of models) {
    try {
      decodeVideoModelCapabilities(model);
    } catch {
      throw new Error(
        `Video generation conformance failed: ${String(model.modelId)} declares capabilities the contract refuses`,
      );
    }
  }
  assertConformance(
    models.some((model) => String(model.modelId) === String(fixture.request.modelId)),
    "the fixture's model is not one the profile declares",
  );

  // A catalog the driver declares itself asks for nothing, so there is nothing to cancel.
  const discovery = new AbortController();
  const asked = Promise.withResolvers<void>();
  const stalled = recordingPorts({
    request: (request) => {
      asked.resolve();
      return new Promise((_resolve, reject) => {
        const stop = () => reject(videoFailure("interrupted", "The read was cancelled."));
        if (request.signal?.aborted === true) stop();
        else request.signal?.addEventListener("abort", stop, { once: true });
      });
    },
    approvedVideoBytes,
    sniff: sniffMp4,
  });
  const discovered = build(stalled.ports)
    .models(discovery.signal)
    .then(
      () => true,
      () => true,
    );
  await Promise.race([discovered, asked.promise]);
  discovery.abort();
  const asking = stalled.calls();
  const ended = await Promise.race([
    discovered,
    new Promise<false>((resolve) => setTimeout(() => resolve(false), CANCELLED_DISCOVERY_MS)),
  ]);
  assertConformance(ended, "a cancelled discovery did not end");
  assertConformance(
    stalled.calls() === asking,
    "a cancelled discovery made another call to the provider",
  );

  // The host always reads a profile's models before it starts a job, and a
  // driver that learns its models from the provider (an aggregator reading
  // each endpoint's schema and price) makes those reads then. The promise
  // checked below is that start itself sends nothing for a refused request,
  // so calls are counted from after the models are read.
  const adapterWithModels = async (ports: VideoGenerationPorts) => {
    const adapter = build(ports);
    await contained("models", () => adapter.models());
    return adapter;
  };

  const cancelled = scripted();
  const controller = new AbortController();
  controller.abort();
  const cancelledAdapter = await adapterWithModels(cancelled.ports);
  const cancelledBefore = cancelled.calls();
  const cancelledStart = await contained("start", () =>
    cancelledAdapter.start({ ...fixture.request, signal: controller.signal }),
  );
  assertConformance(
    failureCategory(cancelledStart) === "interrupted",
    "a cancelled request did not fail as interrupted",
  );
  assertConformance(
    cancelled.calls() === cancelledBefore,
    "a cancelled request still called the provider",
  );

  const empty = scripted();
  const emptyAdapter = await adapterWithModels(empty.ports);
  const emptyBefore = empty.calls();
  const emptyStart = await contained("start", () =>
    emptyAdapter.start({
      ...fixture.request,
      prompt: "   ",
      signal: new AbortController().signal,
    }),
  );
  assertConformance(
    failureCategory(emptyStart) === "invalid-configuration",
    "an empty prompt did not fail as invalid configuration",
  );
  assertConformance(empty.calls() === emptyBefore, "an empty prompt still called the provider");

  const outside = scripted();
  const outsideAdapter = await adapterWithModels(outside.ports);
  const outsideBefore = outside.calls();
  const outsideStart = await contained("start", () =>
    outsideAdapter.start({
      ...outsideDeclaration(models, fixture.request),
      signal: new AbortController().signal,
    }),
  );
  assertConformance(
    failureCategory(outsideStart) === "invalid-configuration",
    "a request outside the declared capabilities did not fail as invalid configuration",
  );
  assertConformance(
    outside.calls() === outsideBefore,
    "a request outside the declared capabilities still called the provider",
  );

  const unreachable = recordingPorts({
    request: async () => {
      throw videoFailure("unavailable", "The provider endpoint could not be reached.");
    },
    approvedVideoBytes,
    sniff: sniffMp4,
  });
  const unreachableStart = await contained("start", () =>
    build(unreachable.ports).start({ ...fixture.request, signal: new AbortController().signal }),
  );
  assertConformance(
    failureCategory(unreachableStart) === "unavailable",
    "an unreachable provider was not recorded as unavailable",
  );

  const broken = recordingPorts({
    request: async () => {
      throw new Error("unexpected transport error with private detail");
    },
    approvedVideoBytes,
    sniff: sniffMp4,
  });
  const brokenStart = await contained("start", () =>
    build(broken.ports).start({ ...fixture.request, signal: new AbortController().signal }),
  );
  assertConformance(
    brokenStart.status === "failed" && failureCategory(brokenStart) !== undefined,
    "an unexpected error was not recorded as a provider failure",
  );
  assertConformance(
    !brokenStart.providerFailure.message.includes("private"),
    "an unexpected error's message reached the recorded failure",
  );

  const successful = scripted();
  const run = await runToEnd(build(successful.ports), {
    ...fixture.request,
    signal: new AbortController().signal,
  });
  assertConformance(run.start.status === "started", "a scripted generation did not start");
  assertConformance(run.end?.status === "completed", "a scripted generation did not complete");
  assertConformance(
    run.end.video.mediaType === sniffMp4(run.end.video.bytes),
    "a completed clip carries a media type the host did not assign",
  );
  assertConformance(
    successful.urls().every((url) => isVideoEndpointAllowed(url, fixture.driver.providerHosts)),
    "an authenticated call went outside the driver's declared provider hosts",
  );

  const refusing = scripted(() => undefined);
  const refusedRun = await runToEnd(build(refusing.ports), {
    ...fixture.request,
    signal: new AbortController().signal,
  });
  assertConformance(
    refusedRun.end?.status !== "completed",
    "a generation completed with bytes the host's MP4 check refused",
  );

  const controlling = scripted();
  const controlAdapter = build(controlling.ports);
  const controlStart = await contained("start", () =>
    controlAdapter.start({ ...fixture.request, signal: new AbortController().signal }),
  );
  assertConformance(controlStart.status === "started", "a scripted generation did not start");
  const model = models.find(
    (candidate) => String(candidate.modelId) === String(fixture.request.modelId),
  );
  if (model?.job.cancel !== "none") {
    const cancelled = await contained("cancel", () => controlAdapter.cancel(controlStart.remoteId));
    assertConformance(
      cancelled.status !== "failed",
      "a scripted cancel of a model that declares it can cancel failed",
    );
  }
  if (model?.job.removal.kind === "delete") {
    const forgotten = await contained("forget", () => controlAdapter.forget(controlStart.remoteId));
    assertConformance(forgotten.status === "removed", "a scripted delete did not remove the job");
  }
  assertConformance(
    controlling.urls().every((url) => isVideoEndpointAllowed(url, fixture.driver.providerHosts)),
    "a cancel or delete went outside the driver's declared provider hosts",
  );

  return {
    declaredModelsDecode: true,
    discoveryStopsWhenCancelled: true,
    cancelledBeforeAnyCall: true,
    emptyPromptRefusedBeforeAnyCall: true,
    outsideDeclarationRefusedBeforeAnyCall: true,
    unreachableProviderClassified: true,
    unexpectedErrorContained: true,
    completedWithHostMediaType: true,
    hostMediaRefusalHonored: true,
    calledOnlyDeclaredEndpoints: true,
    cancelAndForgetResolve: true,
  };
}
