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

export const GEMINI_VIDEO_API_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";
const AUTH = { header: "x-goog-api-key" } as const;
/** Google's own id shape; anything else is refused before it reaches a URL path. */
const INTERACTION_ID_PATTERN = /^[A-Za-z0-9_-]{1,256}$/;
/** A Files API id, as Google shapes it inside a clip's download URI. */
const FILE_ID_PATTERN = /^[A-Za-z0-9_-]{1,256}$/;
/** First-and-last-frame interpolation takes at most this many seconds (Google's Omni guide). */
const MAX_INTERPOLATION_SECONDS = 10;

/**
 * What Gemini Omni Flash declares, from Google's Omni guide and pricing page
 * (checked 2026-11-22): 3–15 s, 360p to 4K, 16:9 or 9:16, native audio, up to
 * six reference images, billed per output token at $12 per million with
 * 1,931 / 5,792 / 8,688 / 17,376 tokens per second by resolution, input at
 * $1.50 per million. Background interactions can be cancelled and deleted,
 * and are kept 55 days on the paid tier unless deleted.
 */
export const GEMINI_OMNI_FLASH: VideoModelCapabilities = decodeVideoModelCapabilities({
  modelId: "gemini-omni-1.2-flash",
  displayName: "Gemini Omni Flash",
  durations: { kind: "range", min: 3, max: 15 },
  defaultDuration: 10,
  resolutions: ["360p", "720p", "1080p", "4k"],
  defaultResolution: "720p",
  aspectRatios: [{ ratio: "16:9" }, { ratio: "9:16" }],
  defaultAspectRatio: "16:9",
  audio: "always",
  inputs: { firstFrame: true, lastFrame: true, maxReferenceImages: 6 },
  price: {
    kind: "per-token",
    outputTokensPerSecond: [
      { resolution: "360p", tokens: 1931 },
      { resolution: "720p", tokens: 5792 },
      { resolution: "1080p", tokens: 8688 },
      { resolution: "4k", tokens: 17376 },
    ],
    outputUsdMicrosPerMillionTokens: 12_000_000,
    inputUsdMicrosPerMillionTokens: 1_500_000,
    // A conservative ceiling for one image input, so the reservation covers it.
    inputTokensPerImage: 1290,
  },
  job: { cancel: "running", removal: { kind: "delete" }, resumeWindowHours: 55 * 24 },
});

const DECLARED_MODELS: ReadonlyArray<VideoModelCapabilities> = [GEMINI_OMNI_FLASH];

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

function interactionUrl(remoteId: string, suffix = ""): string | undefined {
  return INTERACTION_ID_PATTERN.test(remoteId)
    ? `${GEMINI_VIDEO_API_BASE_URL}/interactions/${remoteId}${suffix}`
    : undefined;
}

function invalidId(): {
  readonly status: "failed";
  readonly providerFailure: ReturnType<typeof videoFailure>;
} {
  return {
    status: "failed",
    providerFailure: videoFailure("protocol", "The provider returned an unusable job id."),
  };
}

function imagePart(reference: { readonly bytes: Uint8Array; readonly mediaType: string }) {
  return {
    type: "image",
    data: Buffer.from(reference.bytes).toString("base64"),
    mime_type: reference.mediaType,
  };
}

function usageOf(payload: unknown): VideoAdapterUsage | undefined {
  const usage = jsonField(payload, "usage");
  if (usage === undefined) return undefined;
  const output = jsonField(usage, "total_output_tokens");
  const thought = jsonField(usage, "total_thought_tokens");
  const input = jsonField(usage, "total_input_tokens");
  const outputTokens =
    (typeof output === "number" ? output : 0) + (typeof thought === "number" ? thought : 0);
  return {
    ...(typeof output === "number" || typeof thought === "number" ? { outputTokens } : {}),
    ...(typeof input === "number" ? { inputTokens: input } : {}),
  };
}

/** The clip in the interaction's model output: inline base64, or a Files API download URI. */
function outputVideo(
  payload: unknown,
): { readonly data: string } | { readonly uri: string } | undefined {
  const steps = jsonField(payload, "steps");
  if (!Array.isArray(steps)) return undefined;
  for (const step of steps) {
    if (jsonField(step, "type") !== "model_output") continue;
    const content = jsonField(step, "content");
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (jsonField(part, "type") !== "video") continue;
      const data = jsonField(part, "data");
      if (typeof data === "string") return { data };
      const uri = jsonField(part, "uri");
      if (typeof uri === "string") return { uri };
    }
  }
  return undefined;
}

/**
 * Omni infers each image's role from the prompt, not from the order of the
 * images (Google's Omni guide, "Tasks parameter"), so the roles the person
 * chose are said in words before their own prompt, naming images by position.
 */
