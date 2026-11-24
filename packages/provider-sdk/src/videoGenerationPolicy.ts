import {
  VIDEO_PREFERRED_DURATION_SECONDS,
  type VideoClipOptions,
  type VideoModelCapabilities,
  type VideoPrice,
} from "@octant/contracts/video-generation";

/** The images a request carries besides its prompt. */
export interface VideoRequestInputs {
  readonly firstFrame: boolean;
  readonly lastFrame: boolean;
  readonly referenceCount: number;
}

export type VideoOptionsCheck =
  | { readonly status: "allowed" }
  | { readonly status: "refused"; readonly reason: string };

export type VideoCostEstimate =
  | { readonly kind: "estimate"; readonly usdMicros: number }
  /** The model publishes no price, so an active money ceiling must refuse it. */
  | { readonly kind: "unknown" }
  /** A flat-priced model has no rate for this combination; the call is refused. */
  | { readonly kind: "no-rate" };

export interface VideoUsage {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly billedSeconds?: number;
}

/** Every whole second the model accepts, ascending. */
export function videoDurationValues(capabilities: VideoModelCapabilities): ReadonlyArray<number> {
  const durations = capabilities.durations;
  if (durations.kind === "values") return [...new Set(durations.values)].sort((a, b) => a - b);
  const values: Array<number> = [];
  for (let seconds = durations.min; seconds <= durations.max; seconds += 1) values.push(seconds);
  return values;
}

/** The audio choices the model leaves to the person. */
export function videoAudioChoices(capabilities: VideoModelCapabilities): ReadonlyArray<boolean> {
  switch (capabilities.audio) {
    case "none":
      return [false];
    case "always":
      return [true];
    case "optional":
      return [false, true];
  }
}

/** The aspect ratios offered for a request, leaving out those that need a first frame it lacks. */
export function videoAspectRatioChoices(
  capabilities: VideoModelCapabilities,
  hasFirstFrame: boolean,
): ReadonlyArray<string> {
  return capabilities.aspectRatios
    .filter((entry) => hasFirstFrame || entry.needsImage !== true)
    .map((entry) => entry.ratio);
}

/**
 * The flat rate for one combination. A rate that names the chosen audio wins
 * over one that omits audio, which applies to both choices.
 */
function perClipRate(
  price: Extract<VideoPrice, { readonly kind: "per-clip" }>,
  options: Pick<VideoClipOptions, "durationSeconds" | "resolution" | "audio">,
): number | undefined {
  const matching = price.rates.filter(
    (rate) =>
      rate.durationSeconds === options.durationSeconds && rate.resolution === options.resolution,
  );
  const exact = matching.find((rate) => rate.audio === options.audio);
  if (exact !== undefined) return exact.usdMicros;
  return matching.find((rate) => rate.audio === undefined)?.usdMicros;
}

function perSecondRate(
  price: Extract<VideoPrice, { readonly kind: "per-second" }>,
  options: Pick<VideoClipOptions, "resolution" | "audio">,
): number | undefined {
  const matching = price.rates.filter((rate) => rate.resolution === options.resolution);
  const exact = matching.find((rate) => rate.audio === options.audio);
  if (exact !== undefined) return exact.usdMicrosPerSecond;
  return matching.find((rate) => rate.audio === undefined)?.usdMicrosPerSecond;
}

function nearest(values: ReadonlyArray<number>, target: number): number | undefined {
  let best: number | undefined;
  for (const value of values) {
    if (
      best === undefined ||
      Math.abs(value - target) < Math.abs(best - target) ||
      (Math.abs(value - target) === Math.abs(best - target) && value < best)
    ) {
      best = value;
    }
  }
  return best;
}

/**
 * The options a clip starts with. For a flat-priced model the default is a
 * whole combination that has a rate, never each field chosen on its own:
 * resolution first (the declared default, else the lowest), then audio (the
 * declared default, else off), then the length nearest the declared default
 * or 8 s, a tie going to the shorter. `undefined` means no combination the
 * request can use has a rate.
 */
