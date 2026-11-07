import { describe, expect, it, vi } from "vitest";
import type { ImageGenerationCustomSource, ImageJob, ProviderInstance } from "@octant/contracts";
import { createImageAgentTools, IMAGE_TOOL_NAME, type ImageAgentToolPort } from "./imageAgentTools";
import type {
  ImageGenerationChoice,
  ImageGenerationOfferOutcome,
} from "./imageGenerationOfferService";

const now = "2026-08-28T12:00:00.000Z";
const scopeId = "a3000000-0000-4000-8000-000000000002" as never;
const profileId = "a3000000-0000-4000-8000-000000000001" as ProviderInstance["id"];
const parentAttachmentId = "a3000000-0000-4000-8000-000000000010";
const compatibleId = "a3000000-0000-4000-8000-000000000011" as ProviderInstance["id"];

function compatibleInstance(): ProviderInstance {
  return {
    id: compatibleId,
    displayName: "Recraft",
    enabled: true,
    environmentPolicy: "inherit-host",
    version: 1 as ProviderInstance["version"],
    createdAt: now as ProviderInstance["createdAt"],
    updatedAt: now as ProviderInstance["updatedAt"],
    driverKind: "openai-compatible",
    configuration: {
      kind: "openai-compatible-http",
      baseUrl: "https://api.recraft.ai/v1",
      authentication: "bearer",
      protocol: "auto",
      manualModelIds: [],
    },
  };
}

function imageProfile(enabled = true): ProviderInstance {
  return {
    id: profileId,
    displayName: "OpenAI Image",
    enabled,
    environmentPolicy: "inherit-host",
    version: 1 as ProviderInstance["version"],
    createdAt: now as ProviderInstance["createdAt"],
    updatedAt: now as ProviderInstance["updatedAt"],
    driverKind: "openai-image",
    configuration: {
      kind: "openai-image-http",
      modelAllowlist: ["gpt-image-2" as never],
      defaultModel: "gpt-image-2" as never,
    },
  };
}

function job(status: ImageJob["status"] = "queued"): ImageJob {
  return {
    id: "a3000000-0000-4000-8000-000000000003" as ImageJob["id"],
    status,
    threadKind: "chat-thread",
    scopeId,
    profileInstanceId: profileId,
    modelId: "gpt-image-2" as ImageJob["modelId"],
    promptHash: "a".repeat(64),
    artifacts:
      status === "completed"
        ? [
            {
              attachmentId: parentAttachmentId as ImageJob["artifacts"][number]["attachmentId"],
              hash: "b".repeat(64),
              size: 12,
              mime: "image/png",
              evidence: {
                profileInstanceId: profileId,
                modelId: "gpt-image-2" as ImageJob["modelId"],
                promptHash: "a".repeat(64),
                jobId: "a3000000-0000-4000-8000-000000000003" as ImageJob["id"],
              },
            },
          ]
        : [],
    version: 1 as ImageJob["version"],
    createdAt: now as ImageJob["createdAt"],
    updatedAt: now as ImageJob["updatedAt"],
  };
}

function tools(
  instances: ReadonlyArray<ProviderInstance>,
  jobs: ReadonlyArray<ImageJob> = [],
  customSources: ReadonlyArray<ImageGenerationCustomSource> = [],
  options: {
    readonly answer?: (
      offer: Parameters<ImageAgentToolPort["ask"]>[0]["offer"],
    ) => ImageGenerationOfferOutcome;
    readonly remembered?: ImageGenerationChoice;
    readonly refusal?: string;
  } = {},
) {
  const enqueue = vi.fn(async () => job());
  let remembered = options.remembered;
  const ask = vi.fn(
    async ({ offer }: Parameters<ImageAgentToolPort["ask"]>[0]) =>
      options.answer?.(offer) ?? ({ status: "generate", ...offer.suggested } as const),
  );
  const forget = vi.fn(() => {
    remembered = undefined;
  });
  const set = createImageAgentTools({
    threadKind: "chat-thread",
    scopeId,
    port: {
      listInstances: () => instances,
      readImageGenerationCustomSources: () => customSources,
      enqueue,
      listJobs: () => jobs,
      ask,
      remembered: () => remembered,
      forget,
      ...(options.refusal === undefined ? {} : { refusal: () => options.refusal }),
    },
  });
  return { ask, enqueue, forget, set };
}

function call(set: ReturnType<typeof tools>["set"], input: Record<string, unknown>) {
  if (set === undefined) throw new Error("The image tool was not offered.");
  return set.execute({ name: IMAGE_TOOL_NAME, inputJson: JSON.stringify(input) });
}

