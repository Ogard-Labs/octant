import {
  decodeVideoModelCapabilities,
  type ProviderFailure,
  type VideoModelCapabilities,
  type VideoPrice,
} from "@octant/contracts";
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
  type VideoGenerationDriver,
  type VideoGenerationPorts,
  type VideoGenerationProfile,
} from "@octant/provider-sdk/video-generation";

const QUEUE_BASE_URL = "https://queue.fal.run";
const PLATFORM_BASE_URL = "https://api.fal.ai/v1";
const SCHEMA_URL = "https://fal.ai/api/openapi/queue/openapi.json";
const AUTH = { header: "authorization", scheme: "Key" } as const;
/**
 * fal keeps no request history when asked (`X-Fal-Store-IO: 0`), and its CDN
 * copy of the clip expires after two hours. Deleting it outright needs a key
 * with fal's admin preset, so the copy is left to expire instead (fal's
 * data-retention guide, checked 2026-11-22).
 */
const FAL_CLIP_EXPIRY_HOURS = 2;
const RETENTION_HEADERS = {
  "x-fal-store-io": "0",
  "x-fal-object-lifecycle-preference": JSON.stringify({
    expiration_duration_seconds: FAL_CLIP_EXPIRY_HOURS * 3600,
  }),
} as const;
/**
 * With request history off, fal keeps a result for one hour after it
 * completes (Inference API, "Result retention"), so a restarted host can
 * collect a clip only within that hour.
 */
const FAL_RESUME_WINDOW_HOURS = 1;
/** An endpoint id: owner, app, and an optional path, each a plain lowercase segment. */
const ENDPOINT_PATTERN = /^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*(\/[a-z0-9][a-z0-9._-]*)*$/;
const REQUEST_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Placeholders for an option the endpoint does not take; the field is then left out of the request. */
const MODEL_DEFAULT = "model default";

/** How one endpoint takes its options, read from its published input schema. */
interface FalEndpoint {
  readonly endpointId: string;
  readonly durationFormat: "seconds-suffix" | "string" | "integer" | "frames";
  /** The fixed frame rate a frame-counted endpoint runs at, when its schema gives one. */
  readonly framesPerSecond: number | undefined;
  readonly takesResolution: boolean;
  readonly takesAspectRatio: boolean;
  readonly takesAudio: boolean;
  /** The field a first frame goes in, when the endpoint takes one. */
  readonly firstFrameField: "image_url" | "first_frame_url" | undefined;
  readonly takesLastFrame: boolean;
  readonly firstFrameRequired: boolean;
  readonly lastFrameRequired: boolean;
  readonly model: VideoModelCapabilities;
}

interface FalEndpoints {
  readonly endpoints: ReadonlyArray<FalEndpoint>;
  /** Why an endpoint or the prices could not be read, when one could not. */
  readonly failure?: ProviderFailure;
}

function asFailure(error: unknown): ProviderFailure {
  return isProviderFailure(error)
    ? sanitizeVideoFailure(error)
    : videoFailure("provider-failed", "The provider request failed.");
}

function invalidId() {
  return {
    status: "failed" as const,
    providerFailure: videoFailure("protocol", "The provider returned an unusable job id."),
  };
}

function enumOf(property: unknown): ReadonlyArray<unknown> | undefined {
  const values = jsonField(property, "enum");
  return Array.isArray(values) && values.length > 0 ? values : undefined;
}

function secondsOf(value: unknown): number | undefined {
  const seconds =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Number(value.replace(/s$/, ""))
        : NaN;
  return Number.isInteger(seconds) && seconds > 0 ? seconds : undefined;
}

/** The POST body schema of the endpoint's queue OpenAPI document. */
function inputSchema(document: unknown, endpointId: string): unknown {
  const reference = jsonField(
    document,
    "paths",
    `/${endpointId}`,
    "post",
    "requestBody",
    "content",
    "application/json",
    "schema",
    "$ref",
  );
  if (typeof reference !== "string" || !reference.startsWith("#/components/schemas/")) {
    return undefined;
  }
  return jsonField(
    document,
    "components",
    "schemas",
    reference.slice("#/components/schemas/".length),
  );
}

