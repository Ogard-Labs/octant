import { decodeVideoGenerateOffer, type VideoGenerateOffer } from "@octant/contracts";
import { describe, expect, it, vi } from "vitest";
import { videoOfferDecisionRules } from "./videoOfferDecisionRules";

function offer(overrides: Partial<Record<string, unknown>> = {}): VideoGenerateOffer {
  return decodeVideoGenerateOffer({
    offerId: "c4000000-0000-4000-8000-000000000001",
    kind: "video-generate",
    threadKind: "work-thread",
    scopeId: "c4000000-0000-4000-8000-000000000002",
    prompt: "A paper boat on a pond",
    images: [],
    profileInstanceId: "c4000000-0000-4000-8000-000000000003",
    profileName: "Gemini Video",
    providerName: "Google",
    model: {
      modelId: "gemini-omni-1.2-flash",
      displayName: "Gemini Omni Flash",
      durations: { kind: "range", min: 3, max: 15 },
      resolutions: ["720p", "1080p"],
      aspectRatios: [{ ratio: "16:9" }],
      audio: "always",
      inputs: { firstFrame: true, lastFrame: false, maxReferenceImages: 2 },
      price: {
        kind: "per-token",
        outputTokensPerSecond: [{ resolution: "720p", tokens: 5792 }],
        outputUsdMicrosPerMillionTokens: 12_000_000,
      },
      job: { cancel: "running", removal: { kind: "delete" }, resumeWindowHours: 24 },
    },
    options: { durationSeconds: 10, resolution: "720p", aspectRatio: "16:9", audio: true },
    canRemember: true,
    requestedAt: "2026-11-22T12:00:00.000Z",
    ...overrides,
  });
}

const answer = (
  generate: VideoGenerateOffer,
  options: VideoGenerateOffer["options"],
  rememberForThread = false,
) => ({
  offerId: generate.offerId,
  decision: "video-generate" as const,
  options,
  rememberForThread,
});

describe("video offer answers", () => {
  it("refuses options the offered model does not declare, so a client cannot widen them", () => {
    const pending = offer();
    const prepared = videoOfferDecisionRules({})["video-generate"](
      pending,
      answer(pending, { ...pending.options, resolution: "4k" }),
    );
    expect(prepared).toEqual({ reason: "Gemini Omni Flash does not offer 4k." });
  });

  it("keeps the profile and model only when the card could offer Don't ask again", async () => {
    const remember = vi.fn(async () => undefined);
    const rules = videoOfferDecisionRules({ kept: { remember } });
    const withImages = offer({
      canRemember: false,
      images: [{ role: "reference", label: "a.png" }],
    });
    const refused = rules["video-generate"](
      withImages,
      answer(withImages, withImages.options, true),
    );
    expect(refused).toEqual({
      outcome: { status: "video-generate", options: withImages.options, rememberForThread: false },
    });

    const pending = offer();
    const kept = rules["video-generate"](pending, answer(pending, pending.options, true));
    expect("remember" in kept && kept.remember).toBeTypeOf("function");
    if ("remember" in kept) await kept.remember?.(undefined);
    expect(remember).toHaveBeenCalledWith(
      { threadKind: "work-thread", scopeId: pending.scopeId },
      { profileInstanceId: pending.profileInstanceId, modelId: pending.model.modelId },
      undefined,
    );
  });
});
