import { decodeVideoModelCapabilities, type VideoModelCapabilities } from "@octant/contracts";
import {
  classifyVideoHttpFailure,
  isProviderFailure,
  jsonField,
  readVideoJson,
  refuseOutsideDeclaration,
  sanitizeVideoFailure,
  videoFailure,
  type VideoAdapterForget,
  type VideoAdapterPoll,
  type VideoAdapterRequest,
  type VideoAdapterStart,
  type VideoAdapterUsage,
  type VideoGenerationDriver,
  type VideoGenerationPorts,
  type VideoGenerationProfile,
} from "@octant/provider-sdk/video-generation";

export const RUNWAY_API_BASE_URL = "https://api.dev.runwayml.com/v1";
const AUTH = { header: "authorization", scheme: "Bearer" } as const;
/** Runway requires a dated API version on every call (API reference, Conventions). */
const VERSION_HEADERS = { "x-runway-version": "2024-11-06" } as const;
/** Runway task ids are UUIDs; anything else is refused before it reaches a URL path. */
const TASK_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_PROMPT_CHARACTERS = 1000;
/** One credit is $0.01 (Runway pricing guide). */
const USD_MICROS_PER_CREDIT = 10_000;

/** Each ratio Octant offers, as the output size Runway takes for it. */
const RUNWAY_RATIOS: Readonly<Record<string, string>> = {
  "16:9": "1280:720",
  "9:16": "720:1280",
  "4:3": "1104:832",
  "1:1": "960:960",
  "3:4": "832:1104",
  "21:9": "1584:672",
};

/** Ratios Runway makes only from a first frame (the image-to-video shapes). */
const IMAGE_ONLY_RATIOS = [
  { ratio: "4:3", needsImage: true },
  { ratio: "1:1", needsImage: true },
  { ratio: "3:4", needsImage: true },
  { ratio: "21:9", needsImage: true },
] as const;

function runwayModel(input: {
  readonly modelId: string;
  readonly displayName: string;
  readonly creditsPerSecond: number;
  readonly textToVideo: boolean;
}): VideoModelCapabilities {
  return decodeVideoModelCapabilities({
    modelId: input.modelId,
    displayName: input.displayName,
    durations: { kind: "range", min: 2, max: 10 },
    resolutions: ["720p"],
    aspectRatios: [
      { ratio: "16:9", ...(input.textToVideo ? {} : { needsImage: true }) },
      { ratio: "9:16", ...(input.textToVideo ? {} : { needsImage: true }) },
      ...IMAGE_ONLY_RATIOS,
    ],
    defaultAspectRatio: "16:9",
    audio: "none",
    inputs: { firstFrame: true, lastFrame: false, maxReferenceImages: 0 },
    price: {
      kind: "per-second",
      rates: [
        { resolution: "720p", usdMicrosPerSecond: input.creditsPerSecond * USD_MICROS_PER_CREDIT },
      ],
    },
    // A finished task's output URLs expire in 24-48 hours, but fetching the
    // task again returns fresh ones, so a restarted host can still collect it.
    job: { cancel: "running", removal: { kind: "delete" }, resumeWindowHours: 24 },
  });
}

/**
 * What Runway declares for its own models, from its API reference and pricing
 * guide (checked 2026-11-22): 2-10 s at 1280:720 or 720:1280 from text, four
 * more ratios from a first frame, no audio, Gen-4.5 at 12 credits a second
 * and Gen-4 Turbo at 5. Gen-4 Turbo makes clips only from a first frame.
 */
export const RUNWAY_GEN45 = runwayModel({
  modelId: "gen4.5",
  displayName: "Runway Gen-4.5",
  creditsPerSecond: 12,
  textToVideo: true,
});
export const RUNWAY_GEN4_TURBO = runwayModel({
  modelId: "gen4_turbo",
  displayName: "Runway Gen-4 Turbo",
  creditsPerSecond: 5,
  textToVideo: false,
});

const DECLARED_MODELS: ReadonlyArray<VideoModelCapabilities> = [RUNWAY_GEN45, RUNWAY_GEN4_TURBO];

function declaredFor(profile: VideoGenerationProfile): ReadonlyArray<VideoModelCapabilities> {
  return DECLARED_MODELS.filter((model) =>
    profile.modelIds.some((id) => String(id) === String(model.modelId)),
  );
}

