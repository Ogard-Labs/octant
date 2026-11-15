import { describe, expect, it, vi } from "vitest";
import {
  MAX_IMAGE_DESCRIPTION_CHARACTERS,
  type NativeHarnessRoutingConfiguration,
  type NativeHarnessSlotCandidate,
  type Project,
} from "@octant/contracts";
import {
  ImageDescriber,
  type ImageDescriberCandidateFacts,
  type ImageDescriberSources,
} from "./imageDescription";
import type { OneShotOutcome } from "./nativeHarnessSingleShot";

const hostId = "00000000-0000-4000-8000-0000000000aa";
const candidate = (provider: string, modelId: string) =>
  ({
    hostId,
    providerInstanceId: `00000000-0000-4000-8000-0000000000${provider}`,
    modelId,
  }) as unknown as NativeHarnessSlotCandidate;
const haiku = candidate("e1", "haiku");
const flash = candidate("e2", "flash");
const local = candidate("e3", "llava");
const vision = (candidates: ReadonlyArray<NativeHarnessSlotCandidate>) =>
  ({
    slots: [{ id: "vision", candidates }],
    jobSlots: [],
  }) as unknown as NativeHarnessRoutingConfiguration;
const project = { id: "project-1", type: "code" } as unknown as Project;
const image = { name: "login.png", mediaType: "image/png", bytes: new Uint8Array([1, 2, 3]) };

const fixture = (input: {
  readonly host?: NativeHarnessRoutingConfiguration;
  readonly project?: NativeHarnessRoutingConfiguration;
  readonly facts?: (candidate: NativeHarnessSlotCandidate) => Partial<ImageDescriberCandidateFacts>;
  readonly takesImage?: (candidate: NativeHarnessSlotCandidate) => boolean;
  readonly outcomes?: ReadonlyArray<OneShotOutcome>;
  readonly spend?: ImageDescriberSources["spend"];
}) => {
  let next = 0;
  const complete = vi.fn(
    async (_request: unknown): Promise<OneShotOutcome> =>
      input.outcomes?.[next++] ?? { status: "completed", text: "A sign-in form." },
  );
  const describer = new ImageDescriber({
    roles: (projectId) => ({
      host: input.host ?? { slots: [], jobSlots: [] },
      ...(projectId === undefined ? {} : { project: input.project }),
    }),
    readProject: () => project,
    candidateFacts: (_project, model) => ({
      label: String(model.modelId),
      providerName: `Provider ${String(model.providerInstanceId).slice(-2)}`,
      allowed: true,
      ...input.facts?.(model),
    }),
    takesImage: (model) => input.takesImage?.(model) ?? true,
    resolveDriver: () => ({}) as never,
    scratchRoot: "/scratch",
    uuid: () => "00000000-0000-4000-8000-000000000042",
    complete: complete as never,
    ...(input.spend === undefined ? {} : { spend: input.spend }),
  });
  return { describer, complete };
};

