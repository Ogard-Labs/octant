import {
  decodeProviderFailure,
  type ImageArtifactMediaType,
  type ProviderFailureCategory,
  type ProviderInstance,
} from "@octant/contracts";
import {
  configuredImageBaseUrl,
  imageFailure,
  isImageEndpointAllowed,
  type ImageAdapterRequest,
  type ImageAdapterResult,
  type ImageGenerationDriver,
  type ImageGenerationPorts,
  type ImageHttpRequest,
} from "./imageGeneration";

export interface ImageGenerationConformanceFixture {
  readonly driver: ImageGenerationDriver;
  readonly instance: ProviderInstance;
  /** A request the profile accepts. The harness supplies its own signal. */
  readonly request: Omit<ImageAdapterRequest, "signal">;
  /** Answers each provider call of one successful generation, polls included. */
  readonly respond: (request: ImageHttpRequest) => Response;
  /** What the approved-URL port returns when the adapter fetches a result URL. */
  readonly approvedImageBytes?: Uint8Array;
  readonly expectedImageCount: number;
}

export interface ImageGenerationConformanceEvidence {
  readonly cancelledBeforeAnyCall: true;
  readonly emptyPromptRefusedBeforeAnyCall: true;
  readonly unreachableProviderClassified: true;
  readonly unexpectedErrorContained: true;
  readonly completedWithHostMediaTypes: true;
  readonly hostMediaRefusalHonored: true;
  readonly calledOnlyDeclaredEndpoints: true;
}

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

function isPng(bytes: Uint8Array): boolean {
  return PNG_BYTES.subarray(0, 8).every((byte, index) => bytes[index] === byte);
}

interface RecordingPorts {
  readonly ports: ImageGenerationPorts;
  readonly calls: () => number;
  readonly urls: () => ReadonlyArray<string>;
}

function recordingPorts(options: {
  readonly request: ImageGenerationPorts["request"];
  readonly approvedImageBytes: Uint8Array;
  readonly sniff: ImageGenerationPorts["sniffMediaType"];
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
      fetchApprovedImageUrl: async () => {
        calls += 1;
        return { bytes: options.approvedImageBytes };
      },
      sniffMediaType: options.sniff,
    },
    calls: () => calls,
    urls: () => urls,
  };
}

const sniffPng = (bytes: Uint8Array): ImageArtifactMediaType | undefined =>
  isPng(bytes) ? "image/png" : undefined;

function assertConformance(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(`Image generation conformance failed: ${message}`);
}

async function generate(
  fixture: ImageGenerationConformanceFixture,
  instance: ProviderInstance,
  ports: ImageGenerationPorts,
  request: ImageAdapterRequest,
): Promise<ImageAdapterResult> {
  const adapter = fixture.driver.create({ instance, ports });
  try {
    return await adapter.generate(request);
  } catch {
    throw new Error("Image generation conformance failed: generate rejected instead of failing");
  }
}

function failureCategory(result: ImageAdapterResult): ProviderFailureCategory | undefined {
  if (result.status !== "failed") return undefined;
  try {
    return decodeProviderFailure(result.providerFailure).category;
  } catch {
    return undefined;
  }
}

/**
 * Proves an image driver keeps the seam's promises with ports the harness
 * controls: it stops before calling out when cancelled or given an empty
 * prompt, turns an unreachable provider and an unexpected error into recorded
 * failures, returns only bytes the host's media-type check accepted, and
 * sends authenticated calls only to the hosts it declares.
 */
export async function runImageGenerationConformance(
  fixture: ImageGenerationConformanceFixture,
): Promise<ImageGenerationConformanceEvidence> {
  const approvedImageBytes = fixture.approvedImageBytes ?? PNG_BYTES;
  const scripted = () =>
    recordingPorts({
      request: async (request) => fixture.respond(request),
      approvedImageBytes,
      sniff: sniffPng,
    });

  const cancelled = scripted();
  const controller = new AbortController();
  controller.abort();
  const cancelledResult = await generate(fixture, fixture.instance, cancelled.ports, {
    ...fixture.request,
    signal: controller.signal,
  });
  assertConformance(
    failureCategory(cancelledResult) === "interrupted",
    "a cancelled request did not fail as interrupted",
  );
  assertConformance(cancelled.calls() === 0, "a cancelled request still called the provider");

  const empty = scripted();
  const emptyResult = await generate(fixture, fixture.instance, empty.ports, {
    ...fixture.request,
    prompt: "   ",
  });
  assertConformance(
    failureCategory(emptyResult) === "invalid-configuration",
    "an empty prompt did not fail as invalid configuration",
  );
  assertConformance(empty.calls() === 0, "an empty prompt still called the provider");

  const unreachable = recordingPorts({
    request: async () => {
      throw imageFailure("unavailable", "The provider endpoint could not be reached.");
    },
    approvedImageBytes,
    sniff: sniffPng,
  });
  const unreachableResult = await generate(
    fixture,
    fixture.instance,
    unreachable.ports,
    fixture.request,
  );
  assertConformance(
    failureCategory(unreachableResult) === "unavailable",
    "an unreachable provider was not recorded as unavailable",
  );

  const broken = recordingPorts({
    request: async () => {
      throw new Error("unexpected transport error with private detail");
    },
    approvedImageBytes,
    sniff: sniffPng,
  });
  const brokenResult = await generate(fixture, fixture.instance, broken.ports, fixture.request);
  assertConformance(
    failureCategory(brokenResult) !== undefined,
    "an unexpected error was not recorded as a provider failure",
  );
  assertConformance(
    brokenResult.status === "failed" && !brokenResult.providerFailure.message.includes("private"),
    "an unexpected error's message reached the recorded failure",
  );

  const successful = scripted();
  const completed = await generate(fixture, fixture.instance, successful.ports, fixture.request);
  assertConformance(completed.status === "completed", "a scripted generation did not complete");
  assertConformance(
    completed.images.length === fixture.expectedImageCount,
    "a completed generation returned a different number of images",
  );
  assertConformance(
    completed.images.every((image) => image.mediaType === sniffPng(image.bytes)),
    "a completed image carries a media type the host did not assign",
  );
  const baseUrl = configuredImageBaseUrl(fixture.instance);
  assertConformance(
    successful.urls().every((url) =>
      isImageEndpointAllowed(url, {
        providerHosts: fixture.driver.providerHosts,
        ...(baseUrl === undefined ? {} : { baseUrl }),
      }),
    ),
    "an authenticated call went outside the driver's declared provider hosts",
  );

  const refusing = recordingPorts({
    request: async (request) => fixture.respond(request),
    approvedImageBytes,
    sniff: () => undefined,
  });
  const refusedMedia = await generate(fixture, fixture.instance, refusing.ports, fixture.request);
  assertConformance(
    refusedMedia.status !== "completed",
    "a generation completed with bytes the host's media-type check refused",
  );

  return {
    cancelledBeforeAnyCall: true,
    emptyPromptRefusedBeforeAnyCall: true,
    unreachableProviderClassified: true,
    unexpectedErrorContained: true,
    completedWithHostMediaTypes: true,
    hostMediaRefusalHonored: true,
    calledOnlyDeclaredEndpoints: true,
  };
}
