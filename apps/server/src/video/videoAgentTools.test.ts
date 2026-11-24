import {
  decodeImageGenerationScopeId,
  decodeProviderInstanceId,
  decodeVideoJob,
  decodeVideoModelCapabilities,
  type ImageGenerationSaveResult,
  type ProviderInstance,
  type VideoJob,
} from "@octant/contracts";
import { CREATE_VIDEO_TOOL_NAME } from "@octant/plugin-host/media-tools";
import { describe, expect, it, vi } from "vitest";
import { createVideoAgentTools, type VideoAgentToolPort } from "./videoAgentTools";
import type { VideoQuote } from "./videoJobService";

const now = "2026-11-22T12:00:00.000Z";
// A PNG header is enough for the reference sniff: the content is never looked at.
const PNG_FIXTURE = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const profileId = decodeProviderInstanceId("d4000000-0000-4000-8000-000000000001");
const scopeId = decodeImageGenerationScopeId("d4000000-0000-4000-8000-000000000002");
const clipId = "d4000000-0000-4000-8000-000000000004";
const model = decodeVideoModelCapabilities({
  modelId: "gemini-omni-1.2-flash",
  displayName: "Gemini Omni Flash",
  durations: { kind: "range", min: 3, max: 15 },
  defaultDuration: 10,
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
});
const instance: ProviderInstance = {
  id: profileId,
  displayName: "Gemini Video",
  enabled: true,
  environmentPolicy: "inherit-host",
  version: 1 as ProviderInstance["version"],
  createdAt: now as ProviderInstance["createdAt"],
  updatedAt: now as ProviderInstance["updatedAt"],
  driverKind: "gemini-video",
  configuration: {
    kind: "gemini-video-http",
    modelAllowlist: [model.modelId],
    defaultModel: model.modelId,
  },
};

const finished: VideoJob = decodeVideoJob({
  id: "d4000000-0000-4000-8000-000000000003",
  status: "completed",
  threadKind: "work-thread",
  scopeId,
  profileInstanceId: profileId,
  driverKind: "gemini-video",
  modelId: model.modelId,
  promptHash: "a".repeat(64),
  options: { durationSeconds: 10, resolution: "720p", aspectRatio: "16:9", audio: true },
  imageCount: 0,
  estimatedCostUsdMicros: 695_040,
  clip: {
    clipId,
    hash: "b".repeat(64),
    size: 2048,
    durationSeconds: 10,
    resolution: "720p",
    aspectRatio: "16:9",
  },
  providerCopy: "removed",
  version: 2,
  createdAt: now,
  updatedAt: now,
});

// The same job while the provider is still working on it, for a call that
// leaves its wait.
const running: VideoJob = decodeVideoJob({
  id: finished.id,
  status: "running",
  threadKind: "work-thread",
  scopeId,
  profileInstanceId: profileId,
  driverKind: "gemini-video",
  modelId: model.modelId,
  promptHash: "a".repeat(64),
  options: { durationSeconds: 10, resolution: "720p", aspectRatio: "16:9", audio: true },
  imageCount: 0,
  estimatedCostUsdMicros: 695_040,
  remoteId: "remote-1",
  providerCopy: "held",
  version: 1,
  createdAt: now,
  updatedAt: now,
});