/**
 * The frame rate a schema fixes: a single number wherever the schema mentions
 * one — a default, a constant, a one-value enum, or matching minimum and
 * maximum — so frames can be turned into seconds. A selectable rate, or none,
 * gives no honest translation.
 */
function fixedFramesPerSecond(property: unknown): number | undefined {
  const declared = [
    jsonField(property, "const"),
    jsonField(property, "default"),
    ...(enumOf(property) ?? []),
    jsonField(property, "minimum"),
    jsonField(property, "maximum"),
  ].filter((value): value is number => typeof value === "number" && value > 0);
  const [first] = declared;
  return first !== undefined && declared.every((value) => value === first) ? first : undefined;
}

interface FalDuration {
  readonly durations:
    | { kind: "values"; values: ReadonlyArray<number> }
    | { kind: "range"; min: number; max: number };
  readonly defaultDuration: number | undefined;
  readonly format: FalEndpoint["durationFormat"];
  readonly framesPerSecond: number | undefined;
}

/**
 * How long a clip is, in the endpoint's own terms: a `duration` field in
 * seconds, or a `num_frames` count at a schema-fixed frame rate. Only whole
 * seconds are offered — Octant's clip options count whole seconds.
 */
function readFalDuration(properties: unknown): FalDuration | string {
  const duration = jsonField(properties, "duration");
  if (duration !== undefined) {
    const durationValues = (enumOf(duration) ?? [])
      .map(secondsOf)
      .filter((seconds): seconds is number => seconds !== undefined);
    const durationMin = jsonField(duration, "minimum");
    const durationMax = jsonField(duration, "maximum");
    const durations =
      durationValues.length > 0
        ? { kind: "values" as const, values: durationValues }
        : typeof durationMin === "number" &&
            typeof durationMax === "number" &&
            Number.isInteger(durationMin) &&
            Number.isInteger(durationMax) &&
            durationMin > 0 &&
            durationMin <= durationMax
          ? { kind: "range" as const, min: durationMin, max: durationMax }
          : undefined;
    if (durations === undefined) {
      return "the endpoint's duration values are not whole seconds";
    }
    const enumValues = enumOf(duration);
    return {
      durations,
      defaultDuration: secondsOf(jsonField(duration, "default")),
      format:
        enumValues !== undefined && typeof enumValues[0] === "string"
          ? String(enumValues[0]).endsWith("s")
            ? "seconds-suffix"
            : "string"
          : "integer",
      framesPerSecond: undefined,
    };
  }

  const frames = jsonField(properties, "num_frames");
  if (frames === undefined) {
    return "the endpoint's schema declares no clip length";
  }
  const framesPerSecond = fixedFramesPerSecond(jsonField(properties, "frames_per_second"));
  if (framesPerSecond === undefined) {
    return "the endpoint counts frames at a frame rate its schema does not fix";
  }
  const frameValues = (enumOf(frames) ?? []).filter(
    (value): value is number => typeof value === "number" && Number.isInteger(value) && value > 0,
  );
  const wholeSeconds = (frame: number) =>
    Number.isInteger(frame / framesPerSecond) ? frame / framesPerSecond : undefined;
  if (frameValues.length > 0) {
    const values = [
      ...new Set(
        frameValues.map(wholeSeconds).filter((seconds): seconds is number => seconds !== undefined),
      ),
    ].sort((a, b) => a - b);
    if (values.length === 0) {
      return "no whole-second clip length fits the endpoint's frame counts";
    }
    const defaultFrame = jsonField(frames, "default");
    const defaultSeconds =
      typeof defaultFrame === "number" ? wholeSeconds(defaultFrame) : undefined;
    return {
      durations: { kind: "values", values },
      defaultDuration:
        defaultSeconds !== undefined && values.includes(defaultSeconds)
          ? defaultSeconds
          : values[0],
      format: "frames",
      framesPerSecond,
    };
  }
  const frameMin = jsonField(frames, "minimum");
  const frameMax = jsonField(frames, "maximum");
  if (typeof frameMin !== "number" || typeof frameMax !== "number") {
    return "the endpoint's frame counts have no usable limits";
  }
  const min = Math.ceil(frameMin / framesPerSecond);
  const max = Math.floor(frameMax / framesPerSecond);
  if (min > max || min <= 0) {
    return "no whole-second clip length fits the endpoint's frame counts";
  }
  const defaultFrame = jsonField(frames, "default");
  const defaultSeconds = typeof defaultFrame === "number" ? wholeSeconds(defaultFrame) : undefined;
  return {
    durations: { kind: "range", min, max },
    defaultDuration:
      defaultSeconds !== undefined && defaultSeconds >= min && defaultSeconds <= max
        ? defaultSeconds
        : min,
    format: "frames",
    framesPerSecond,
  };
}

