import {
  decodeVideoModelCapabilities,
  type VideoModelCapabilities,
} from "@octant/contracts/video-generation";
import { describe, expect, it } from "vitest";
import {
  checkVideoClipOptions,
  defaultVideoClipOptions,
  estimateVideoCost,
  settleVideoCostUsdMicros,
  videoAspectRatioChoices,
  videoDurationValues,
} from "./videoGenerationPolicy";

const noInputs = { firstFrame: false, lastFrame: false, referenceCount: 0 };

const omni: VideoModelCapabilities = decodeVideoModelCapabilities({
  modelId: "gemini-omni-1.2-flash",
  displayName: "Gemini Omni Flash",
  durations: { kind: "range", min: 3, max: 15 },
  defaultDuration: 10,
  resolutions: ["360p", "720p", "1080p", "4k"],
  defaultResolution: "720p",
  aspectRatios: [{ ratio: "16:9" }, { ratio: "9:16" }],
  audio: "always",
  inputs: { firstFrame: true, lastFrame: true, maxReferenceImages: 6 },
  price: {
    kind: "per-token",
    outputTokensPerSecond: [
      { resolution: "720p", tokens: 5792 },
      { resolution: "1080p", tokens: 8688 },
    ],
    outputUsdMicrosPerMillionTokens: 12_000_000,
    inputUsdMicrosPerMillionTokens: 1_500_000,
    reservedOutputTokenAllowance: 1024,
  },
  job: { cancel: "running", removal: { kind: "delete" }, resumeWindowHours: 1320 },
});

const flat: VideoModelCapabilities = decodeVideoModelCapabilities({
  modelId: "flat-model",
  displayName: "Flat Model",
  durations: { kind: "values", values: [5, 10] },
  resolutions: ["480p", "720p", "1080p"],
  aspectRatios: [{ ratio: "16:9" }, { ratio: "21:9", needsImage: true }],
  audio: "optional",
  defaultAudio: true,
  inputs: { firstFrame: true, lastFrame: false, maxReferenceImages: 0 },
  price: {
    kind: "per-clip",
    rates: [
      { durationSeconds: 5, resolution: "720p", usdMicros: 400_000 },
      { durationSeconds: 10, resolution: "720p", audio: true, usdMicros: 1_000_000 },
      { durationSeconds: 10, resolution: "720p", usdMicros: 800_000 },
    ],
  },
  job: { cancel: "none", removal: { kind: "expires", afterHours: 24 }, resumeWindowHours: 24 },
});

const timed: VideoModelCapabilities = decodeVideoModelCapabilities({
  modelId: "timed-model",
  displayName: "Timed Model",
  durations: { kind: "range", min: 2, max: 15 },
  resolutions: ["720p", "1080p"],
  aspectRatios: [{ ratio: "16:9" }],
  audio: "none",
  inputs: { firstFrame: false, lastFrame: false, maxReferenceImages: 0 },
  price: {
    kind: "per-second",
    rates: [{ resolution: "720p", usdMicrosPerSecond: 100_000 }],
  },
  job: { cancel: "running", removal: { kind: "delete" }, resumeWindowHours: 24 },
});