describe("createImageAgentTools", () => {
  it("is absent when no enabled image profile exists", () => {
    expect(tools([]).set).toBeUndefined();
    expect(tools([imageProfile(false)]).set).toBeUndefined();
  });

  it("is offered with an enabled image profile and tells the agent to prefer it over drawing SVG", () => {
    const { set } = tools([imageProfile()]);
    expect(set?.definitions.map((definition) => definition.name)).toEqual([IMAGE_TOOL_NAME]);
    expect(set?.definitions[0]?.description).toMatch(/instead of drawing one yourself as SVG/);
    expect(set?.definitions[0]?.description).toMatch(/pick the model and confirm/);
  });

  it("asks the person before generating and runs on the profile and model they chose", async () => {
    const customSources: ReadonlyArray<ImageGenerationCustomSource> = [
      { providerInstanceId: compatibleId, modelId: "recraftv3" as never, label: "Recraft" },
    ];
    const { ask, enqueue, set } = tools([imageProfile(), compatibleInstance()], [], customSources, {
      answer: () => ({
        status: "generate",
        profileInstanceId: compatibleId,
        modelId: "recraftv3" as never,
      }),
    });
    const outcome = await call(set, { prompt: "a red cube" });
    expect(ask).toHaveBeenCalledWith(
      expect.objectContaining({
        offer: {
          prompt: "a red cube",
          variantCount: 1,
          revision: false,
          suggested: { profileInstanceId: profileId, modelId: "gpt-image-2" },
        },
      }),
    );
    expect(enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ profileInstanceId: compatibleId, modelId: "recraftv3" }),
    );
    expect(outcome.result).toMatchObject({ status: "generating" });
  });

  it("preselects the second of two models on one custom instance when the agent names it", async () => {
    const customSources: ReadonlyArray<ImageGenerationCustomSource> = [
      { providerInstanceId: compatibleId, modelId: "recraftv3" as never, label: "Square" },
      { providerInstanceId: compatibleId, modelId: "recraftv3-vector" as never, label: "Vector" },
    ];
    const { ask, enqueue, set } = tools([compatibleInstance()], [], customSources);
    await call(set, {
      prompt: "a red cube",
      profileInstanceId: compatibleId,
      modelId: "recraftv3-vector",
    });
    expect(ask).toHaveBeenCalledWith(
      expect.objectContaining({
        offer: expect.objectContaining({
          suggested: { profileInstanceId: compatibleId, modelId: "recraftv3-vector" },
        }),
      }),
    );
    expect(enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ profileInstanceId: compatibleId, modelId: "recraftv3-vector" }),
    );
  });

  it("spends nothing and lets the agent draw it when the person declines the image model", async () => {
    const { enqueue, set } = tools([imageProfile()], [], [], {
      answer: () => ({ status: "agent-draws" }),
    });
    const outcome = await call(set, { prompt: "a red cube" });
    expect(enqueue).not.toHaveBeenCalled();
    expect(outcome.isError).toBeUndefined();
    expect(outcome.result).toMatchObject({ status: "agent-draws" });
  });

  it("starts nothing when the card is dismissed or left to expire", async () => {
    for (const status of ["cancelled", "expired"] as const) {
      const { enqueue, set } = tools([imageProfile()], [], [], { answer: () => ({ status }) });
      const outcome = await call(set, { prompt: "a red cube" });
      expect(enqueue).not.toHaveBeenCalled();
      expect(outcome.result).toMatchObject({ status: "cancelled" });
    }
  });

  it("generates without asking with the model this thread was told to keep using", async () => {
    const { ask, enqueue, set } = tools([imageProfile()], [], [], {
      remembered: { profileInstanceId: profileId, modelId: "gpt-image-2" as never },
    });
    await call(set, { prompt: "a red cube" });
    expect(ask).not.toHaveBeenCalled();
    expect(enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ profileInstanceId: profileId, modelId: "gpt-image-2" }),
    );
  });

  it("asks again instead of switching models when the remembered model is no longer available", async () => {
    const { ask, forget, set } = tools([imageProfile()], [], [], {
      remembered: { profileInstanceId: compatibleId, modelId: "recraftv3" as never },
    });
    await call(set, { prompt: "a red cube" });
    expect(forget).toHaveBeenCalledOnce();
    expect(ask).toHaveBeenCalledOnce();
  });

  it("refuses in Plan mode before asking anyone", async () => {
    const { ask, enqueue, set } = tools([imageProfile()], [], [], {
      refusal: "Plan mode cannot generate images.",
    });
    const outcome = await call(set, { prompt: "a red cube" });
    expect(outcome.isError).toBe(true);
    expect(ask).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("refuses credentials, endpoints, and filesystem paths before asking", async () => {
    const { ask, enqueue, set } = tools([imageProfile()]);
    const outcome = await call(set, { prompt: "a red cube", apiKey: "sk-secret" });
    expect(outcome.isError).toBe(true);
    expect(ask).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("chains a revision to the parent image on this thread and says so on the card", async () => {
    const { ask, enqueue, set } = tools([imageProfile()], [job("completed")]);
    await call(set, { prompt: "make the cube blue", parentAttachmentId });
    expect(ask).toHaveBeenCalledWith(
      expect.objectContaining({ offer: expect.objectContaining({ revision: true }) }),
    );
    expect(enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: "make the cube blue",
        parentArtifactRef: expect.objectContaining({ attachmentId: parentAttachmentId }),
      }),
    );
  });
});