/**
 * The options an endpoint declares, in Octant's terms, or why the endpoint
 * cannot be offered. A price comes separately.
 */
export function readFalEndpoint(
  endpointId: string,
  document: unknown,
  price: VideoPrice,
): { readonly endpoint: FalEndpoint } | { readonly reason: string } {
  const schema = inputSchema(document, endpointId);
  const properties = jsonField(schema, "properties");
  if (properties === undefined) {
    return { reason: "the endpoint's published schema declares no inputs" };
  }
  const required = jsonField(schema, "required");
  const isRequired = (name: string) => Array.isArray(required) && required.includes(name);
  // The only inputs the adapter can fill; an endpoint that requires anything
  // else cannot be run, so it is not offered.
  const SUPPLIABLE = new Set([
    "prompt",
    "duration",
    "num_frames",
    "frames_per_second",
    "resolution",
    "aspect_ratio",
    "generate_audio",
    "image_url",
    "first_frame_url",
    "last_frame_url",
  ]);
  if (
    Array.isArray(required) &&
    required.some((name) => typeof name === "string" && !SUPPLIABLE.has(name))
  ) {
    return { reason: "the endpoint requires inputs the driver cannot supply" };
  }

  const duration = readFalDuration(properties);
  if (typeof duration === "string") return { reason: duration };

  const resolutionValues = (enumOf(jsonField(properties, "resolution")) ?? []).filter(
    (value): value is string => typeof value === "string",
  );
  const ratioValues = (enumOf(jsonField(properties, "aspect_ratio")) ?? []).filter(
    (value): value is string => typeof value === "string" && value !== "auto",
  );
  const audio = jsonField(properties, "generate_audio");
  const firstFrameField =
    jsonField(properties, "image_url") !== undefined
      ? ("image_url" as const)
      : jsonField(properties, "first_frame_url") !== undefined
        ? ("first_frame_url" as const)
        : undefined;
  const takesLastFrame = jsonField(properties, "last_frame_url") !== undefined;
  const firstFrameRequired = isRequired("image_url") || isRequired("first_frame_url");
  const lastFrameRequired = isRequired("last_frame_url");
  const resolutions = resolutionValues.length > 0 ? resolutionValues : [MODEL_DEFAULT];
  const ratios = ratioValues.length > 0 ? ratioValues : [MODEL_DEFAULT];
  const resolutionDefault = jsonField(jsonField(properties, "resolution"), "default");
  const ratioDefault = jsonField(jsonField(properties, "aspect_ratio"), "default");

  try {
    const model = decodeVideoModelCapabilities({
      modelId: endpointId,
      displayName: endpointId,
      durations: duration.durations,
      ...(duration.defaultDuration === undefined
        ? {}
        : { defaultDuration: duration.defaultDuration }),
      resolutions,
      ...(typeof resolutionDefault === "string" && resolutions.includes(resolutionDefault)
        ? { defaultResolution: resolutionDefault }
        : {}),
      aspectRatios: ratios.map((ratio) =>
        firstFrameRequired || lastFrameRequired ? { ratio, needsImage: true } : { ratio },
      ),
      ...(typeof ratioDefault === "string" && ratios.includes(ratioDefault)
        ? { defaultAspectRatio: ratioDefault }
        : {}),
      audio: audio === undefined ? "none" : "optional",
      ...(typeof jsonField(audio, "default") === "boolean"
        ? { defaultAudio: jsonField(audio, "default") }
        : {}),
      inputs: {
        firstFrame: firstFrameField !== undefined,
        lastFrame: takesLastFrame,
        maxReferenceImages: 0,
      },
      price,
      job: {
        cancel: "running",
        removal: { kind: "expires", afterHours: FAL_CLIP_EXPIRY_HOURS },
        resumeWindowHours: FAL_RESUME_WINDOW_HOURS,
      },
    });
    return {
      endpoint: {
        endpointId,
        durationFormat: duration.format,
        framesPerSecond: duration.framesPerSecond,
        takesResolution: resolutionValues.length > 0,
        takesAspectRatio: ratioValues.length > 0,
        takesAudio: audio !== undefined,
        firstFrameField,
        takesLastFrame,
        firstFrameRequired,
        lastFrameRequired,
        model,
      },
    };
  } catch {
    return { reason: "the endpoint's declared options could not be described" };
  }
}