export function defaultVideoClipOptions(
  capabilities: VideoModelCapabilities,
  hasFirstFrame = false,
): VideoClipOptions | undefined {
  const ratios = videoAspectRatioChoices(capabilities, hasFirstFrame);
  const declaredRatio = capabilities.defaultAspectRatio;
  const aspectRatio =
    declaredRatio !== undefined && ratios.includes(declaredRatio) ? declaredRatio : ratios[0];
  if (aspectRatio === undefined) return undefined;
  const durations = videoDurationValues(capabilities);
  const targetDuration = capabilities.defaultDuration ?? VIDEO_PREFERRED_DURATION_SECONDS;
  const audioChoices = videoAudioChoices(capabilities);
  const preferredAudio =
    capabilities.audio === "optional" ? (capabilities.defaultAudio ?? false) : audioChoices[0];
  const resolutionOrder = orderedPreference(
    capabilities.resolutions,
    capabilities.defaultResolution,
  );
  const audioOrder = orderedPreference(audioChoices, preferredAudio);

  for (const resolution of resolutionOrder) {
    for (const audio of audioOrder) {
      const price = capabilities.price;
      const allowedDurations =
        price.kind === "per-clip"
          ? durations.filter(
              (durationSeconds) =>
                perClipRate(price, { durationSeconds, resolution, audio }) !== undefined,
            )
          : durations;
      const durationSeconds = nearest(allowedDurations, targetDuration);
      if (durationSeconds !== undefined) {
        return { durationSeconds, resolution, aspectRatio, audio };
      }
    }
  }
  return undefined;
}

function orderedPreference<T>(
  values: ReadonlyArray<T>,
  preferred: T | undefined,
): ReadonlyArray<T> {
  if (preferred === undefined || !values.includes(preferred)) return values;
  return [preferred, ...values.filter((value) => value !== preferred)];
}

/**
 * Whether a clip's options and inputs are within what the model declares.
 * The card, a call that skips the card, and every driver run this same check,
 * so nothing outside the declaration is reserved for or sent.
 */
export function checkVideoClipOptions(
  capabilities: VideoModelCapabilities,
  options: VideoClipOptions,
  inputs: VideoRequestInputs,
): VideoOptionsCheck {
  if (!videoDurationValues(capabilities).includes(options.durationSeconds)) {
    return refused(
      `${capabilities.displayName} does not make ${options.durationSeconds}-second clips.`,
    );
  }
  if (!capabilities.resolutions.includes(options.resolution)) {
    return refused(`${capabilities.displayName} does not offer ${options.resolution}.`);
  }
  if (!videoAspectRatioChoices(capabilities, inputs.firstFrame).includes(options.aspectRatio)) {
    return refused(
      capabilities.aspectRatios.some((entry) => entry.ratio === options.aspectRatio)
        ? `${capabilities.displayName} makes ${options.aspectRatio} clips only from a first frame.`
        : `${capabilities.displayName} does not offer ${options.aspectRatio}.`,
    );
  }
  if (!videoAudioChoices(capabilities).includes(options.audio)) {
    return refused(
      options.audio
        ? `${capabilities.displayName} does not make audio.`
        : `${capabilities.displayName} always makes audio.`,
    );
  }
  if (inputs.firstFrame && !capabilities.inputs.firstFrame) {
    return refused(`${capabilities.displayName} does not start from an image.`);
  }
  if (inputs.lastFrame && !capabilities.inputs.lastFrame) {
    return refused(`${capabilities.displayName} does not take a last frame.`);
  }
  if (inputs.referenceCount > capabilities.inputs.maxReferenceImages) {
    return refused(
      capabilities.inputs.maxReferenceImages === 0
        ? `${capabilities.displayName} does not take reference images.`
        : `${capabilities.displayName} takes at most ${capabilities.inputs.maxReferenceImages} reference images.`,
    );
  }
  if (
    capabilities.price.kind === "per-clip" &&
    perClipRate(capabilities.price, options) === undefined
  ) {
    return refused(
      `${capabilities.displayName} has no price for ${options.durationSeconds} s at ${options.resolution}${options.audio ? " with audio" : ""}.`,
    );
  }
  return { status: "allowed" };
}