describe("Sees images", () => {
  it("sends the image to the Project's own Sees images model before Settings', with the image attached", async () => {
    const { describer, complete } = fixture({ host: vision([flash]), project: vision([haiku]) });
    const outcome = await describer.describe({
      projectId: "project-1" as never,
      threadModel: "Luna",
      image,
      question: "Is there an error?",
    });
    expect(outcome).toEqual({
      kind: "described",
      text: "A sign-in form.",
      describedBy: { model: "haiku", provider: "Provider e1" },
    });
    expect(complete).toHaveBeenCalledWith(
      expect.objectContaining({
        modelId: "haiku",
        projectRoot: "/scratch",
        attachments: [
          expect.objectContaining({ mediaType: "image/png", displayName: "login.png" }),
        ],
        prompt: expect.stringContaining("Is there an error?"),
      }),
    );
  });

  it("falls back to the next model when the main one does not answer", async () => {
    const { describer, complete } = fixture({
      host: vision([haiku, flash]),
      outcomes: [{ status: "timed-out" }, { status: "completed", text: "A chart." }],
    });
    const outcome = await describer.describe({ threadModel: "Luna", image });
    expect(outcome).toMatchObject({ kind: "described", describedBy: { model: "flash" } });
    expect(complete).toHaveBeenCalledTimes(2);
  });

  it("never sends an image to a model the Project's data rules refuse, and says why when none is left", async () => {
    const { describer, complete } = fixture({
      host: vision([haiku, flash]),
      facts: (model) => (model === haiku ? { allowed: false } : {}),
    });
    await expect(
      describer.describe({ projectId: "project-1" as never, threadModel: "Luna", image }),
    ).resolves.toMatchObject({ describedBy: { model: "flash" } });
    expect(complete).toHaveBeenCalledOnce();

    const none = fixture({ host: vision([haiku]), facts: () => ({ allowed: false }) });
    const refused = await none.describer.describe({
      projectId: "project-1" as never,
      threadModel: "Luna",
      image,
    });
    expect(refused.kind).toBe("refused");
    expect(refused.kind === "refused" ? refused.reason : "").toContain(
      "haiku (Provider e1): not allowed by this Project's provider policy or data rules",
    );
    expect(none.complete).not.toHaveBeenCalled();
  });

  it("passes over a model whose connection takes no image from Octant, with that reason", async () => {
    const { describer, complete } = fixture({ host: vision([local]), takesImage: () => false });
    const outcome = await describer.describe({ threadModel: "Luna", image });
    expect(outcome.kind === "refused" ? outcome.reason : "").toContain(
      "its connection does not take images from Octant",
    );
    expect(complete).not.toHaveBeenCalled();
  });

  it("refuses with the plain fix when Sees images has no model, and never uses the Builder's", async () => {
    const builder = {
      slots: [{ id: "default", candidates: [haiku] }],
      jobSlots: [],
    } as unknown as NativeHarnessRoutingConfiguration;
    const { describer, complete } = fixture({ host: builder });
    await expect(describer.describe({ threadModel: "Luna", image })).resolves.toEqual({
      kind: "refused",
      reason: "Luna can't read images. Set a model that sees images in Model roles.",
    });
    expect(describer.available({ threadModel: "Luna" }).kind).toBe("refused");
    expect(complete).not.toHaveBeenCalled();
  });

  it("does not use an answer that read outside content, and bounds a long one", async () => {
    const withheld = fixture({ host: vision([haiku]), outcomes: [{ status: "withheld" }] });
    await expect(
      withheld.describer.describe({ threadModel: "Luna", image }),
    ).resolves.toMatchObject({
      kind: "refused",
    });
    const long = fixture({
      host: vision([haiku]),
      outcomes: [{ status: "completed", text: "word ".repeat(5_000) }],
    });
    const outcome = await long.describer.describe({ threadModel: "Luna", image });
    expect(outcome.kind === "described" ? outcome.text.length : 0).toBe(
      MAX_IMAGE_DESCRIPTION_CHARACTERS,
    );
  });

  it("refuses an image that is not a picture it can send before asking anyone", async () => {
    const { describer, complete } = fixture({ host: vision([haiku]) });
    await expect(
      describer.describe({
        threadModel: "Luna",
        image: { ...image, name: "notes.pdf", mediaType: "application/pdf" },
      }),
    ).resolves.toMatchObject({ kind: "refused" });
    expect(complete).not.toHaveBeenCalled();
  });

  it("admits the describe under the thread's ceilings and records what it used", async () => {
    const settled: unknown[] = [];
    const admit = vi.fn(() => ({
      status: "admitted" as const,
      settle: (usage: unknown) => settled.push(usage),
    }));
    const { describer } = fixture({
      host: vision([haiku]),
      outcomes: [
        { status: "completed", text: "A chart.", usage: { inputTokens: 900, outputTokens: 40 } },
      ],
      spend: { admit },
    });
    await describer.describe({
      scope: { threadId: "thread-1", threadType: "work-thread" },
      threadModel: "Luna",
      image,
    });
    expect(admit).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: { threadId: "thread-1", threadType: "work-thread" },
        candidate: haiku,
      }),
    );
    expect(settled).toEqual([{ inputTokens: 900, outputTokens: 40 }]);
  });

  it("sends nothing when the describe is over a spend ceiling, and says so", async () => {
    const { describer, complete } = fixture({
      host: vision([haiku]),
      spend: {
        admit: () => ({ status: "refused", reason: "This thread reached its token ceiling." }),
      },
    });
    await expect(
      describer.describe({
        scope: { threadId: "thread-1", threadType: "chat-thread" },
        threadModel: "Luna",
        image,
      }),
    ).resolves.toEqual({ kind: "refused", reason: "This thread reached its token ceiling." });
    expect(complete).not.toHaveBeenCalled();
  });
});
