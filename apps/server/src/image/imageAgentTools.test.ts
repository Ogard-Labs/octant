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
    readonly fullAccess?: boolean;
    /** A turn the host runs as itself, with nobody at a window to answer a card. */
    readonly unattended?: boolean;
    readonly refusal?: () => string | undefined;
    readonly finished?: Promise<ImageJob>;
    readonly bytes?: Uint8Array;
    readonly readsImages?: boolean;
    readonly waitMs?: number;
    /** Runs while the image is read, as a level change arriving meanwhile would. */
    readonly whileReading?: () => void;
    readonly save?: {
      readonly posture: () => "refuse" | "ask" | "allow";
      readonly write: (
        relativePath: string,
        bytes: Uint8Array,
      ) => Promise<
        | { readonly status: "saved"; readonly relativePath: string }
        | { readonly status: "refused" | "failed"; readonly reason: string }
      >;
    };
  } = {},
) {
  const enqueue = vi.fn(async () => job());
  let remembered = options.remembered;
  const ask = vi.fn(
    async ({ offer }: Parameters<ImageAgentToolPort["ask"]>[0]) =>
      options.answer?.(offer) ??
      (offer.kind === "generate"
        ? ({ status: "generate", ...offer.suggested } as const)
        : ({ status: "save" } as const)),
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
      ...(options.fullAccess === undefined
        ? {}
        : { fullAccess: () => options.fullAccess === true }),
      ...(options.unattended === undefined ? {} : { unattended: options.unattended }),
      ...(options.refusal === undefined ? {} : { refusal: options.refusal }),
      ...(options.save === undefined
        ? {}
        : {
            save: options.save,
            readArtifact: async () => {
              options.whileReading?.();
              return {
                bytes: Uint8Array.from([0x89, 0x50, 0x4e, 0x47]),
                mime: "image/png" as const,
              };
            },
          }),
      ...(options.finished === undefined
        ? {}
        : {
            whenTerminal: () => options.finished as Promise<ImageJob>,
            readArtifact: async () => ({
              bytes: options.bytes ?? Uint8Array.from([0x89, 0x50, 0x4e, 0x47]),
              mime: "image/png" as const,
            }),
            readsImages: () => options.readsImages === true,
            ...(options.waitMs === undefined ? {} : { waitMs: options.waitMs }),
          }),
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
          kind: "generate",
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

  it("starts nothing when the card is dismissed", async () => {
    const { enqueue, set } = tools([imageProfile()], [], [], {
      answer: () => ({ status: "cancelled" }),
    });
    const outcome = await call(set, { prompt: "a red cube" });
    expect(enqueue).not.toHaveBeenCalled();
    expect(outcome.result).toMatchObject({ status: "cancelled" });
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

  it("generates without asking at Full access when exactly one image profile is ready", async () => {
    const { ask, enqueue, set } = tools([imageProfile()], [], [], { fullAccess: true });
    await call(set, { prompt: "a red cube" });
    expect(ask).not.toHaveBeenCalled();
    expect(enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ profileInstanceId: profileId, modelId: "gpt-image-2" }),
    );
  });

  it("asks at Full access when two image profiles are ready and nothing is kept", async () => {
    const { ask, set } = tools(
      [imageProfile(), compatibleInstance()],
      [],
      [{ providerInstanceId: compatibleId, modelId: "recraftv3" as never, label: "Recraft" }],
      { fullAccess: true },
    );
    await call(set, { prompt: "a red cube" });
    expect(ask).toHaveBeenCalledOnce();
  });

  it("asks at Full access rather than swap in the only profile when the kept model is gone", async () => {
    const { ask, forget, set } = tools([imageProfile()], [], [], {
      fullAccess: true,
      remembered: { profileInstanceId: compatibleId, modelId: "recraftv3" as never },
    });
    await call(set, { prompt: "a red cube" });
    expect(forget).toHaveBeenCalledOnce();
    expect(ask).toHaveBeenCalledOnce();
  });

  it("drops a kept choice that can no longer run in a turn nobody attends, and starts nothing", async () => {
    const { ask, enqueue, forget, set } = tools([imageProfile()], [], [], {
      unattended: true,
      remembered: { profileInstanceId: compatibleId, modelId: "recraftv3" as never },
    });
    const outcome = await call(set, { prompt: "a red cube" });
    expect(forget).toHaveBeenCalledOnce();
    expect(ask).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
    expect(outcome).toMatchObject({ isError: true });
  });

  it("refuses in Plan mode before asking anyone", async () => {
    const { ask, enqueue, set } = tools([imageProfile()], [], [], {
      refusal: () => "Plan mode cannot generate images.",
    });
    const outcome = await call(set, { prompt: "a red cube" });
    expect(outcome.isError).toBe(true);
    expect(ask).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("spends nothing when the thread moved to Plan while the card was open", async () => {
    let plan = false;
    const { enqueue, set } = tools([imageProfile()], [], [], {
      refusal: () => (plan ? "Plan mode cannot generate images." : undefined),
      answer: (offer) => {
        plan = true;
        return offer.kind === "generate"
          ? { status: "generate", ...offer.suggested }
          : { status: "cancelled" };
      },
    });
    const outcome = await call(set, { prompt: "a red cube" });
    expect(outcome.isError).toBe(true);
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

  describe("after the person chooses Generate", () => {
    it("waits for the image and shows it to a model that reads images", async () => {
      const { set } = tools([imageProfile()], [], [], {
        finished: Promise.resolve(job("completed")),
        readsImages: true,
      });
      const outcome = await call(set, { prompt: "a red cube" });
      expect(outcome.result).toMatchObject({
        status: "completed",
        images: [{ attachmentId: parentAttachmentId, mime: "image/png" }],
      });
      expect(outcome.images).toEqual([{ mimeType: "image/png", data: "iVBORw==" }]);
    });

    it("names the finished image without showing it to a model that cannot read images", async () => {
      const { set } = tools([imageProfile()], [], [], {
        finished: Promise.resolve(job("completed")),
        readsImages: false,
      });
      const outcome = await call(set, { prompt: "a red cube" });
      expect(outcome.images).toBeUndefined();
      expect(outcome.result).toMatchObject({
        status: "completed",
        message: expect.stringMatching(/do not describe what they look like/),
      });
    });

    it("leaves out an image too large for the provider's image channel and says so", async () => {
      const { set } = tools([imageProfile()], [], [], {
        finished: Promise.resolve(job("completed")),
        readsImages: true,
        bytes: new Uint8Array(1_600_000),
      });
      const outcome = await call(set, { prompt: "a red cube" });
      expect(outcome.images).toBeUndefined();
      expect(outcome.result).toMatchObject({ status: "completed" });
    });

    it("reports the provider's refusal when the job fails", async () => {
      const failed: ImageJob = {
        ...job("queued"),
        status: "failed",
        safetyRefusal: "The provider declined this prompt.",
      };
      const { set } = tools([imageProfile()], [], [], { finished: Promise.resolve(failed) });
      const outcome = await call(set, { prompt: "a red cube" });
      expect(outcome.isError).toBe(true);
      expect(outcome.result).toMatchObject({
        status: "failed",
        message: "The provider declined this prompt.",
      });
    });

    it("answers that the image is still generating when it takes longer than the call waits", async () => {
      const { set } = tools([imageProfile()], [], [], {
        finished: new Promise<ImageJob>(() => undefined),
        waitMs: 5,
      });
      const outcome = await call(set, { prompt: "a red cube" });
      expect(outcome.result).toMatchObject({ status: "generating" });
    });
  });

  describe("saving an image the thread made", () => {
    function saving(posture: "refuse" | "ask" | "allow") {
      let level = posture;
      const write = vi.fn(async (relativePath: string) => ({
        status: "saved" as const,
        relativePath,
      }));
      return {
        write,
        setLevel: (next: typeof posture) => {
          level = next;
        },
        save: { posture: () => level, write },
      };
    }
    const save = {
      operation: "save",
      attachmentId: parentAttachmentId,
      relativePath: "art/cube.png",
    };

    it("writes it at once at a level that lets edits through", async () => {
      const { save: port, write } = saving("allow");
      const { ask, set } = tools([imageProfile()], [job("completed")], [], { save: port });
      const outcome = await call(set, save);
      expect(ask).not.toHaveBeenCalled();
      expect(write).toHaveBeenCalledWith("art/cube.png", Uint8Array.from([0x89, 0x50, 0x4e, 0x47]));
      expect(outcome.result).toEqual({ status: "saved", relativePath: "art/cube.png" });
    });

    it("asks with the path first at Ask first, and writes nothing when the person says no", async () => {
      const { save: port, write } = saving("ask");
      const { ask, set } = tools([imageProfile()], [job("completed")], [], {
        save: port,
        answer: () => ({ status: "cancelled" }),
      });
      const outcome = await call(set, save);
      expect(ask).toHaveBeenCalledWith(
        expect.objectContaining({
          offer: expect.objectContaining({ kind: "save", relativePath: "art/cube.png" }),
        }),
      );
      expect(write).not.toHaveBeenCalled();
      expect(outcome.result).toMatchObject({ status: "not-saved" });
    });

    it("writes after the person confirms, unless the thread moved to Plan meanwhile", async () => {
      const confirmed = saving("ask");
      const asked = tools([imageProfile()], [job("completed")], [], { save: confirmed.save });
      await call(asked.set, save);
      expect(confirmed.write).toHaveBeenCalledOnce();

      const moved = saving("ask");
      const planned = tools([imageProfile()], [job("completed")], [], {
        save: moved.save,
        answer: () => {
          moved.setLevel("refuse");
          return { status: "save" };
        },
      });
      const outcome = await call(planned.set, save);
      expect(outcome.isError).toBe(true);
      expect(moved.write).not.toHaveBeenCalled();
    });

    it("follows a level lowered while the image was being read", async () => {
      const toPlan = saving("allow");
      const planned = tools([imageProfile()], [job("completed")], [], {
        save: toPlan.save,
        whileReading: () => toPlan.setLevel("refuse"),
      });
      expect((await call(planned.set, save)).isError).toBe(true);
      expect(toPlan.write).not.toHaveBeenCalled();

      const toAsk = saving("allow");
      const asked = tools([imageProfile()], [job("completed")], [], {
        save: toAsk.save,
        whileReading: () => toAsk.setLevel("ask"),
        answer: () => ({ status: "cancelled" }),
      });
      const outcome = await call(asked.set, save);
      expect(asked.ask).toHaveBeenCalledOnce();
      expect(outcome.result).toMatchObject({ status: "not-saved" });
      expect(toAsk.write).not.toHaveBeenCalled();
    });

    it("refuses in Plan, in a thread with no folder, and for an image the thread did not make", async () => {
      const plan = saving("refuse");
      const inPlan = tools([imageProfile()], [job("completed")], [], { save: plan.save });
      expect((await call(inPlan.set, save)).isError).toBe(true);

      const chat = tools([imageProfile()], [job("completed")]);
      expect((await call(chat.set, save)).result).toMatchObject({
        error: expect.stringMatching(/no folder/),
      });

      const other = saving("allow");
      const elsewhere = tools([imageProfile()], [], [], { save: other.save });
      expect((await call(elsewhere.set, save)).isError).toBe(true);
      expect(plan.write).not.toHaveBeenCalled();
      expect(other.write).not.toHaveBeenCalled();
    });
  });
});
