import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  decodeAggregateVersion,
  decodeProjectId,
  type ImageGenerationCustomSource,
  type ImageJob,
  type ProviderInstance,
} from "@octant/contracts";
import { Journal } from "../persistence/journal";
import { applyMigrations, MIGRATIONS } from "../persistence/migrations";
import { createPhase1RuntimeRegistries } from "../persistence/runtimeRegistry";
import { openSqlite } from "../persistence/sqlitePort";
import { SpendCeilingService } from "../spendCeilingService";
import { checkNewFileUnder, saveGeneratedImageUnder } from "./generatedImageSave";
import { GeneratedImageStore } from "./generatedImageStore";
import { createImageAgentTools, IMAGE_TOOL_NAME, type ImageAgentToolPort } from "./imageAgentTools";
import type {
  ImageGenerationChoice,
  ImageGenerationOfferOutcome,
} from "./imageGenerationOfferService";
import { ImageJobService } from "./imageJobService";
import { imageOfferDecisionRules } from "./imageOfferDecisionRules";

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
    ) => ImageGenerationOfferOutcome | Promise<ImageGenerationOfferOutcome>;
    readonly imageSources?: ImageAgentToolPort["imageSources"];
    readonly readArtifact?: NonNullable<ImageAgentToolPort["readArtifact"]>;
    readonly remembered?: ImageGenerationChoice;
    readonly fullAccess?: boolean;
    readonly defaultProfileInstanceId?: string;
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
    readonly iconSets?: ImageAgentToolPort["iconSets"];
  } = {},
) {
  const enqueue = vi.fn<ImageAgentToolPort["enqueue"]>(async () => job());
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
      ...(options.imageSources === undefined ? {} : { imageSources: options.imageSources }),
      ...(options.fullAccess === undefined
        ? {}
        : { fullAccess: () => options.fullAccess === true }),
      ...(options.defaultProfileInstanceId === undefined
        ? {}
        : { defaultProfileInstanceId: () => options.defaultProfileInstanceId }),
      ...(options.unattended === undefined ? {} : { unattended: options.unattended }),
      ...(options.refusal === undefined ? {} : { refusal: options.refusal }),
      ...(options.iconSets === undefined ? {} : { iconSets: options.iconSets }),
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
      ...(options.readArtifact === undefined ? {} : { readArtifact: options.readArtifact }),
    },
  });
  return { ask, enqueue, forget, set };
}

function call(set: ReturnType<typeof tools>["set"], input: Record<string, unknown>) {
  if (set === undefined) throw new Error("The image tool was not offered.");
  return set.execute({ name: IMAGE_TOOL_NAME, inputJson: JSON.stringify(input) });
}

