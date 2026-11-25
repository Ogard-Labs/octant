import { decodeVideoGenerateOffer } from "@octant/contracts";
import { describe, expect, it } from "vitest";
import { describeVideoOffer, videoOfferChoices } from "./serviceOfferChoices";

const offer = (job: Record<string, unknown>, price: Record<string, unknown>) =>
  decodeVideoGenerateOffer({
    offerId: "c5000000-0000-4000-8000-000000000001",
    kind: "video-generate",
    threadKind: "chat-thread",
    scopeId: "c5000000-0000-4000-8000-000000000002",
    prompt: "A paper boat on a pond",
    images: [],
    profileInstanceId: "c5000000-0000-4000-8000-000000000003",
    profileName: "Video",
    providerName: "Example",
    model: {
      modelId: "clip-1",
      displayName: "Clip One",
      durations: { kind: "values", values: [5, 10] },
      resolutions: ["720p"],
      aspectRatios: [{ ratio: "16:9" }, { ratio: "1:1", needsImage: true }],
      audio: "optional",
      inputs: { firstFrame: true, lastFrame: false, maxReferenceImages: 0 },
      price,
      job,
    },
    options: { durationSeconds: 10, resolution: "720p", aspectRatio: "16:9", audio: false },
    canRemember: true,
    requestedAt: "2026-11-22T12:00:00.000Z",
  });

describe("video card description", () => {
  it("states the price for the chosen options and what Stop cannot do", () => {
    const pending = offer(
      { cancel: "none", removal: { kind: "expires", afterHours: 24 }, resumeWindowHours: 24 },
      {
        kind: "per-second",
        rates: [{ resolution: "720p", audio: false, usdMicrosPerSecond: 70_000 }],
      },
    );
    expect(describeVideoOffer(pending, pending.options)).toEqual({
      price: "About $0.70 for 10 s at 720p, billed by Example.",
      stop: "Stop ends the wait; Example may still finish and bill the clip.",
      retention: "Example receives the prompt and keeps them for up to 24 hours.",
      approvable: true,
    });
  });

  it("only offers lengths within the model's limit for both frames", () => {
    const pending = offer(
      { cancel: "running", removal: { kind: "delete" }, resumeWindowHours: 24 },
      {
        kind: "per-second",
        rates: [{ resolution: "720p", usdMicrosPerSecond: 70_000 }],
      },
    );
    const first = { role: "first-frame", label: "First photo" } as const;
    const last = { role: "last-frame", label: "Last photo" } as const;
    const model = {
      ...pending.model,
      durations: { kind: "range", min: 3, max: 15 } as const,
      inputs: {
        ...pending.model.inputs,
        lastFrame: true,
        maxDurationSecondsWithBothFrames: 10,
      },
    };
    const one = { ...pending, model, images: [first] };
    const options = { ...pending.options, durationSeconds: 11 };
    expect(videoOfferChoices(one).durations).toContain(15);
    expect(describeVideoOffer(one, options).approvable).toBe(true);
    const both = { ...pending, model, images: [first, last] };
    expect(videoOfferChoices(both).durations).toEqual([3, 4, 5, 6, 7, 8, 9, 10]);
    expect(describeVideoOffer(both, options).approvable).toBe(false);
  });

  it("offers only what the model declares and cannot approve an unpublished combination", () => {
    const pending = offer(
      { cancel: "running", removal: { kind: "delete" }, resumeWindowHours: 24 },
      {
        kind: "per-clip",
        rates: [{ durationSeconds: 5, resolution: "720p", audio: false, usdMicros: 300_000 }],
      },
    );
    expect(videoOfferChoices(pending)).toEqual({
      durations: [5, 10],
      resolutions: ["720p"],
      aspectRatios: ["16:9"],
      audio: [false, true],
    });
    expect(describeVideoOffer(pending, pending.options)).toMatchObject({
      price: "Clip One has no published price for 10 s at 720p.",
      approvable: false,
    });
  });
});