function refused(reason: string): VideoOptionsCheck {
  return { status: "refused", reason };
}

/**
 * The estimate reserved before a job starts: the declared output price for
 * the chosen options plus the declared input price for the prompt and images,
 * so a clip that fits a ceiling when approved still fits it when settled.
 */
export function estimateVideoCost(
  price: VideoPrice,
  options: VideoClipOptions,
  input: { readonly promptTokens: number; readonly imageCount: number },
): VideoCostEstimate {
  switch (price.kind) {
    case "unpublished":
      return { kind: "unknown" };
    case "per-clip": {
      const rate = perClipRate(price, options);
      return rate === undefined ? { kind: "no-rate" } : { kind: "estimate", usdMicros: rate };
    }
    case "per-second": {
      const rate = perSecondRate(price, options);
      if (rate === undefined) return { kind: "unknown" };
      return {
        kind: "estimate",
        usdMicros: perSecondCostUsdMicros(price, rate, options.durationSeconds, input.imageCount),
      };
    }
    case "per-token": {
      const perSecond = price.outputTokensPerSecond.find(
        (entry) => entry.resolution === options.resolution,
      );
      if (perSecond === undefined) return { kind: "unknown" };
      const outputTokens =
        perSecond.tokens * options.durationSeconds + (price.reservedOutputTokenAllowance ?? 0);
      const inputTokens = input.promptTokens + (price.inputTokensPerImage ?? 0) * input.imageCount;
      return {
        kind: "estimate",
        usdMicros: tokenCost(price, { outputTokens, inputTokens }),
      };
    }
  }
}

function tokenCost(
  price: Extract<VideoPrice, { readonly kind: "per-token" }>,
  usage: { readonly outputTokens: number; readonly inputTokens: number },
): number {
  const output = (usage.outputTokens * price.outputUsdMicrosPerMillionTokens) / 1_000_000;
  const input = (usage.inputTokens * (price.inputUsdMicrosPerMillionTokens ?? 0)) / 1_000_000;
  return Math.ceil(output + input);
}

/**
 * Seconds at a declared per-second rate plus the fixed per-input fees the
 * estimate charges. Shared by the estimate and the settle so a job that
 * reports billed seconds pays the same inputs it was reserved for.
 */
function perSecondCostUsdMicros(
  price: Extract<VideoPrice, { readonly kind: "per-second" }>,
  usdMicrosPerSecond: number,
  seconds: number,
  imageCount: number,
): number {
  return usdMicrosPerSecond * seconds + (price.inputUsdMicrosPerImage ?? 0) * imageCount;
}

/**
 * The cost a finished job settles at: computed from the usage the provider
 * reported where the price basis can use it, else the estimate. A per-second
 * model that reports `billedSeconds` settles at those seconds times its rate
 * plus the same fixed input fees the estimate charged, never more than what
 * was reserved.
 */
export function settleVideoCostUsdMicros(
  price: VideoPrice,
  estimateUsdMicros: number,
  usage: VideoUsage | undefined,
  options: Pick<VideoClipOptions, "resolution" | "audio">,
  input: { readonly imageCount: number },
): number {
  if (usage === undefined) return estimateUsdMicros;
  if (price.kind === "per-token" && usage.outputTokens !== undefined) {
    return tokenCost(price, {
      outputTokens: usage.outputTokens,
      inputTokens: usage.inputTokens ?? 0,
    });
  }
  if (price.kind === "per-second" && usage.billedSeconds !== undefined) {
    const rate = perSecondRate(price, options);
    if (rate !== undefined) {
      return Math.min(
        estimateUsdMicros,
        perSecondCostUsdMicros(price, rate, usage.billedSeconds, input.imageCount),
      );
    }
  }
  return estimateUsdMicros;
}

/** A rough prompt token count for the estimate: about four characters a token, rounded up. */
export function estimateVideoPromptTokens(prompt: string): number {
  return Math.ceil(prompt.length / 4);
}