describe("createImageAgentTools", () => {
  it("names the attached image and reads no bytes until the person chooses Generate", async () => {
    const bytes = Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10);
    const read = vi.fn(async () => bytes);
    let approve: (value: ImageGenerationOfferOutcome) => void = () => undefined;
    const answer = new Promise<ImageGenerationOfferOutcome>((resolve) => {
      approve = resolve;
    });
    const { ask, enqueue, set } = tools([imageProfile()], [], [], {
      answer: () => answer,
      fullAccess: true,
      imageSources: {
        latestAttachments: () => [
          { label: "your attached photo cat.png", size: bytes.length, read },
        ],
      },
    });
    const result = call(set, { prompt: "Restyle the photo", references: [{ kind: "attachment" }] });
    await vi.waitFor(() => expect(ask).toHaveBeenCalledOnce());
    expect(ask.mock.calls[0]?.[0].offer).toMatchObject({
      references: [{ kind: "attachment", label: "your attached photo cat.png" }],
    });
    expect(read).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
    approve({
      status: "generate",
      profileInstanceId: profileId,
      modelId: "gpt-image-2" as never,
    });
    await result;
    expect(read).toHaveBeenCalledOnce();
    expect(enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ references: [{ mediaType: "image/png", bytes }] }),
    );
  });

  it("includes the parent among explicit references and never forwards both forms", async () => {
    const bytes = Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3, 4);
    const read = vi.fn(async () => bytes);
    const readArtifact = vi.fn(async () => ({ bytes, mime: "image/png" as const }));
    const { ask, enqueue, set } = tools([imageProfile()], [job("completed")], [], {
      imageSources: { latestAttachments: () => [{ label: "cat.png", size: bytes.length, read }] },
      readArtifact,
    });
    await call(set, {
      prompt: "Combine the images",
      parentAttachmentId,
      references: [{ kind: "attachment" }],
    });
    expect(ask.mock.calls[0]?.[0].offer).toMatchObject({
      references: [
        { kind: "generated-image", label: "generated image" },
        { kind: "attachment", label: "cat.png" },
      ],
    });
    expect(readArtifact).toHaveBeenCalledOnce();
    expect(enqueue.mock.calls).toHaveLength(1);
    expect(enqueue.mock.calls[0]).toEqual([
      expect.objectContaining({
        references: Array.from({ length: 2 }, () => ({ mediaType: "image/png", bytes })),
      }),
    ]);
    expect(enqueue.mock.calls[0]?.[0]).not.toHaveProperty("parentArtifactRef");
  });

  it("refuses when no reference-capable profile is ready, even if another image profile is enabled", async () => {
    const bfl = {
      ...imageProfile(),
      driverKind: "bfl-image",
      configuration: {
        kind: "bfl-image-http",
        modelAllowlist: ["flux-pro" as never],
        defaultModel: "flux-pro" as never,
      },
    } satisfies ProviderInstance;
    const { ask, enqueue, set } = tools([bfl]);
    await expect(
      call(set, { prompt: "Restyle the photo", references: [{ kind: "attachment" }] }),
    ).resolves.toMatchObject({
      result: { error: "No enabled image model can use reference images." },
    });
    expect(ask).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("does not send images if the chosen profile stops supporting references before they are read", async () => {
    const instances = [imageProfile()];
    const read = vi.fn(async () => Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10));
    const { enqueue, set } = tools(instances, [], [], {
      imageSources: { latestAttachments: () => [{ label: "cat.png", size: 8, read }] },
      answer: (offer) => {
        if (offer.kind !== "generate") throw new Error("Expected a generation request.");
        instances[0] = {
          ...imageProfile(),
          driverKind: "bfl-image",
          configuration: {
            kind: "bfl-image-http",
            modelAllowlist: [offer.suggested.modelId],
            defaultModel: offer.suggested.modelId,
          },
        };
        return { status: "generate", ...offer.suggested };
      },
    });
    await expect(
      call(set, { prompt: "Restyle the photo", references: [{ kind: "attachment" }] }),
    ).resolves.toMatchObject({ isError: true });
    expect(read).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
  });

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

  it("generates at Full access on the profile Settings names when several are ready and nothing is kept", async () => {
    const { ask, enqueue, set } = tools(
      [imageProfile(), compatibleInstance()],
      [],
      [{ providerInstanceId: compatibleId, modelId: "recraftv3" as never, label: "Recraft" }],
      { fullAccess: true, defaultProfileInstanceId: String(compatibleId) },
    );
    await call(set, { prompt: "a red cube" });
    expect(ask).not.toHaveBeenCalled();
    expect(enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ profileInstanceId: compatibleId, modelId: "recraftv3" }),
    );
  });

  it("still asks below Full access when several image profiles are ready and nothing is kept", async () => {
    const { ask, set } = tools(
      [imageProfile(), compatibleInstance()],
      [],
      [{ providerInstanceId: compatibleId, modelId: "recraftv3" as never, label: "Recraft" }],
      { fullAccess: false, defaultProfileInstanceId: String(compatibleId) },
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

  describe("saving an icon set from an image the thread made", () => {
    const folders: Array<string> = [];
    afterEach(() => {
      for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
    });
    const webIcons = ["favicon-16.png", "favicon-32.png", "apple-touch-icon.png"];
    /** A real folder and the host's own confined check and write, with a stand-in resizer. */
    function iconSetFolder(posture: "refuse" | "ask" | "allow") {
      const root = mkdtempSync(join(tmpdir(), "octant-icon-set-"));
      folders.push(root);
      const write = vi.fn((relativePath: string, bytes: Uint8Array) =>
        saveGeneratedImageUnder({ root, relativePath, bytes }),
      );
      return {
        root,
        write,
        save: { posture: () => posture, write },
        iconSets: {
          render: vi.fn(async () => ({
            status: "rendered" as const,
            files: webIcons.map((path) => ({ path, bytes: Uint8Array.from([1, 2, 3]) })),
          })),
          check: (relativePath: string) => checkNewFileUnder({ root, relativePath }),
        },
      };
    }
    const iconSet = {
      operation: "icon-set",
      attachmentId: parentAttachmentId,
      target: "web",
      directory: "public",
    };

    it("writes every file at once at a level that lets edits through, with the web snippets", async () => {
      const folder = iconSetFolder("allow");
      const { ask, set } = tools([imageProfile()], [job("completed")], [], folder);
      const outcome = await call(set, iconSet);
      expect(ask).not.toHaveBeenCalled();
      expect(outcome.result).toMatchObject({
        status: "saved",
        directory: "public",
        files: webIcons.map((name) => `public/${name}`),
        html: expect.stringContaining('rel="apple-touch-icon"'),
        manifestIcons: expect.stringContaining("/icon-512.png"),
      });
      expect(readdirSync(join(folder.root, "public")).sort()).toEqual([...webIcons].sort());
    });

    it("writes nothing when any one of the files already exists", async () => {
      const folder = iconSetFolder("allow");
      mkdirSync(join(folder.root, "public"));
      writeFileSync(join(folder.root, "public", "apple-touch-icon.png"), "mine");
      const { set } = tools([imageProfile()], [job("completed")], [], folder);
      const outcome = await call(set, iconSet);
      expect(outcome.isError).toBe(true);
      expect(outcome.result).toMatchObject({
        error: expect.stringContaining("public/apple-touch-icon.png already exists"),
      });
      expect(folder.write).not.toHaveBeenCalled();
      expect(readdirSync(join(folder.root, "public"))).toEqual(["apple-touch-icon.png"]);
    });

    it("refuses a directory outside the folder before resizing anything", async () => {
      const folder = iconSetFolder("allow");
      const { set } = tools([imageProfile()], [job("completed")], [], folder);
      const outcome = await call(set, { ...iconSet, directory: "../elsewhere" });
      expect(outcome.isError).toBe(true);
      expect(folder.iconSets.render).not.toHaveBeenCalled();
      expect(folder.write).not.toHaveBeenCalled();
    });

    it("asks with the directory and file count at Ask first, and writes nothing on no", async () => {
      const folder = iconSetFolder("ask");
      const { ask, set } = tools([imageProfile()], [job("completed")], [], {
        ...folder,
        answer: () => ({ status: "cancelled" }),
      });
      const outcome = await call(set, iconSet);
      expect(ask).toHaveBeenCalledWith(
        expect.objectContaining({
          offer: expect.objectContaining({ kind: "save", relativePath: "public", fileCount: 3 }),
        }),
      );
      expect(outcome.result).toMatchObject({ status: "not-saved" });
      expect(existsSync(join(folder.root, "public"))).toBe(false);
    });

    it("refuses in Plan without resizing, and a source the resizer refuses", async () => {
      const plan = iconSetFolder("refuse");
      const inPlan = tools([imageProfile()], [job("completed")], [], plan);
      expect((await call(inPlan.set, iconSet)).result).toMatchObject({
        error: expect.stringMatching(/Plan mode/),
      });
      expect(plan.iconSets.render).not.toHaveBeenCalled();

      const folder = iconSetFolder("allow");
      folder.iconSets.render.mockResolvedValueOnce({
        status: "refused",
        reason: "Icon sets need a square image; this one is 1024×768.",
      } as never);
      const square = tools([imageProfile()], [job("completed")], [], folder);
      expect((await call(square.set, iconSet)).result).toMatchObject({
        error: expect.stringMatching(/square/),
      });
      expect(folder.write).not.toHaveBeenCalled();
    });

    it("stops when the thread moves to Plan between files and names what it had written", async () => {
      const folder = iconSetFolder("allow");
      let level: "allow" | "refuse" = "allow";
      const write = vi.fn(async (relativePath: string, bytes: Uint8Array) => {
        const saved = await folder.write(relativePath, bytes);
        level = "refuse";
        return saved;
      });
      const { set } = tools([imageProfile()], [job("completed")], [], {
        ...folder,
        save: { posture: () => level, write },
      });
      const outcome = await call(set, iconSet);
      expect(write).toHaveBeenCalledOnce();
      expect(outcome.isError).toBe(true);
      expect(outcome.result).toMatchObject({
        status: "failed",
        error: expect.stringMatching(/Plan mode/),
        written: ["public/favicon-16.png"],
      });
      expect(readdirSync(join(folder.root, "public"))).toEqual(["favicon-16.png"]);
    });

    it("writes no further file once the turn is stopped, and names what it had written", async () => {
      const folder = iconSetFolder("allow");
      const stop = new AbortController();
      const write = vi.fn(async (relativePath: string, bytes: Uint8Array) => {
        const saved = await folder.write(relativePath, bytes);
        stop.abort();
        return saved;
      });
      const { set } = tools([imageProfile()], [job("completed")], [], {
        ...folder,
        save: { posture: () => "allow", write },
      });
      if (set === undefined) throw new Error("The image tool was not offered.");
      const outcome = await set.execute({
        name: IMAGE_TOOL_NAME,
        inputJson: JSON.stringify(iconSet),
        signal: stop.signal,
      });
      expect(write).toHaveBeenCalledOnce();
      expect(outcome.result).toMatchObject({
        status: "failed",
        error: expect.stringMatching(/stopped/),
        written: ["public/favicon-16.png"],
      });
    });

    it("stops when the level drops to Ask first mid-set without consent", async () => {
      const folder = iconSetFolder("allow");
      let level: "allow" | "ask" = "allow";
      const write = vi.fn(async (relativePath: string, bytes: Uint8Array) => {
        const saved = await folder.write(relativePath, bytes);
        level = "ask";
        return saved;
      });
      const { ask, set } = tools([imageProfile()], [job("completed")], [], {
        ...folder,
        save: { posture: () => level, write },
      });
      const outcome = await call(set, iconSet);
      expect(ask).not.toHaveBeenCalled();
      expect(write).toHaveBeenCalledOnce();
      expect(outcome.result).toMatchObject({
        status: "failed",
        error: expect.stringMatching(/asks before edits/),
        written: ["public/favicon-16.png"],
      });
    });

    it("names the failed path and the files already written when a write fails", async () => {
      const folder = iconSetFolder("allow");
      let calls = 0;
      const write = vi.fn(async (relativePath: string, bytes: Uint8Array) => {
        calls += 1;
        return calls === 2
          ? { status: "failed" as const, reason: "The disk is full." }
          : folder.write(relativePath, bytes);
      });
      const { set } = tools([imageProfile()], [job("completed")], [], {
        ...folder,
        save: { posture: () => "allow", write },
      });
      const outcome = await call(set, iconSet);
      expect(outcome.result).toMatchObject({
        status: "failed",
        error: expect.stringMatching(/public\/favicon-32\.png: The disk is full/),
        written: ["public/favicon-16.png"],
      });
    });

    it("refuses an Android set where a launcher icon exists in another format", async () => {
      const folder = iconSetFolder("allow");
      folder.iconSets.render.mockResolvedValueOnce({
        status: "rendered",
        files: [
          {
            path: "mipmap-hdpi/ic_launcher.png",
            bytes: Uint8Array.from([1]),
            conflicts: ["mipmap-hdpi/ic_launcher.webp"],
          },
        ],
      } as never);
      mkdirSync(join(folder.root, "res", "mipmap-hdpi"), { recursive: true });
      writeFileSync(join(folder.root, "res", "mipmap-hdpi", "ic_launcher.webp"), "existing");
      const { set } = tools([imageProfile()], [job("completed")], [], folder);
      const outcome = await call(set, { ...iconSet, target: "android", directory: "res" });
      expect(outcome.result).toMatchObject({
        error: expect.stringContaining("res/mipmap-hdpi/ic_launcher.webp already exists"),
      });
      expect(folder.write).not.toHaveBeenCalled();
    });

    it("saves into the folder itself when the directory is .", async () => {
      const folder = iconSetFolder("allow");
      const { set } = tools([imageProfile()], [job("completed")], [], folder);
      const outcome = await call(set, { ...iconSet, directory: "." });
      expect(outcome.result).toMatchObject({ status: "saved", files: webIcons });
      expect(existsSync(join(folder.root, "favicon-16.png"))).toBe(true);
    });

    it("is not offered where the host cannot resize images", async () => {
      const folder = iconSetFolder("allow");
      const { set } = tools([imageProfile()], [job("completed")], [], { save: folder.save });
      expect(JSON.stringify(set?.definitions)).not.toContain("icon-set");
      expect((await call(set, iconSet)).result).toMatchObject({
        error: "The operation is generate or save.",
      });
      const offered = tools([imageProfile()], [job("completed")], [], folder);
      expect(JSON.stringify(offered.set?.definitions)).toContain("icon-set");
    });
  });

  describe("spend ceiling enforcement on agent image generation", () => {
    const directories: Array<string> = [];
    const projectId = "a3000000-0000-4000-8000-000000000092";

    afterEach(() => {
      for (const directory of directories.splice(0)) {
        rmSync(directory, { recursive: true, force: true });
      }
    });

    it("still asks for consent and refuses without calling the provider when a thread or Project monetary ceiling cannot cover the chosen model", async () => {
      const directory = mkdtempSync(join(tmpdir(), "octant-image-tool-ceiling-"));
      directories.push(directory);
      const connection = openSqlite(join(directory, "octant.sqlite3"));
      applyMigrations(connection, MIGRATIONS, () => now);
      const runtime = createPhase1RuntimeRegistries();
      const journal = new Journal({
        connection,
        registry: runtime.events,
        projections: runtime.projections,
        clock: () => now,
      });
      const spendCeiling = new SpendCeilingService({
        connection,
        journal,
        clock: () => now,
        uuid: () => crypto.randomUUID(),
        threadExists: () => true,
        projectExists: () => true,
      });
      const generate = vi.fn(async () => ({
        status: "completed" as const,
        images: [
          {
            bytes: Uint8Array.from([0x89, 0x50, 0x4e, 0x47]),
            mediaType: "image/png" as const,
          },
        ],
      }));
      const profile = imageProfile();
      const jobs = new ImageJobService({
        journal,
        projection: runtime.imageJobProjection,
        attachments: new GeneratedImageStore(directory),
        readProviderInstance: (id) => (String(id) === String(profile.id) ? profile : undefined),
        readImageGenerationCustomSources: () => [],
        credentialResolver: { has: async () => true, resolve: async () => "sk-test" },
        uuid: () => crypto.randomUUID(),
        clock: () => now,
        actor: { kind: "system", actorId: "00000000-0000-4000-8000-000000000002" as never },
        createAdapter: () => ({ generate }),
        spendCeiling,
        resolveThreadProjectId: () => projectId,
      });
      const ask = vi.fn(async ({ offer }: Parameters<ImageAgentToolPort["ask"]>[0]) =>
        offer.kind === "generate"
          ? ({ status: "generate", ...offer.suggested } as const)
          : ({ status: "cancelled" } as const),
      );
      const set = createImageAgentTools({
        threadKind: "chat-thread",
        scopeId,
        port: {
          listInstances: () => [profile],
          readImageGenerationCustomSources: () => [],
          enqueue: (input) => jobs.enqueue(input),
          listJobs: (id) => jobs.listByScope(id),
          whenTerminal: (id) => jobs.whenTerminal(id),
          ask,
          remembered: () => undefined,
          forget: () => undefined,
        },
      });

      // Thread ceiling blocks after consent without calling the provider.
      spendCeiling.execute("local-window", {
        kind: "set-spend-ceiling",
        scope: { kind: "thread", threadType: "chat-thread", threadId: String(scopeId) },
        expectedVersion: decodeAggregateVersion(0),
        policy: { costBudgetUsdCents: 2 },
        window: { kind: "lifetime" },
      });
      const threadOutcome = await call(set, { prompt: "a red cube" });
      expect(ask).toHaveBeenCalledTimes(1);
      expect(threadOutcome.isError).toBe(true);
      expect(threadOutcome.result).toMatchObject({
        error: expect.stringMatching(/money ceiling/i),
      });

      // Clear thread ceiling; Project ceiling still blocks without calling the provider.
      spendCeiling.execute("local-window", {
        kind: "clear-spend-ceiling",
        scope: { kind: "thread", threadType: "chat-thread", threadId: String(scopeId) },
        expectedVersion: decodeAggregateVersion(1),
      });
      spendCeiling.execute("local-window", {
        kind: "set-spend-ceiling",
        scope: { kind: "project", projectId: decodeProjectId(projectId) },
        expectedVersion: decodeAggregateVersion(0),
        policy: { costBudgetUsdCents: 2 },
        window: { kind: "calendar", period: "day", timeZone: "UTC" },
      });
      const projectOutcome = await call(set, { prompt: "a red cube" });
      expect(ask).toHaveBeenCalledTimes(2);
      expect(projectOutcome.isError).toBe(true);
      expect(projectOutcome.result).toMatchObject({
        error: expect.stringMatching(/Project's money ceiling/i),
      });
      expect(generate).not.toHaveBeenCalled();
    });
  });

  it("excludes outside image drivers from offers and decisions when references exceed 2.5 MiB", async () => {
    const outsideId = "a3000000-0000-4000-8000-000000000099" as ProviderInstance["id"];
    const outside: ProviderInstance = {
      id: outsideId,
      displayName: "Example Outside Image",
      enabled: true,
      environmentPolicy: "inherit-host",
      version: 1 as ProviderInstance["version"],
      createdAt: now as ProviderInstance["createdAt"],
      updatedAt: now as ProviderInstance["updatedAt"],
      driverKind: "outside-image",
      configuration: {
        kind: "outside-image",
        driver: {
          extensionId: "00000000-0000-4000-8000-000000000099" as never,
          packageId: "example.outside-image" as never,
          componentId: "driver" as never,
          version: "1.0.0" as never,
          digest: `sha256:${"a".repeat(64)}` as never,
        },
        baseUrl: "https://images.example.test",
        key: { header: "authorization", scheme: "Bearer" },
        modelAllowlist: ["outside-edit" as never],
        defaultModel: "outside-edit" as never,
      },
    };
    const read = vi.fn(async () => Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10));
    const oversizedSource = {
      latestAttachments: () => [{ label: "big.png", size: 2_621_441, read }],
    };

    // Only outside profile enabled: refuses upfront without opening a card or reading bytes.
    const onlyOutside = createImageAgentTools({
      threadKind: "chat-thread",
      scopeId,
      port: {
        listInstances: () => [outside],
        admitsOutsideImageDriver: () => true,
        readImageGenerationCustomSources: () => [],
        enqueue: vi.fn(async () => job()),
        listJobs: () => [],
        ask: vi.fn(),
        remembered: () => undefined,
        forget: () => undefined,
        imageSources: oversizedSource,
      },
    });
    await expect(
      call(onlyOutside, { prompt: "Restyle", references: [{ kind: "attachment" }] }),
    ).resolves.toMatchObject({
      isError: true,
      result: {
        error: "Reference images for an outside image driver cannot exceed 2.5 MiB combined.",
      },
    });
    expect(read).not.toHaveBeenCalled();

    // Outside + bundled enabled: offer preselects bundled and passes referenceBytes.
    const ask = vi.fn(async () => ({ status: "cancelled" as const }));
    const both = createImageAgentTools({
      threadKind: "chat-thread",
      scopeId,
      port: {
        listInstances: () => [outside, imageProfile()],
        admitsOutsideImageDriver: () => true,
        readImageGenerationCustomSources: () => [],
        enqueue: vi.fn(async () => job()),
        listJobs: () => [],
        ask,
        remembered: () => undefined,
        forget: () => undefined,
        imageSources: oversizedSource,
      },
    });
    await call(both, { prompt: "Restyle", references: [{ kind: "attachment" }] });
    expect(ask).toHaveBeenCalledWith(
      expect.objectContaining({
        referenceBytes: 2_621_441,
        offer: expect.objectContaining({
          suggested: { profileInstanceId: profileId, modelId: "gpt-image-2" },
        }),
      }),
    );

    // Server decision rules also refuse manually selecting the outside profile on an >2.5 MiB offer.
    const rules = imageOfferDecisionRules({
      listInstances: () => [outside, imageProfile()],
      admitsOutsideImageDriver: () => true,
      readImageGenerationSettings: () => ({ customSources: [] }),
      referenceBytesForOffer: () => 2_621_441,
    });
    const offer = {
      kind: "generate" as const,
      offerId: "offer-1" as never,
      threadKind: "chat-thread" as const,
      scopeId,
      prompt: "Restyle",
      variantCount: 1,
      revision: false,
      suggested: { profileInstanceId: profileId, modelId: "gpt-image-2" as never },
      references: [{ kind: "attachment" as const, label: "big.png" }],
      requestedAt: now as never,
    };
    expect(
      rules.generate(offer, {
        offerId: offer.offerId,
        decision: "generate",
        profileInstanceId: outsideId,
        modelId: "outside-edit" as never,
        rememberForThread: false,
        referenceImagesConfirmed: true,
      }),
    ).toEqual({
      reason:
        "Outside image drivers accept at most 2.5 MiB of reference images combined. Choose another model.",
    });
    expect(
      rules.generate(offer, {
        offerId: offer.offerId,
        decision: "generate",
        profileInstanceId: profileId,
        modelId: "gpt-image-2" as never,
        rememberForThread: false,
        referenceImagesConfirmed: true,
      }),
    ).toMatchObject({
      outcome: { status: "generate", profileInstanceId: profileId, modelId: "gpt-image-2" },
    });

    // A large parent-only revision asks without erasing a remembered outside choice.
    const completed = job("completed");
    const firstArtifact = completed.artifacts[0];
    if (firstArtifact === undefined) throw new Error("Expected completed job artifact.");
    const bigParentJob: ImageJob = {
      ...completed,
      artifacts: [{ ...firstArtifact, size: 3_000_000 }],
    };
    const forget = vi.fn();
    const enqueue = vi.fn(async () => job());
    const askRevision = vi.fn(async () => ({ status: "cancelled" as const }));
    const rememberedOutside: ImageGenerationChoice = {
      profileInstanceId: outsideId,
      modelId: "outside-edit" as never,
    };
    const revisionTools = createImageAgentTools({
      threadKind: "chat-thread",
      scopeId,
      port: {
        listInstances: () => [outside, imageProfile()],
        admitsOutsideImageDriver: () => true,
        readImageGenerationCustomSources: () => [],
        enqueue,
        listJobs: () => [bigParentJob],
        ask: askRevision,
        remembered: () => rememberedOutside,
        forget,
      },
    });
    const declined = await call(revisionTools, {
      prompt: "Make it brighter",
      parentAttachmentId,
    });
    expect(declined.result).toMatchObject({ status: "cancelled" });
    expect(askRevision).toHaveBeenCalledOnce();
    expect(forget).not.toHaveBeenCalled();

    // A later prompt-only generation still uses the remembered outside choice without asking.
    await call(revisionTools, { prompt: "A quiet harbor" });
    expect(askRevision).toHaveBeenCalledOnce();
    expect(enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        profileInstanceId: outsideId,
        modelId: "outside-edit",
      }),
    );
  });
});