/**
 * The price fal's pricing API gives, in Octant's terms: a per-second unit is a
 * per-second rate; a per-video unit is a flat rate only for the endpoint's
 * default clip, since fal adjusts it by length and resolution; anything else,
 * or a currency other than US dollars, is unpublished, so a dollar ceiling
 * refuses it.
 */
export function falPrice(
  entry: unknown,
  defaults: {
    readonly durationSeconds: number | undefined;
    readonly resolutions: ReadonlyArray<string>;
    readonly defaultResolution: string | undefined;
    /** The endpoint lets the request choose audio, which fal prices separately. */
    readonly audioSelectable: boolean;
  },
): VideoPrice {
  const unitPrice = jsonField(entry, "unit_price");
  const unit = jsonField(entry, "unit");
  if (jsonField(entry, "currency") !== "USD" || typeof unitPrice !== "number" || unitPrice < 0) {
    return { kind: "unpublished" };
  }
  const usdMicros = Math.round(unitPrice * 1_000_000);
  if (unit === "second" || unit === "seconds") {
    // One unit price cannot stand for billing that varies with resolution or
    // audio — fal's Veo 3.1 runs $0.20/s to $0.60/s over those options — so
    // only a single-resolution endpoint without an audio choice can take it;
    // anything else is unpublished and the dollar ceiling refuses it.
    const [first] = defaults.resolutions;
    if (first === undefined || defaults.resolutions.length > 1 || defaults.audioSelectable) {
      return { kind: "unpublished" };
    }
    return {
      kind: "per-second",
      rates: [{ resolution: first, usdMicrosPerSecond: usdMicros }],
    };
  }
  const resolution = defaults.defaultResolution ?? defaults.resolutions[0];
  if (unit === "video" && defaults.durationSeconds !== undefined && resolution !== undefined) {
    return {
      kind: "per-clip",
      rates: [{ durationSeconds: defaults.durationSeconds, resolution, usdMicros }],
    };
  }
  return { kind: "unpublished" };
}

/**
 * fal serves finished clips from its own media hosts; a result that points
 * elsewhere is refused rather than fetched from the host's network.
 */
function falDownloadAllowed(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:") return false;
    const host = parsed.hostname;
    return (
      host === "fal.media" ||
      host.endsWith(".fal.media") ||
      host === "fal.run" ||
      host.endsWith(".fal.run") ||
      host === "fal.ai" ||
      host.endsWith(".fal.ai")
    );
  } catch {
    return false;
  }
}