describe("video generation policy", () => {
  it("starts a clip at the model's declared defaults", () => {
    expect(defaultVideoClipOptions(omni)).toEqual({
      durationSeconds: 10,
      resolution: "720p",
      aspectRatio: "16:9",
      audio: true,
    });
  });

  it("defaults a flat-priced model to a whole combination that has a rate", () => {
    // 480p has no rate at all, so the lowest priced resolution wins; audio on
    // is the declared default; 10 s is nearest 8 s among the priced lengths,
    // and the 5/10 tie at 7.5 never arises because 8 is closer to 10.
    expect(defaultVideoClipOptions(flat)).toEqual({
      durationSeconds: 10,
      resolution: "720p",
      aspectRatio: "16:9",
      audio: true,
    });
  });

  it("offers a ratio that needs a first frame only once an image is chosen", () => {
    expect(videoAspectRatioChoices(flat, false)).toEqual(["16:9"]);
    expect(videoAspectRatioChoices(flat, true)).toEqual(["16:9", "21:9"]);
    expect(
      checkVideoClipOptions(
        flat,
        { durationSeconds: 10, resolution: "720p", aspectRatio: "21:9", audio: false },
        noInputs,
      ),
    ).toEqual({
      status: "refused",
      reason: "Flat Model makes 21:9 clips only from a first frame.",
    });
  });

  it("limits choices and defaults only when a clip uses both frames", () => {
    const model = {
      ...omni,
      defaultDuration: 15,
      inputs: { ...omni.inputs, maxDurationSecondsWithBothFrames: 10 },
    };
    const first = { ...noInputs, firstFrame: true };
    const both = { ...first, lastFrame: true };
    const options = { durationSeconds: 11, resolution: "720p", aspectRatio: "16:9", audio: true };
    expect(videoDurationValues(model, first)).toContain(15);
    expect(videoDurationValues(model, both)).toContain(10);
    expect(videoDurationValues(model, both)).not.toContain(11);
    expect(defaultVideoClipOptions(model, both.firstFrame, both.lastFrame)?.durationSeconds).toBe(
      10,
    );
    expect(checkVideoClipOptions(model, options, first).status).toBe("allowed");
    expect(checkVideoClipOptions(model, options, both).status).toBe("refused");
  });

  it("refuses options outside what the model declares", () => {
    const base = { durationSeconds: 10, resolution: "720p", aspectRatio: "16:9", audio: true };
    expect(checkVideoClipOptions(omni, { ...base, durationSeconds: 20 }, noInputs).status).toBe(
      "refused",
    );
    expect(checkVideoClipOptions(omni, { ...base, audio: false }, noInputs)).toEqual({
      status: "refused",
      reason: "Gemini Omni Flash always makes audio.",
    });
    expect(checkVideoClipOptions(omni, base, { ...noInputs, referenceCount: 7 }).status).toBe(
      "refused",
    );
    expect(checkVideoClipOptions(omni, base, noInputs)).toEqual({ status: "allowed" });
  });

  it("refuses a flat-priced combination with no rate before anything is reserved", () => {
    const options = { durationSeconds: 5, resolution: "1080p", aspectRatio: "16:9", audio: false };
    expect(checkVideoClipOptions(flat, options, noInputs).status).toBe("refused");
    expect(estimateVideoCost(flat.price, options, { promptTokens: 0, imageCount: 0 })).toEqual({
      kind: "no-rate",
    });
  });

  it("prefers a flat rate that names the chosen audio over one that omits it", () => {
    const options = { durationSeconds: 10, resolution: "720p", aspectRatio: "16:9", audio: true };
    expect(estimateVideoCost(flat.price, options, { promptTokens: 0, imageCount: 0 })).toEqual({
      kind: "estimate",
      usdMicros: 1_000_000,
    });
    expect(
      estimateVideoCost(
        flat.price,
        { ...options, audio: false },
        { promptTokens: 0, imageCount: 0 },
      ),
    ).toEqual({ kind: "estimate", usdMicros: 800_000 });
  });

  it("estimates a token-priced clip from its output and input tokens", () => {
    const estimate = estimateVideoCost(
      omni.price,
      { durationSeconds: 10, resolution: "720p", aspectRatio: "16:9", audio: true },
      { promptTokens: 1000, imageCount: 0 },
    );
    // 57,920 video tokens plus the 1,024-token reserved allowance at $12/M,
    // and 1,000 input tokens at $1.50/M.
    expect(estimate).toEqual({ kind: "estimate", usdMicros: 708_828 });
  });

  it("reserves enough for the thinking tokens a token-priced job bills", () => {
    const options = { durationSeconds: 8, resolution: "720p", aspectRatio: "16:9", audio: true };
    const estimate = estimateVideoCost(omni.price, options, {
      promptTokens: 12,
      imageCount: 0,
    });
    // 46,336 video tokens plus the 1,024 reserved at $12/M, and 12 input
    // tokens at $1.50/M.
    expect(estimate).toEqual({ kind: "estimate", usdMicros: 568_338 });
    const settleOptions = { resolution: "720p", audio: true };
    const settled = settleVideoCostUsdMicros(
      omni.price,
      568_338,
      // The provider's reported usage carries 40 billed thinking tokens on
      // top of the video's tokens.
      { outputTokens: 46_336 + 40, inputTokens: 12 },
      settleOptions,
      { imageCount: 0 },
    );
    expect(settled).toBeLessThanOrEqual(568_338);
  });

  const noImages = { imageCount: 0 } as const;

  it("settles a token-priced job from the provider's reported tokens, else the estimate", () => {
    const options = { resolution: "720p", audio: true };
    expect(
      settleVideoCostUsdMicros(omni.price, 696_540, { outputTokens: 28_960 }, options, noImages),
    ).toBe(347_520);
    expect(settleVideoCostUsdMicros(omni.price, 696_540, undefined, options, noImages)).toBe(
      696_540,
    );
    expect(
      settleVideoCostUsdMicros(flat.price, 800_000, { outputTokens: 10 }, options, noImages),
    ).toBe(800_000);
  });

  it("settles a per-second job at the billed seconds, capped at the reservation", () => {
    // A 10 s reservation at 100,000 µs/s whose provider billed 2 s pays for 2 s.
    const estimate = estimateVideoCost(
      timed.price,
      { durationSeconds: 10, resolution: "720p", aspectRatio: "16:9", audio: false },
      { promptTokens: 0, imageCount: 0 },
    );
    expect(estimate).toEqual({ kind: "estimate", usdMicros: 1_000_000 });
    const options = { resolution: "720p", audio: false };
    expect(
      settleVideoCostUsdMicros(timed.price, 1_000_000, { billedSeconds: 2 }, options, noImages),
    ).toBe(200_000);
    expect(
      settleVideoCostUsdMicros(timed.price, 1_000_000, { billedSeconds: 12 }, options, noImages),
    ).toBe(1_000_000);
    expect(settleVideoCostUsdMicros(timed.price, 1_000_000, undefined, options, noImages)).toBe(
      1_000_000,
    );
  });

  it("settles billed seconds plus the input image fees the estimate charged", () => {
    const priced = {
      kind: "per-second" as const,
      rates: [{ resolution: "720p", usdMicrosPerSecond: 100_000 }] as const,
      inputUsdMicrosPerImage: 20_000,
    };
    // Two input images add 40,000 µs to both the reservation and the settle.
    expect(
      estimateVideoCost(
        priced,
        { durationSeconds: 10, resolution: "720p", aspectRatio: "16:9", audio: false },
        { promptTokens: 0, imageCount: 2 },
      ),
    ).toEqual({ kind: "estimate", usdMicros: 1_040_000 });
    const options = { resolution: "720p", audio: false };
    const input = { imageCount: 2 };
    expect(settleVideoCostUsdMicros(priced, 1_040_000, { billedSeconds: 2 }, options, input)).toBe(
      240_000,
    );
    expect(settleVideoCostUsdMicros(priced, 1_040_000, { billedSeconds: 12 }, options, input)).toBe(
      1_040_000,
    );
  });

  it("settles at a cost the provider reports, and a single-rate clip from its billed seconds", () => {
    const perSecond = {
      kind: "per-second" as const,
      rates: [{ resolution: "720p", usdMicrosPerSecond: 120_000 }] as const,
    };
    const options = { resolution: "720p", audio: false };
    expect(
      settleVideoCostUsdMicros(perSecond, 600_000, { costUsdMicros: 480_000 }, options, noImages),
    ).toBe(480_000);
    expect(
      settleVideoCostUsdMicros(perSecond, 600_000, { billedSeconds: 4 }, options, noImages),
    ).toBe(480_000);
    expect(
      settleVideoCostUsdMicros(omni.price, 696_540, { costUsdMicros: 100 }, options, noImages),
    ).toBe(100);
  });

  it("treats an unpublished price as unknown spend", () => {
    expect(
      estimateVideoCost(
        { kind: "unpublished" },
        { durationSeconds: 5, resolution: "720p", aspectRatio: "16:9", audio: false },
        { promptTokens: 0, imageCount: 0 },
      ),
    ).toEqual({ kind: "unknown" });
  });
});
