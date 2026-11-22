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
    // 57,920 output tokens at $12/M plus 1,000 input tokens at $1.50/M.
    expect(estimate).toEqual({ kind: "estimate", usdMicros: 696_540 });
  });

  it("settles a token-priced job from the provider's reported tokens, else the estimate", () => {
    expect(settleVideoCostUsdMicros(omni.price, 696_540, { outputTokens: 28_960 })).toBe(347_520);
    expect(settleVideoCostUsdMicros(omni.price, 696_540, undefined)).toBe(696_540);
    expect(settleVideoCostUsdMicros(flat.price, 800_000, { outputTokens: 10 })).toBe(800_000);
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