/** The endpoint id and fal's request id a job is tracked by, as one remote id. */
function remoteIdOf(endpointId: string, requestId: string): string {
  return `${endpointId}#${requestId}`;
}

/**
 * The status, result and cancel addresses use only the owner and app of the
 * endpoint (Inference API, "Model IDs and paths").
 */
function queueUrls(remoteId: string) {
  const [endpointId = "", requestId = ""] = remoteId.split("#");
  if (!ENDPOINT_PATTERN.test(endpointId) || !REQUEST_ID_PATTERN.test(requestId)) return undefined;
  const [owner, app] = endpointId.split("/");
  const base = `${QUEUE_BASE_URL}/${owner}/${app}/requests/${requestId}`;
  return { status: `${base}/status`, result: base, cancel: `${base}/cancel` };
}

interface QueueUrls {
  readonly status: string;
  readonly result: string;
  readonly cancel: string;
}

function createFalAdapter(profile: VideoGenerationProfile, ports: VideoGenerationPorts) {
  let declared: FalEndpoints | undefined;
  let submittedModels: ReadonlyArray<VideoModelCapabilities> | undefined;
  /** Routes fal's submit answer returned, per request id; ids are reconstructed otherwise. */
  const remembered = new Map<string, QueueUrls>();
  const urlsFor = (remoteId: string): QueueUrls | undefined =>
    remembered.get(remoteId) ?? queueUrls(remoteId);
  const rememberUrls = (remoteId: string, urls: QueueUrls) => {
    while (remembered.size >= 512) {
      const oldest = remembered.keys().next().value;
      if (oldest === undefined) break;
      remembered.delete(oldest);
    }
    remembered.set(remoteId, urls);
  };

  const readEndpoints = async (signal?: AbortSignal): Promise<FalEndpoints> => {
    signal?.throwIfAborted();
    const withSignal = signal === undefined ? {} : { signal };
    const ids = profile.modelIds.map(String).filter((id) => ENDPOINT_PATTERN.test(id));
    if (ids.length === 0) return { endpoints: [] };
    let failure: ProviderFailure | undefined;
    let prices: ReadonlyArray<unknown> = [];
    try {
      const url = new URL(`${PLATFORM_BASE_URL}/models/pricing`);
      url.searchParams.set("endpoint_id", ids.join(","));
      const response = await ports.request({
        url: url.toString(),
        method: "GET",
        auth: AUTH,
        ...withSignal,
      });
      const listed = response.ok ? jsonField(await readVideoJson(response), "prices") : undefined;
      prices = Array.isArray(listed) ? listed : [];
    } catch (error) {
      // Without a price every endpoint is declared unpublished below.
      failure = asFailure(error);
    }
    const endpoints: Array<FalEndpoint> = [];
    const reasons: Array<string> = [];
    for (const endpointId of ids) {
      if (signal?.aborted === true) break;
      try {
        const url = new URL(SCHEMA_URL);
        url.searchParams.set("endpoint_id", endpointId);
        const response = await ports.request({
          url: url.toString(),
          method: "GET",
          auth: AUTH,
          ...withSignal,
        });
        if (!response.ok) {
          // A missing endpoint is a configuration problem for that endpoint,
          // not an outage that hides the endpoints that do exist.
          if (response.status === 404) {
            reasons.push(`${endpointId}: fal has no endpoint by that id`);
          } else {
            failure = classifyVideoHttpFailure(response);
          }
          continue;
        }
        const document = await readVideoJson(response);
        // Read once without a price to learn the defaults the price depends on.
        const shape = readFalEndpoint(endpointId, document, { kind: "unpublished" });
        if ("reason" in shape) {
          reasons.push(`${endpointId}: ${shape.reason}`);
          continue;
        }
        const entry = prices.find(
          (candidate) => jsonField(candidate, "endpoint_id") === endpointId,
        );
        const price = falPrice(entry, {
          durationSeconds: shape.endpoint.model.defaultDuration,
          resolutions: shape.endpoint.model.resolutions,
          defaultResolution: shape.endpoint.model.defaultResolution,
          audioSelectable: shape.endpoint.model.audio === "optional",
        });
        const endpoint = readFalEndpoint(endpointId, document, price);
        if ("endpoint" in endpoint) {
          endpoints.push(endpoint.endpoint);
        } else {
          reasons.push(`${endpointId}: ${endpoint.reason}`);
        }
      } catch (error) {
        // An endpoint whose schema cannot be read is not offered.
        failure = asFailure(error);
      }
    }
    // A profile whose endpoints all read cleanly but none can be offered is a
    // configuration problem, said aloud rather than offered as nothing.
    if (failure === undefined && endpoints.length === 0 && reasons.length > 0) {
      failure = videoFailure(
        "invalid-configuration",
        `No fal endpoint can be offered — ${reasons.join("; ")}.`,
      );
    }
    return failure === undefined ? { endpoints } : { endpoints, failure };
  };

  // Reuse completed discovery without tying a new start to another call's signal.
  const endpoints = async (signal?: AbortSignal): Promise<FalEndpoints> => {
    if (declared !== undefined) return declared;
    const read = await readEndpoints(signal);
    if (read.failure === undefined && signal?.aborted !== true) declared = read;
    return read;
  };

  const start = async (request: VideoAdapterRequest): Promise<VideoAdapterStart> => {
    // A stopped request or an empty prompt sends nothing, not even the
    // schema and price reads; the seam's own check gives the reason.
    if (request.signal.aborted || request.prompt.trim().length === 0) {
      const early = refuseOutsideDeclaration([], request);
      if (early !== undefined) return { status: "failed", providerFailure: early };
    }
    const read = await endpoints(request.signal);
    const known = read.endpoints;
    // The endpoint is the profile's but could not be read: say why, rather
    // than calling it undeclared.
    if (
      read.failure !== undefined &&
      !known.some((endpoint) => endpoint.endpointId === String(request.modelId)) &&
      profile.modelIds.some((id) => String(id) === String(request.modelId))
    ) {
      return { status: "failed", providerFailure: read.failure };
    }
    const refusal = refuseOutsideDeclaration(
      known.map((endpoint) => endpoint.model),
      request,
    );
    if (refusal !== undefined) return { status: "failed", providerFailure: refusal };
    const endpoint = known.find((candidate) => candidate.endpointId === String(request.modelId));
    if (endpoint === undefined) {
      return {
        status: "failed",
        providerFailure: videoFailure("unsupported", "That fal endpoint is not offered."),
      };
    }
    const seconds = request.options.durationSeconds;
    const dataUrl = (frame: NonNullable<VideoAdapterRequest["firstFrame"]>) =>
      `data:${frame.mediaType};base64,${Buffer.from(frame.bytes).toString("base64")}`;
    if (endpoint.firstFrameRequired && request.firstFrame === undefined) {
      return {
        status: "failed",
        providerFailure: videoFailure(
          "invalid-configuration",
          `${endpoint.endpointId} needs a first frame.`,
        ),
      };
    }
    if (endpoint.lastFrameRequired && request.lastFrame === undefined) {
      return {
        status: "failed",
        providerFailure: videoFailure(
          "invalid-configuration",
          `${endpoint.endpointId} needs a last frame.`,
        ),
      };
    }
    const framesPerSecond = endpoint.framesPerSecond;
    const body = {
      prompt: request.prompt,
      ...(endpoint.durationFormat === "frames" && framesPerSecond !== undefined
        ? {
            num_frames: seconds * framesPerSecond,
            frames_per_second: framesPerSecond,
          }
        : {
            duration:
              endpoint.durationFormat === "seconds-suffix"
                ? `${seconds}s`
                : endpoint.durationFormat === "string"
                  ? String(seconds)
                  : seconds,
          }),
      ...(endpoint.takesResolution ? { resolution: request.options.resolution } : {}),
      ...(endpoint.takesAspectRatio ? { aspect_ratio: request.options.aspectRatio } : {}),
      ...(endpoint.takesAudio ? { generate_audio: request.options.audio } : {}),
      ...(request.firstFrame === undefined || endpoint.firstFrameField === undefined
        ? {}
        : { [endpoint.firstFrameField]: dataUrl(request.firstFrame) }),
      ...(request.lastFrame === undefined || !endpoint.takesLastFrame
        ? {}
        : { last_frame_url: dataUrl(request.lastFrame) }),
    };
    try {
      const response = await ports.request({
        url: `${QUEUE_BASE_URL}/${endpoint.endpointId}`,
        method: "POST",
        auth: AUTH,
        headers: { ...RETENTION_HEADERS, "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: request.signal,
      });
      if (!response.ok) {
        return { status: "failed", providerFailure: classifyVideoHttpFailure(response) };
      }
      const submitted = await readVideoJson(response);
      const requestId = jsonField(submitted, "request_id");
      if (typeof requestId !== "string" || !REQUEST_ID_PATTERN.test(requestId)) return invalidId();
      // Even a partial read may describe the endpoint well enough to submit.
      // The host needs that declaration to journal the accepted id without I/O.
      submittedModels = read.failure === undefined ? undefined : known.map((entry) => entry.model);
      const remoteId = remoteIdOf(endpoint.endpointId, requestId);
      const [status, result, cancel] = ["status_url", "response_url", "cancel_url"].map((name) =>
        jsonField(submitted, name),
      );
      if (typeof status === "string" && typeof result === "string" && typeof cancel === "string") {
        rememberUrls(remoteId, { status, result, cancel });
      }
      return { status: "started", remoteId };
    } catch (error) {
      return { status: "failed", providerFailure: asFailure(error) };
    }
  };

  const poll = async (remoteId: string, signal?: AbortSignal): Promise<VideoAdapterPoll> => {
    const urls = urlsFor(remoteId);
    if (urls === undefined) return invalidId();
    const withSignal = signal === undefined ? {} : { signal };
    try {
      const status = await ports.request({
        url: urls.status,
        method: "GET",
        auth: AUTH,
        ...withSignal,
      });
      if (!status.ok && status.status !== 202) {
        return { status: "failed", providerFailure: classifyVideoHttpFailure(status) };
      }
      if (jsonField(await readVideoJson(status), "status") !== "COMPLETED")
        return { status: "running" };
      // A failed or cancelled request is also COMPLETED; its result says which.
      const result = await ports.request({
        url: urls.result,
        method: "GET",
        auth: AUTH,
        ...withSignal,
      });
      if (!result.ok) {
        return { status: "failed", providerFailure: classifyVideoHttpFailure(result) };
      }
      const units = Number(result.headers.get("x-fal-billable-units"));
      const usage = Number.isFinite(units) && units > 0 ? { billedSeconds: units } : undefined;
      const videoUrl = jsonField(await readVideoJson(result), "video", "url");
      if (typeof videoUrl !== "string" || !falDownloadAllowed(videoUrl)) {
        return {
          status: "failed",
          providerFailure: videoFailure(
            "protocol",
            "fal returned a clip address outside fal's media hosts.",
          ),
          ...(usage === undefined ? {} : { billed: true, usage }),
        };
      }
      const fetched = await ports.fetchApprovedVideoUrl({ url: videoUrl, ...withSignal });
      // fal made and billed the clip; a failed download is tried again on the
      // next poll while the result is still kept.
      if ("failure" in fetched) return { status: "running" };
      if (ports.sniffMediaType(fetched.bytes) !== "video/mp4") {
        return {
          status: "failed",
          providerFailure: videoFailure("protocol", "fal returned a clip that is not an MP4."),
          billed: true,
          ...(usage === undefined ? {} : { usage }),
        };
      }
      return {
        status: "completed",
        video: { bytes: fetched.bytes, mediaType: "video/mp4" },
        ...(usage === undefined ? {} : { usage }),
      };
    } catch (error) {
      return { status: "failed", providerFailure: asFailure(error) };
    }
  };

  const cancel = async (remoteId: string, signal?: AbortSignal): Promise<VideoAdapterPoll> => {
    const urls = urlsFor(remoteId);
    if (urls === undefined) return invalidId();
    try {
      const response = await ports.request({
        url: urls.cancel,
        method: "PUT",
        auth: AUTH,
        ...(signal === undefined ? {} : { signal }),
      });
      // 200: removed from the queue, which fal bills nothing for. 202: fal
      // signalled the runner, which decides whether to stop, so the job keeps
      // polling. 400: already done.
      if (response.status === 200) return { status: "cancelled", usage: { costUsdMicros: 0 } };
      if (response.status === 202) return { status: "running" };
      if (response.status === 400) return await poll(remoteId, signal);
      return { status: "failed", providerFailure: classifyVideoHttpFailure(response) };
    } catch (error) {
      return { status: "failed", providerFailure: asFailure(error) };
    }
  };

  // The host asks once after a terminal state; where the key may not delete
  // stored payloads, fal's own expiry (see RETENTION_HEADERS) is the fallback.
  const forget = async (remoteId: string): Promise<VideoAdapterForget> => {
    const [, requestId = ""] = remoteId.split("#");
    if (!REQUEST_ID_PATTERN.test(requestId)) return invalidId();
    try {
      // Deletes the request's stored input/output payloads and its CDN output
      // files, per fal's platform API:
      // https://fal.ai/docs/platform-apis/v1/models/requests/payloads
      const response = await ports.request({
        url: `${PLATFORM_BASE_URL}/models/requests/${requestId}/payloads`,
        method: "DELETE",
        auth: AUTH,
        signal: AbortSignal.timeout(60_000),
      });
      // A 404 means the request is already gone, which is the same outcome.
      if (response.status === 404) return { status: "removed" };
      if (!response.ok)
        return { status: "failed", providerFailure: classifyVideoHttpFailure(response) };
      const results = jsonField(await readVideoJson(response), "cdn_delete_results");
      if (
        Array.isArray(results) &&
        results.every(
          (file) =>
            typeof jsonField(file, "link") === "string" && jsonField(file, "exception") === null,
        )
      ) {
        return { status: "removed" };
      }
      return {
        status: "failed",
        providerFailure: videoFailure("unavailable", "fal did not confirm every output deletion."),
      };
    } catch (error) {
      return { status: "failed", providerFailure: asFailure(error) };
    }
  };

  return {
    models: async (signal?: AbortSignal) => {
      if (submittedModels !== undefined) return submittedModels;
      // Profile discovery must still retry a failed or partial read. Only an
      // accepted submission can use its own already-read declarations above.
      const read = await endpoints(signal);
      signal?.throwIfAborted();
      if (read.failure !== undefined) throw read.failure;
      return read.endpoints.map((endpoint) => endpoint.model);
    },
    start,
    poll: (remoteId: string, signal: AbortSignal) => poll(remoteId, signal),
    cancel,
    forget,
  };
}

/**
 * fal video driver: any fal video endpoint the person lists, with its options
 * read from the endpoint's published input schema and its price from fal's
 * pricing API. It imports only the contracts and the video seam, as a
 * third-party video plugin would.
 */
export const falVideoDriver: VideoGenerationDriver = {
  driverKind: "fal-video",
  providerName: "fal",
  providerHosts: ["queue.fal.run", "api.fal.ai", "fal.ai"],
  create: ({ profile, ports }) => createFalAdapter(profile, ports),
};