function asFailure(error: unknown) {
  return isProviderFailure(error)
    ? sanitizeVideoFailure(error)
    : videoFailure("provider-failed", "The provider request failed.");
}

function taskUrl(remoteId: string): string | undefined {
  return TASK_ID_PATTERN.test(remoteId) ? `${RUNWAY_API_BASE_URL}/tasks/${remoteId}` : undefined;
}

function invalidId() {
  return {
    status: "failed" as const,
    providerFailure: videoFailure("protocol", "The provider returned an unusable job id."),
  };
}

/** The credits Runway charged for the task, as the cost the job settles at. */
function usageOf(payload: unknown): VideoAdapterUsage | undefined {
  const credits = jsonField(payload, "cost", "credits");
  return typeof credits === "number" && credits >= 0
    ? { costUsdMicros: Math.round(credits * USD_MICROS_PER_CREDIT) }
    : undefined;
}

async function start(
  ports: VideoGenerationPorts,
  profile: VideoGenerationProfile,
  request: VideoAdapterRequest,
): Promise<VideoAdapterStart> {
  const refusal = refuseOutsideDeclaration(declaredFor(profile), request);
  if (refusal !== undefined) return { status: "failed", providerFailure: refusal };
  if (request.prompt.length > MAX_PROMPT_CHARACTERS) {
    return {
      status: "failed",
      providerFailure: videoFailure(
        "invalid-configuration",
        `Runway takes prompts of at most ${MAX_PROMPT_CHARACTERS} characters.`,
      ),
    };
  }
  const ratio = RUNWAY_RATIOS[request.options.aspectRatio];
  if (ratio === undefined) {
    return {
      status: "failed",
      providerFailure: videoFailure("invalid-configuration", "Runway does not offer that ratio."),
    };
  }
  const frame = request.firstFrame;
  // Runway takes JPEG, PNG or WebP prompt images; the shared reader accepts
  // more, so what Runway cannot use is refused before it is sent.
  if (frame !== undefined && !["image/jpeg", "image/png", "image/webp"].includes(frame.mediaType)) {
    return {
      status: "failed",
      providerFailure: videoFailure(
        "invalid-configuration",
        "Runway takes a JPEG, PNG or WebP first frame.",
      ),
    };
  }
  const body = {
    model: String(request.modelId),
    promptText: request.prompt,
    ratio,
    duration: request.options.durationSeconds,
    ...(frame === undefined
      ? {}
      : {
          promptImage: [
            {
              uri: `data:${frame.mediaType};base64,${Buffer.from(frame.bytes).toString("base64")}`,
              position: "first",
            },
          ],
        }),
  };
  try {
    const response = await ports.request({
      url: `${RUNWAY_API_BASE_URL}/${frame === undefined ? "text_to_video" : "image_to_video"}`,
      method: "POST",
      auth: AUTH,
      headers: { ...VERSION_HEADERS, "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: request.signal,
    });
    if (!response.ok) {
      return { status: "failed", providerFailure: classifyVideoHttpFailure(response) };
    }
    const id = jsonField(await readVideoJson(response), "id");
    if (typeof id !== "string" || !TASK_ID_PATTERN.test(id)) return invalidId();
    return { status: "started", remoteId: id };
  } catch (error) {
    return { status: "failed", providerFailure: asFailure(error) };
  }
}

async function poll(
  ports: VideoGenerationPorts,
  remoteId: string,
  signal?: AbortSignal,
): Promise<VideoAdapterPoll> {
  const url = taskUrl(remoteId);
  if (url === undefined) return invalidId();
  try {
    const response = await ports.request({
      url,
      method: "GET",
      auth: AUTH,
      headers: VERSION_HEADERS,
      ...(signal === undefined ? {} : { signal }),
    });
    if (!response.ok) {
      return { status: "failed", providerFailure: classifyVideoHttpFailure(response) };
    }
    const payload = await readVideoJson(response);
    const usage = usageOf(payload);
    switch (jsonField(payload, "status")) {
      case "PENDING":
      case "THROTTLED":
      case "RUNNING":
        return { status: "running" };
      case "CANCELLED":
        return {
          status: "cancelled",
          ...(usage === undefined ? {} : { usage }),
        };
      case "FAILED": {
        const code = jsonField(payload, "failureCode");
        if (typeof code === "string" && /^(SAFETY\.|INPUT_PREPROCESSING\.SAFETY)/.test(code)) {
          // Runway's task-failure guide says only SAFETY.INPUT failures keep
          // the credits when it does not supply a charge.
          const billed = usage === undefined && code.startsWith("SAFETY.INPUT.");
          return {
            status: "refused",
            safetyRefusal: "Runway's content moderation blocked this clip.",
            ...(billed ? { billed: true } : {}),
            ...(usage === undefined ? {} : { usage }),
          };
        }
        return {
          status: "failed",
          providerFailure: videoFailure("provider-failed", "Runway could not make this clip."),
        };
      }
      case "SUCCEEDED": {
        const output = jsonField(payload, "output");
        const first = Array.isArray(output) ? output[0] : undefined;
        if (typeof first !== "string" || !first.startsWith("https://")) {
          return {
            status: "failed",
            providerFailure: videoFailure("protocol", "Runway returned no clip address."),
          };
        }
        const fetched = await ports.fetchApprovedVideoUrl({
          url: first,
          ...(signal === undefined ? {} : { signal }),
        });
        // Runway made and billed the clip; a failed download is tried again
        // on the next poll, which also returns a fresh address.
        if ("failure" in fetched) return { status: "running" };
        if (ports.sniffMediaType(fetched.bytes) !== "video/mp4") {
          return {
            status: "failed",
            providerFailure: videoFailure("protocol", "Runway returned a clip that is not an MP4."),
          };
        }
        return {
          status: "completed",
          video: { bytes: fetched.bytes, mediaType: "video/mp4" },
          ...(usage === undefined ? {} : { usage }),
        };
      }
      default:
        return {
          status: "failed",
          providerFailure: videoFailure("protocol", "Runway returned an unknown task state."),
        };
    }
  } catch (error) {
    return { status: "failed", providerFailure: asFailure(error) };
  }
}

/** One DELETE cancels a pending or running task and deletes a finished one (API reference). */
async function remove(
  ports: VideoGenerationPorts,
  remoteId: string,
  signal?: AbortSignal,
): Promise<Response | undefined> {
  const url = taskUrl(remoteId);
  if (url === undefined) return undefined;
  return ports.request({
    url,
    method: "DELETE",
    auth: AUTH,
    headers: VERSION_HEADERS,
    ...(signal === undefined ? {} : { signal }),
  });
}

async function cancel(
  ports: VideoGenerationPorts,
  remoteId: string,
  signal?: AbortSignal,
): Promise<VideoAdapterPoll> {
  try {
    const response = await remove(ports, remoteId, signal);
    if (response === undefined) return invalidId();
    // DELETE gives no billing evidence. The task may have started or finished
    // before Runway handled the cancellation, so the host keeps its estimate.
    if (response.ok || response.status === 404) return { status: "cancelled" };
    return { status: "failed", providerFailure: classifyVideoHttpFailure(response) };
  } catch (error) {
    return { status: "failed", providerFailure: asFailure(error) };
  }
}

async function forget(ports: VideoGenerationPorts, remoteId: string): Promise<VideoAdapterForget> {
  try {
    const response = await remove(ports, remoteId);
    if (response === undefined) {
      return {
        status: "failed",
        providerFailure: videoFailure("protocol", "The provider returned an unusable job id."),
      };
    }
    // A 404 means the task is already gone, which is what was asked.
    if (response.ok || response.status === 404) return { status: "removed" };
    return { status: "failed", providerFailure: classifyVideoHttpFailure(response) };
  } catch (error) {
    return { status: "failed", providerFailure: asFailure(error) };
  }
}

/**
 * Runway API video driver: Gen-4.5 and Gen-4 Turbo through tasks. It imports
 * only the contracts and the video seam, as a third-party video plugin would.
 */
export const runwayVideoDriver: VideoGenerationDriver = {
  driverKind: "runway-video",
  providerName: "Runway",
  providerHosts: ["api.dev.runwayml.com"],
  create: ({ profile, ports }) => ({
    models: async () => declaredFor(profile),
    start: (request) => start(ports, profile, request),
    poll: (remoteId, signal) => poll(ports, remoteId, signal),
    cancel: (remoteId, signal) => cancel(ports, remoteId, signal),
    forget: (remoteId) => forget(ports, remoteId),
  }),
};