function harness(options: {
  readonly kept?: {
    readonly profileInstanceId: typeof profileId;
    readonly modelId: typeof model.modelId;
  };
  readonly fullAccess?: boolean;
  readonly asksAgain?: boolean;
  readonly posture?: "refuse" | "ask" | "allow";
  readonly answer?: Awaited<ReturnType<VideoAgentToolPort["askGenerate"]>>;
  readonly pending?: boolean;
  readonly waitMs?: number;
  readonly refusal?: () => string | undefined;
  readonly frameRead?: () => Promise<Uint8Array | undefined>;
  readonly readClip?: () => Promise<Uint8Array>;
}) {
  const quote = vi.fn(
    async (input: { readonly options: { readonly resolution: string } }): Promise<VideoQuote> =>
      model.resolutions.includes(input.options.resolution)
        ? {
            status: "ready",
            driverKind: "gemini-video",
            profileName: "Gemini Video",
            providerName: "Google",
            model,
            estimate: { kind: "estimate", usdMicros: 695_040 },
          }
        : {
            status: "refused",
            reason: `Gemini Omni Flash does not offer ${input.options.resolution}.`,
          },
  );
  const enqueue = vi.fn(async () => (options.pending === true ? running : finished));
  const stop = vi.fn();
  const askGenerate = vi.fn(async () => options.answer ?? { status: "cancelled" as const });
  const askSave = vi.fn(async () => ({ status: "video-save" as const }));
  const write = vi.fn(
    async (relativePath: string): Promise<ImageGenerationSaveResult> => ({
      status: "saved",
      relativePath,
    }),
  );
  const set = createVideoAgentTools({
    threadKind: "work-thread",
    scopeId,
    port: {
      jobs: {
        readyProfilesNow: () => [{ instance, models: [model] }],
        quote,
        enqueue,
        stop,
        whenTerminal: options.pending === true ? () => new Promise(() => {}) : async () => finished,
        listByScope: () => [finished],
        readClip: async () => (await options.readClip?.()) ?? new Uint8Array(2048),
      },
      ...(options.refusal === undefined ? {} : { refusal: options.refusal }),
      imageSources: {
        latestAttachments: () =>
          options.frameRead === undefined
            ? []
            : [
                {
                  label: "photo.png",
                  name: "photo.png",
                  size: PNG_FIXTURE.length,
                  read: options.frameRead,
                },
              ],
      },
      ...(options.waitMs === undefined ? {} : { waitMs: options.waitMs }),
      askGenerate,
      askSave,
      remembered: () => options.kept,
      asksAgain: () => options.asksAgain === true,
      forget: () => undefined,
      fullAccess: () => options.fullAccess === true,
      save: { posture: () => options.posture ?? "ask", write },
    },
  });
  if (set === undefined) throw new Error("The video tool was not offered.");
  const call = (input: Record<string, unknown>, signal?: AbortSignal) =>
    set.execute({
      name: CREATE_VIDEO_TOOL_NAME,
      inputJson: JSON.stringify(input),
      ...(signal === undefined ? {} : { signal }),
    });
  return { call, quote, enqueue, stop, askGenerate, askSave, write };
}