export function promptWithImageRoles(
  prompt: string,
  roles: { readonly firstFrame: boolean; readonly lastFrame: boolean; readonly references: number },
): string {
  const sentences: Array<string> = [];
  let position = 1;
  if (roles.firstFrame) {
    sentences.push(`Use image ${position} as the first frame of the clip.`);
    position += 1;
  }
  if (roles.lastFrame) {
    sentences.push(`Use image ${position} as the last frame of the clip.`);
    position += 1;
  }
  if (roles.references > 0) {
    const last = position + roles.references - 1;
    sentences.push(
      roles.references === 1
        ? `Use image ${position} only as a reference for the subjects, not as a frame.`
        : `Use images ${position} to ${last} only as references for the subjects, not as frames.`,
    );
  }
  return sentences.length === 0 ? prompt : `${sentences.join(" ")}\n\n${prompt}`;
}

async function start(
  ports: VideoGenerationPorts,
  profile: VideoGenerationProfile,
  request: VideoAdapterRequest,
): Promise<VideoAdapterStart> {
  const refusal = refuseOutsideDeclaration(declaredFor(profile), request);
  if (refusal !== undefined) return { status: "failed", providerFailure: refusal };
  if (
    request.firstFrame !== undefined &&
    request.lastFrame !== undefined &&
    request.options.durationSeconds > MAX_INTERPOLATION_SECONDS
  ) {
    return {
      status: "failed",
      providerFailure: videoFailure(
        "invalid-configuration",
        `Gemini Omni Flash makes clips from a first and a last frame only up to ${MAX_INTERPOLATION_SECONDS} seconds.`,
      ),
    };
  }
  const images = [
    ...(request.firstFrame === undefined ? [] : [request.firstFrame]),
    ...(request.lastFrame === undefined ? [] : [request.lastFrame]),
    ...request.references,
  ];
  try {
    const response = await ports.request({
      url: `${GEMINI_VIDEO_API_BASE_URL}/interactions`,
      method: "POST",
      auth: AUTH,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: String(request.modelId),
        input:
          images.length === 0
            ? request.prompt
            : [
                ...images.map(imagePart),
                {
                  type: "text",
                  text: promptWithImageRoles(request.prompt, {
                    firstFrame: request.firstFrame !== undefined,
                    lastFrame: request.lastFrame !== undefined,
                    references: request.references.length,
                  }),
                },
              ],
        response_format: {
          type: "video",
          aspect_ratio: request.options.aspectRatio,
          resolution: request.options.resolution,
          duration: `${request.options.durationSeconds}s`,
          // Google asks for URI delivery for clips over 4 MB; a later GET may
          // still answer inline, so both are read.
          delivery: "uri",
        },
        // Background execution returns the id at once and needs a stored
        // interaction; the job service deletes it as soon as the clip is kept.
        background: true,
        store: true,
      }),
      signal: request.signal,
    });
    if (!response.ok) {
      return { status: "failed", providerFailure: classifyVideoHttpFailure(response) };
    }
    const id = jsonField(await readVideoJson(response), "id");
    if (typeof id !== "string" || !INTERACTION_ID_PATTERN.test(id)) return invalidId();
    return { status: "started", remoteId: id };
  } catch (error) {
    return { status: "failed", providerFailure: asFailure(error) };
  }
}

async function readInteraction(
  ports: VideoGenerationPorts,
  remoteId: string,
  signal?: AbortSignal,
): Promise<VideoAdapterPoll> {
  const url = interactionUrl(remoteId);
  if (url === undefined) return invalidId();
  try {
    const response = await ports.request({
      url,
      method: "GET",
      auth: AUTH,
      ...(signal === undefined ? {} : { signal }),
    });
    if (!response.ok) {
      return { status: "failed", providerFailure: classifyVideoHttpFailure(response) };
    }
    const payload = await readVideoJson(response);
    const status = jsonField(payload, "status");
    const usage = usageOf(payload);
    switch (status) {
      case "in_progress":
      case "requires_action":
        return { status: "running" };
      case "cancelled":
        return usage === undefined ? { status: "cancelled" } : { status: "cancelled", usage };
      case "failed": {
        const message = jsonField(payload, "error", "message");
        return typeof message === "string" && /safety|policy|blocked/i.test(message)
          ? { status: "refused", safetyRefusal: "Google's safety filters blocked this clip." }
          : {
              status: "failed",
              providerFailure: videoFailure("provider-failed", "Google could not make this clip."),
            };
      }
      case "completed": {
        const video = outputVideo(payload);
        if (video === undefined) {
          return {
            status: "refused",
            safetyRefusal:
              "Google returned no clip, which usually means its safety filters blocked it.",
          };
        }
        if ("uri" in video) {
          const downloaded = await downloadFile(ports, video.uri, signal);
          // Google finished and billed the clip; a failed download is tried
          // again on the next poll, and a job that never gets it settles at
          // its estimate when its time runs out, never as an unbilled failure.
          if (downloaded.status !== "downloaded") return { status: "running" };
          return {
            status: "completed",
            video: { bytes: downloaded.bytes, mediaType: "video/mp4" },
            ...(usage === undefined ? {} : { usage }),
          };
        }
        const bytes = Uint8Array.from(Buffer.from(video.data, "base64"));
        if (ports.sniffMediaType(bytes) !== "video/mp4") {
          return {
            status: "failed",
            providerFailure: videoFailure("protocol", "Google returned a clip that is not an MP4."),
          };
        }
        return {
          status: "completed",
          video: { bytes, mediaType: "video/mp4" },
          ...(usage === undefined ? {} : { usage }),
        };
      }
      default:
        return {
          status: "failed",
          providerFailure: videoFailure("protocol", "Google returned an unknown job state."),
        };
    }
  } catch (error) {
    return { status: "failed", providerFailure: asFailure(error) };
  }
}