describe("octant_create_video on the host", () => {
  it("asks on a card with the model's defaults and makes the clip with the person's choices", async () => {
    const chosen = { durationSeconds: 5, resolution: "1080p", aspectRatio: "16:9", audio: true };
    const { call, askGenerate, enqueue } = harness({
      answer: { status: "video-generate", options: chosen, rememberForThread: false },
    });
    await call({ prompt: "A paper boat on a pond" });
    expect(askGenerate).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "video-generate",
        profileInstanceId: profileId,
        options: { durationSeconds: 10, resolution: "720p", aspectRatio: "16:9", audio: true },
        canRemember: true,
        images: [],
      }),
      expect.any(AbortSignal),
    );
    expect(enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ profileInstanceId: profileId, options: chosen, references: [] }),
    );
  });

  it("starts without a card where the Project keeps a choice, and sends nothing a person declined", async () => {
    const kept = harness({ kept: { profileInstanceId: profileId, modelId: model.modelId } });
    await kept.call({ prompt: "A paper boat on a pond" });
    expect(kept.askGenerate).not.toHaveBeenCalled();
    expect(kept.enqueue).toHaveBeenCalledOnce();

    const declined = harness({});
    await declined.call({ prompt: "A paper boat on a pond" });
    expect(declined.askGenerate).toHaveBeenCalledOnce();
    expect(declined.enqueue).not.toHaveBeenCalled();
  });

  it("asks again at Full access after the Project drops its video choice", async () => {
    const { call, askGenerate, enqueue } = harness({ fullAccess: true, asksAgain: true });
    await call({ prompt: "A paper boat on a pond" });
    expect(askGenerate).toHaveBeenCalledOnce();
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("refuses options the model does not declare before any card or job", async () => {
    const { call, askGenerate, enqueue } = harness({ fullAccess: true });
    await call({ prompt: "A paper boat on a pond", resolution: "4k" });
    expect(askGenerate).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("stops the clip a stopped turn was waiting on, while a timed-out wait leaves it running", async () => {
    const options = { durationSeconds: 5, resolution: "720p", aspectRatio: "16:9", audio: true };
    const stopped = harness({
      pending: true,
      answer: { status: "video-generate", options, rememberForThread: false },
    });
    const controller = new AbortController();
    const outcome = stopped.call({ prompt: "A paper boat on a pond" }, controller.signal);
    await vi.waitFor(() => expect(stopped.enqueue).toHaveBeenCalled());
    controller.abort();
    expect((await outcome).result).toMatchObject({ status: "generating" });
    expect(stopped.stop).toHaveBeenCalledWith(running.id);

    const slow = harness({
      pending: true,
      waitMs: 1,
      answer: { status: "video-generate", options, rememberForThread: false },
    });
    expect((await slow.call({ prompt: "A paper boat on a pond" })).result).toMatchObject({
      status: "generating",
    });
    expect(slow.stop).not.toHaveBeenCalled();
  });

  it("saves a finished clip at the turn's level: asks first, and Plan refuses", async () => {
    const asking = harness({ posture: "ask" });
    await asking.call({ operation: "save", clipId, relativePath: "media/boat.mp4" });
    expect(asking.askSave).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "video-save",
        relativePath: "media/boat.mp4",
        sizeBytes: 2048,
      }),
      expect.any(AbortSignal),
    );
    expect(asking.write).toHaveBeenCalledWith("media/boat.mp4", expect.any(Uint8Array));

    const plan = harness({ posture: "refuse" });
    await plan.call({ operation: "save", clipId, relativePath: "media/boat.mp4" });
    expect(plan.write).not.toHaveBeenCalled();
  });

  it("writes nothing when the turn is stopped once the clip is read or the card answered", async () => {
    const stoppedWhileReading = harness({ posture: "allow" });
    const readController = new AbortController();
    readController.abort();
    const readOutcome = await stoppedWhileReading.call(
      { operation: "save", clipId, relativePath: "media/boat.mp4" },
      readController.signal,
    );
    expect(readOutcome.result).toMatchObject({ status: "not-saved" });
    expect(stoppedWhileReading.write).not.toHaveBeenCalled();

    const stoppedAtCard = harness({ posture: "ask" });
    const cardController = new AbortController();
    stoppedAtCard.askSave.mockImplementation(async () => {
      cardController.abort();
      return { status: "video-save" as const };
    });
    const cardOutcome = await stoppedAtCard.call(
      { operation: "save", clipId, relativePath: "media/boat.mp4" },
      cardController.signal,
    );
    expect(cardOutcome.result).toMatchObject({ status: "not-saved" });
    expect(stoppedAtCard.write).not.toHaveBeenCalled();
  });

  it("writes nothing when the turn stops while the clip is being read", async () => {
    let releaseRead: ((bytes: Uint8Array) => void) | undefined;
    const { call, write } = harness({
      posture: "allow",
      readClip: () =>
        new Promise((resolve) => {
          releaseRead = resolve;
        }),
    });
    const controller = new AbortController();
    const outcome = call(
      { operation: "save", clipId, relativePath: "media/boat.mp4" },
      controller.signal,
    );
    await vi.waitFor(() => expect(releaseRead).toBeDefined());
    controller.abort();
    releaseRead?.(new Uint8Array(2048));
    expect((await outcome).result).toMatchObject({ status: "not-saved" });
    expect(write).not.toHaveBeenCalled();
  });

  it("spends nothing when the thread moved to Plan while a frame was being read", async () => {
    let plan = false;
    const { call, enqueue } = harness({
      answer: {
        status: "video-generate",
        options: { durationSeconds: 10, resolution: "720p", aspectRatio: "16:9", audio: true },
        rememberForThread: false,
      },
      refusal: () => (plan ? "Plan mode cannot make videos." : undefined),
      frameRead: async () => {
        // The thread's standing dropped while the frame loaded.
        plan = true;
        return PNG_FIXTURE;
      },
    });
    const outcome = await call({
      prompt: "A paper boat on a pond",
      firstFrame: { kind: "attachment", name: "photo.png" },
    });
    expect(outcome.isError).toBe(true);
    expect(outcome.result).toMatchObject({ error: "Plan mode cannot make videos." });
    expect(enqueue).not.toHaveBeenCalled();
  });
});