/**
 * Downloads a clip Google delivered as a Files API URI: the file is polled
 * until it is ACTIVE, then fetched from its own download address, which is on
 * Google's declared host and takes the profile's key.
 */
async function downloadFile(
  ports: VideoGenerationPorts,
  uri: string,
  signal?: AbortSignal,
): Promise<
  | { readonly status: "downloaded"; readonly bytes: Uint8Array }
  | Exclude<VideoAdapterPoll, { readonly status: "completed" }>
> {
  // Google gives either a full download URL or a bare `files/{id}` name.
  const fileId = /(?:^|\/)files\/([^/:?]+)/.exec(uri)?.[1];
  if (fileId === undefined || !FILE_ID_PATTERN.test(fileId)) {
    return {
      status: "failed",
      providerFailure: videoFailure("protocol", "Google returned an unusable clip address."),
    };
  }
  const withSignal = signal === undefined ? {} : { signal };
  const info = await ports.request({
    url: `${GEMINI_VIDEO_API_BASE_URL}/files/${fileId}`,
    method: "GET",
    auth: AUTH,
    ...withSignal,
  });
  if (!info.ok) return { status: "failed", providerFailure: classifyVideoHttpFailure(info) };
  const state = jsonField(await readVideoJson(info), "state");
  if (state === "PROCESSING" || state === "STATE_UNSPECIFIED") return { status: "running" };
  if (state !== "ACTIVE") {
    return {
      status: "failed",
      providerFailure: videoFailure("provider-failed", "Google could not finish this clip's file."),
    };
  }
  const file = await ports.request({
    url: `${GEMINI_VIDEO_API_BASE_URL}/files/${fileId}:download?alt=media`,
    method: "GET",
    auth: AUTH,
    ...withSignal,
  });
  if (!file.ok) return { status: "failed", providerFailure: classifyVideoHttpFailure(file) };
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (ports.sniffMediaType(bytes) !== "video/mp4") {
    return {
      status: "failed",
      providerFailure: videoFailure("protocol", "Google returned a clip that is not an MP4."),
    };
  }
  return { status: "downloaded", bytes };
}

async function cancel(ports: VideoGenerationPorts, remoteId: string): Promise<VideoAdapterPoll> {
  const url = interactionUrl(remoteId, "/cancel");
  if (url === undefined) return invalidId();
  try {
    const response = await ports.request({ url, method: "POST", auth: AUTH });
    if (!response.ok && response.status !== 409) {
      return { status: "failed", providerFailure: classifyVideoHttpFailure(response) };
    }
  } catch (error) {
    return { status: "failed", providerFailure: asFailure(error) };
  }
  // Google notes the state can lag the cancel briefly; the job service keeps
  // polling a `running` answer until it settles.
  return await readInteraction(ports, remoteId);
}

async function forget(ports: VideoGenerationPorts, remoteId: string): Promise<VideoAdapterForget> {
  const url = interactionUrl(remoteId);
  if (url === undefined) {
    return {
      status: "failed",
      providerFailure: videoFailure("protocol", "The provider returned an unusable job id."),
    };
  }
  try {
    const response = await ports.request({ url, method: "DELETE", auth: AUTH });
    // A 404 means the interaction is already gone, which is what was asked.
    if (response.ok || response.status === 404) return { status: "removed" };
    return { status: "failed", providerFailure: classifyVideoHttpFailure(response) };
  } catch (error) {
    return { status: "failed", providerFailure: asFailure(error) };
  }
}

/**
 * Gemini API video driver: Gemini Omni Flash through background
 * interactions. It imports only the contracts and the video seam, as a
 * third-party video plugin would.
 */
export const geminiVideoDriver: VideoGenerationDriver = {
  driverKind: "gemini-video",
  providerHosts: ["generativelanguage.googleapis.com"],
  create: ({ profile, ports }) => ({
    models: async () => declaredFor(profile),
    start: (request) => start(ports, profile, request),
    poll: (remoteId, signal) => readInteraction(ports, remoteId, signal),
    cancel: (remoteId) => cancel(ports, remoteId),
    forget: (remoteId) => forget(ports, remoteId),
  }),
};
