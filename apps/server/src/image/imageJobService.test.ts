import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  IMAGE_GENERATION_REQUEST_SHAPE,
  IMAGE_JOB_RESTART_INTERRUPTION_MESSAGE,
  IMAGE_LIBRARY_SCOPE_ID,
  MAX_GENERATED_IMAGE_BYTES,
  decodeAggregateVersion,
  decodeImageGenerationScopeId,
  decodeProjectId,
  decodeProviderInstanceId,
  decodeProviderModelId,
  type ImageGenerationCustomSource,
  type ProviderDriverKind,
  type ProviderInstance,
} from "@octant/contracts";
import {
  sanitizeImageFailure,
  type ImageGenerationAdapter,
  type ImageGenerationDriver,
} from "@octant/provider-sdk/image-generation";
import { Journal } from "../persistence/journal";
import { ConcurrencyConflict } from "../persistence/journalErrors";
import { applyMigrations, MIGRATIONS } from "../persistence/migrations";
import { catchUpProjection } from "../persistence/projection";
import { createPhase1RuntimeRegistries } from "../persistence/runtimeRegistry";
import { openSqlite } from "../persistence/sqlitePort";
import { SpendCeilingService } from "../spendCeilingService";
import { readUsageDashboard } from "../usageDashboardService";
import { GeneratedImageStore } from "./generatedImageStore";
import type { ImageHttpFetch } from "./imageHttp";
import { ImageJobService, ImageJobServiceError } from "./imageJobService";

const now = "2026-08-28T12:00:00.000Z";
const directories: Array<string> = [];
const png = Uint8Array.from(
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64",
  ),
);
const profileId = decodeProviderInstanceId("a3000000-0000-4000-8000-000000000001");
const scopeId = decodeImageGenerationScopeId("a3000000-0000-4000-8000-000000000002");
const modelId = decodeProviderModelId("gpt-image-2");
const compatibleId = decodeProviderInstanceId("a3000000-0000-4000-8000-000000000005");
const compatibleModelId = decodeProviderModelId("recraftv3");
const bflId = decodeProviderInstanceId("a3000000-0000-4000-8000-000000000006");
const bflModelId = decodeProviderModelId("flux-pro-1.1");
const ideogramId = decodeProviderInstanceId("a3000000-0000-4000-8000-000000000007");
const ideogramModelId = decodeProviderModelId("ideogram-v3");
const actor = {
  kind: "system" as const,
  actorId: "00000000-0000-4000-8000-000000000002" as never,
};

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function imageProfile(): ProviderInstance {
  return {
    id: profileId,
    displayName: "OpenAI Image",
    enabled: true,
    environmentPolicy: "inherit-host",
    version: 1 as ProviderInstance["version"],
    createdAt: now as ProviderInstance["createdAt"],
    updatedAt: now as ProviderInstance["updatedAt"],
    driverKind: "openai-image",
    configuration: {
      kind: "openai-image-http",
      modelAllowlist: [modelId],
      defaultModel: modelId,
    },
  };
}

function compatibleInstance(enabled = true): ProviderInstance {
  return {
    id: compatibleId,
    displayName: "Recraft",
    enabled,
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

function bflInstance(): ProviderInstance {
  return {
    id: bflId,
    displayName: "FLUX",
    enabled: true,
    environmentPolicy: "inherit-host",
    version: 1 as ProviderInstance["version"],
    createdAt: now as ProviderInstance["createdAt"],
    updatedAt: now as ProviderInstance["updatedAt"],
    driverKind: "bfl-image",
    configuration: {
      kind: "bfl-image-http",
      modelAllowlist: [bflModelId],
      defaultModel: bflModelId,
    },
  };
}

function ideogramInstance(): ProviderInstance {
  return {
    id: ideogramId,
    displayName: "Ideogram",
    enabled: true,
    environmentPolicy: "inherit-host",
    version: 1 as ProviderInstance["version"],
    createdAt: now as ProviderInstance["createdAt"],
    updatedAt: now as ProviderInstance["updatedAt"],
    driverKind: "ideogram-image",
    configuration: {
      kind: "ideogram-image-http",
      modelAllowlist: [ideogramModelId],
      defaultModel: ideogramModelId,
    },
  };
}

function openHarness(
  adapter?: ImageGenerationAdapter,
  options: {
    readonly concurrency?: number;
    readonly failAppendAfter?: number;
    readonly failToStatus?: "running";
    readonly customSources?: ReadonlyArray<ImageGenerationCustomSource>;
    readonly compatibleInstance?: ProviderInstance;
    readonly bflInstance?: ProviderInstance;
    readonly ideogramInstance?: ProviderInstance;
    readonly fetch?: ImageHttpFetch;
    readonly imageDrivers?: ReadonlyArray<ImageGenerationDriver>;
    readonly resolveCredential?: () => Promise<string>;
    readonly admittedImageDriverKinds?: ReadonlySet<ProviderDriverKind>;
    readonly withSpendCeiling?: boolean;
    readonly threadProjectId?: string;
    readonly extraProfile?: ProviderInstance;
  } = {},
) {
  const directory = mkdtempSync(join(tmpdir(), "octant-image-job-"));
  directories.push(directory);
  const connection = openSqlite(join(directory, "octant.sqlite3"));
  applyMigrations(connection, MIGRATIONS, () => now);
  const runtime = createPhase1RuntimeRegistries();
  const innerJournal = new Journal({
    connection,
    registry: runtime.events,
    projections: runtime.projections,
    clock: () => now,
  });
  let appendCount = 0;
  let failedToStatus = false;
  const journal =
    options.failAppendAfter === undefined && options.failToStatus === undefined
      ? innerJournal
      : {
          append: (input: unknown) => {
            appendCount += 1;
            const failThisAppend =
              (options.failAppendAfter !== undefined && appendCount > options.failAppendAfter) ||
              (options.failToStatus !== undefined &&
                !failedToStatus &&
                appendToStatus(input) === options.failToStatus);
            if (failThisAppend) {
              failedToStatus = options.failToStatus !== undefined;
              throw new ConcurrencyConflict({
                aggregateType: "image-job",
                aggregateId: "a3000000-0000-4000-8000-000000000099",
                expectedVersion: 2,
                actualVersion: 3,
              });
            }
            return innerJournal.append(input);
          },
        };
  const attachments = new GeneratedImageStore(directory);
  let clockMs = Date.parse(now);
  const spendCeiling =
    options.withSpendCeiling === true
      ? new SpendCeilingService({
          connection,
          journal: innerJournal,
          clock: () => now,
          uuid: () => crypto.randomUUID(),
          threadExists: () => true,
          projectExists: () => true,
        })
      : undefined;
  const service = new ImageJobService({
    journal,
    projection: runtime.imageJobProjection,
    attachments,
    readProviderInstance: (id) => {
      if (String(id) === String(profileId)) return imageProfile();
      if (options.extraProfile !== undefined && String(id) === String(options.extraProfile.id)) {
        return options.extraProfile;
      }
      if (
        options.compatibleInstance !== undefined &&
        String(id) === String(options.compatibleInstance.id)
      ) {
        return options.compatibleInstance;
      }
      if (options.bflInstance !== undefined && String(id) === String(options.bflInstance.id)) {
        return options.bflInstance;
      }
      if (
        options.ideogramInstance !== undefined &&
        String(id) === String(options.ideogramInstance.id)
      ) {
        return options.ideogramInstance;
      }
      return undefined;
    },
    readImageGenerationCustomSources: () => options.customSources ?? [],
    credentialResolver: {
      has: async () => true,
      resolve: options.resolveCredential ?? (async () => "sk-test"),
    },
    uuid: () => crypto.randomUUID(),
    clock: () => new Date(clockMs++).toISOString(),
    actor,
    ...(adapter === undefined ? {} : { createAdapter: () => adapter }),
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    ...(options.concurrency === undefined ? {} : { concurrency: options.concurrency }),
    ...(options.imageDrivers === undefined ? {} : { imageDrivers: options.imageDrivers }),
    ...(options.admittedImageDriverKinds === undefined
      ? {}
      : { admittedImageDriverKinds: options.admittedImageDriverKinds }),
    ...(spendCeiling === undefined ? {} : { spendCeiling }),
    ...(options.threadProjectId === undefined
      ? {}
      : { resolveThreadProjectId: () => options.threadProjectId }),
  });
  return {
    directory,
    connection,
    journal: innerJournal,
    runtime,
    attachments,
    spendCeiling,
    service,
  };
}

function successfulAdapter(): ImageGenerationAdapter {
  return {
    generate: async () => ({
      status: "completed",
      images: [{ bytes: png, mediaType: "image/png" }],
      usage: { inputTokens: 12, outputTokens: 0, size: "1024x1024", outputQuality: "high" },
    }),
  };
}

describe("image job service", () => {
  it("finalizes a generated image as a hash-verified attachment and journals only refs", async () => {
    const { service, journal, connection } = openHarness(successfulAdapter());
    const queued = await service.enqueue({
      threadKind: "chat-thread",
      scopeId,
      profileInstanceId: profileId,
      modelId,
      prompt: "a red cube",
    });
    const completed = await service.whenTerminal(queued.id);
    expect(completed.status).toBe("completed");
    expect(completed.artifacts).toHaveLength(1);
    expect(completed.artifacts[0]?.evidence.promptHash).toMatch(/^[a-f0-9]{64}$/);
    const replayed = journal.replay({ afterSequence: 0, limit: 100 } as never);
    const payload = JSON.stringify(replayed.map((event) => event.payload));
    expect(payload).not.toContain("iVBOR");
    // JSON keys only — bare "b64" matches random UUID hex (e.g. ab2b64ad).
    expect(payload).not.toMatch(/"b64[_a-z]*"\s*:/);
    expect(payload).not.toContain("sk-test");
    expect(payload).not.toContain("https://");

    const dashboard = readUsageDashboard(
      connection,
      { filter: { requestShape: IMAGE_GENERATION_REQUEST_SHAPE } },
      { queryAt: now, projectScope: { kind: "unfiled" } },
    );
    expect(dashboard.detail.some((row) => row.requestShape === "image-generation")).toBe(true);
    const imageRow = dashboard.detail.find((row) => row.requestShape === "image-generation");
    expect(imageRow?.attribution[0]?.imageCount).toBe(1);
    expect(imageRow?.attribution[0]?.imageSize).toBe("1024x1024");
    expect(imageRow?.attribution[0]?.plannedTokens).toBe(0);
  });

  it("records a completed image with no reported usage as unavailable, not as a measured zero", async () => {
    const silentAdapter: ImageGenerationAdapter = {
      generate: async () => ({
        status: "completed",
        images: [{ bytes: png, mediaType: "image/png" }],
      }),
    };
    const { service, connection } = openHarness(silentAdapter);
    const queued = await service.enqueue({
      threadKind: "chat-thread",
      scopeId,
      profileInstanceId: profileId,
      modelId,
      prompt: "a red cube",
    });
    expect((await service.whenTerminal(queued.id)).status).toBe("completed");

    const dashboard = readUsageDashboard(
      connection,
      { filter: { requestShape: IMAGE_GENERATION_REQUEST_SHAPE } },
      { queryAt: now, projectScope: { kind: "unfiled" } },
    );
    const imageRow = dashboard.detail.find((row) => row.requestShape === "image-generation");
    expect(imageRow?.quality).toBe("unavailable");
    expect(imageRow?.attribution[0]?.imageCount).toBe(1);
  });

  it("finds the completed job that made an image by the image's id alone", async () => {
    const { service } = openHarness(successfulAdapter());
    const queued = await service.enqueue({
      threadKind: "chat-thread",
      scopeId,
      profileInstanceId: profileId,
      modelId,
      prompt: "a red cube",
    });
    const completed = await service.whenTerminal(queued.id);
    const artifact = completed.artifacts[0];
    if (artifact === undefined) throw new Error("expected an artifact");
    expect(service.completedJobFor(artifact.attachmentId)).toMatchObject({
      id: completed.id,
      threadKind: "chat-thread",
      scopeId,
    });
    expect(
      service.completedJobFor("99999999-9999-4999-8999-999999999999" as never),
    ).toBeUndefined();
  });

  it("chains an edit job to the parent artifact without retaining provider URLs", async () => {
    const { service } = openHarness(successfulAdapter());
    const original = await service.enqueue({
      threadKind: "chat-thread",
      scopeId,
      profileInstanceId: profileId,
      modelId,
      prompt: "a red cube",
    });
    const completed = await service.whenTerminal(original.id);
    const parent = completed.artifacts[0];
    expect(parent).toBeDefined();
    if (parent === undefined) return;
    const edit = await service.enqueue({
      threadKind: "chat-thread",
      scopeId,
      profileInstanceId: profileId,
      modelId,
      prompt: "make the cube blue",
      parentArtifactRef: {
        attachmentId: parent.attachmentId,
        hash: parent.hash,
        size: parent.size,
        mime: parent.mime,
      },
    });
    const revised = await service.whenTerminal(edit.id);
    expect(revised.status).toBe("completed");
    expect(revised.parentArtifactRef?.attachmentId).toBe(parent.attachmentId);
    expect(revised.artifacts[0]?.evidence.parentArtifactRef?.attachmentId).toBe(
      parent.attachmentId,
    );
  });

  it("refuses an edit that also carries explicit reference images", async () => {
    const { service } = openHarness(successfulAdapter());
    const original = await service.enqueue({
      threadKind: "chat-thread",
      scopeId,
      profileInstanceId: profileId,
      modelId,
      prompt: "a red cube",
    });
    const completed = await service.whenTerminal(original.id);
    const parent = completed.artifacts[0];
    expect(parent).toBeDefined();
    if (parent === undefined) return;
    await expect(
      service.enqueue({
        threadKind: "chat-thread",
        scopeId,
        profileInstanceId: profileId,
        modelId,
        prompt: "make the cube blue",
        parentArtifactRef: {
          attachmentId: parent.attachmentId,
          hash: parent.hash,
          size: parent.size,
          mime: parent.mime,
        },
        references: [{ mediaType: "image/png", bytes: png }],
      }),
    ).rejects.toMatchObject({
      category: "invalid",
      message: "An edit job cannot combine a parent image with explicit references.",
    });
  });

  it("surfaces a safety refusal as a failed job and never calls another profile", async () => {
    const generate = vi.fn(async () => ({
      status: "refused" as const,
      safetyRefusal: "The prompt was blocked.",
    }));
    const { service } = openHarness({ generate });
    const queued = await service.enqueue({
      threadKind: "chat-thread",
      scopeId,
      profileInstanceId: profileId,
      modelId,
      prompt: "disallowed",
    });
    const failed = await service.whenTerminal(queued.id);
    expect(failed.status).toBe("failed");
    expect(failed.safetyRefusal).toBe("The prompt was blocked.");
    expect(failed.artifacts).toEqual([]);
    expect(generate).toHaveBeenCalledOnce();
    expect(failed.profileInstanceId).toBe(profileId);
  });

  it("cancels a running job without leaving a partial artifact", async () => {
    let release: (() => void) | undefined;
    const generate = vi.fn(
      async (request) =>
        new Promise<never>((_resolve, reject) => {
          request.signal?.addEventListener("abort", () => {
            reject({ category: "interrupted", message: "The provider request was cancelled." });
          });
          release = () => undefined;
        }),
    );
    const { service, attachments } = openHarness({ generate });
    const queued = await service.enqueue({
      threadKind: "chat-thread",
      scopeId,
      profileInstanceId: profileId,
      modelId,
      prompt: "hanging",
    });
    await vi.waitFor(() => {
      expect(service.get(queued.id)?.status).toBe("running");
    });
    const cancelled = await service.cancel(queued.id);
    expect(cancelled.status).toBe("cancelled");
    expect(cancelled.artifacts).toEqual([]);
    expect(await attachments.hasTemporaryFiles()).toBe(false);
    void release;
  });

  it("cancels a queued job without later invoking the adapter", async () => {
    const generate = vi.fn(
      async (request) =>
        new Promise<never>((_resolve, reject) => {
          request.signal?.addEventListener("abort", () => {
            reject({ category: "interrupted", message: "The provider request was cancelled." });
          });
        }),
    );
    const { service } = openHarness({ generate }, { concurrency: 1 });
    const running = await service.enqueue({
      threadKind: "chat-thread",
      scopeId,
      profileInstanceId: profileId,
      modelId,
      prompt: "hold the slot",
    });
    await vi.waitFor(() => {
      expect(service.get(running.id)?.status).toBe("running");
    });
    const queued = await service.enqueue({
      threadKind: "chat-thread",
      scopeId,
      profileInstanceId: profileId,
      modelId,
      prompt: "do not keep this prompt",
      references: [{ bytes: png, mediaType: "image/png" }],
    });
    expect(service.get(queued.id)?.status).toBe("queued");
    const cancelled = await service.cancel(queued.id);
    expect(cancelled.status).toBe("cancelled");
    await service.cancel(running.id);
    expect(generate).toHaveBeenCalledOnce();
    expect(service.get(queued.id)?.status).toBe("cancelled");
  });

  it("snapshots reference image bytes so later mutation cannot bypass size checks", async () => {
    const generate = vi.fn(async (request) => ({
      status: "completed" as const,
      images: [{ bytes: png, mediaType: "image/png" as const }],
      references: request.references,
    }));
    const { service } = openHarness({ generate });
    const bytes = Uint8Array.from(png);
    const reference = { bytes, mediaType: "image/png" as const };
    const queued = await service.enqueue({
      threadKind: "chat-thread",
      scopeId,
      profileInstanceId: profileId,
      modelId,
      prompt: "edit this",
      references: [reference],
    });
    bytes.fill(9);
    reference.bytes = new Uint8Array(MAX_GENERATED_IMAGE_BYTES + 1);
    await service.whenTerminal(queued.id);
    expect(generate).toHaveBeenCalledOnce();
    const forwarded = generate.mock.calls[0]?.[0]?.references?.[0]?.bytes;
    expect(forwarded).toEqual(png);
    expect(forwarded).not.toBe(bytes);
  });

  it("refuses oversized reference images before they are forwarded", async () => {
    const generate = vi.fn(async () => ({
      status: "completed" as const,
      images: [{ bytes: png, mediaType: "image/png" as const }],
    }));
    const { service } = openHarness({ generate });
    await expect(
      service.enqueue({
        threadKind: "chat-thread",
        scopeId,
        profileInstanceId: profileId,
        modelId,
        prompt: "edit this",
        references: [
          {
            bytes: new Uint8Array(MAX_GENERATED_IMAGE_BYTES + 1),
            mediaType: "image/png",
          },
        ],
      }),
    ).rejects.toThrow("size limit");
    expect(generate).not.toHaveBeenCalled();
  });

  it("rejects extra adapter images before staging artifacts", async () => {
    const { service, attachments } = openHarness({
      generate: async () => ({
        status: "completed",
        images: [
          { bytes: png, mediaType: "image/png" },
          { bytes: png, mediaType: "image/png" },
        ],
      }),
    });
    const queued = await service.enqueue({
      threadKind: "chat-thread",
      scopeId,
      profileInstanceId: profileId,
      modelId,
      prompt: "one cube",
    });
    const failed = await service.whenTerminal(queued.id);
    expect(failed.status).toBe("failed");
    expect(failed.artifacts).toEqual([]);
    expect(await attachments.hasTemporaryFiles()).toBe(false);
  });

  it("names a full disk as the cause when the image cannot be stored", async () => {
    const { service, attachments } = openHarness(successfulAdapter());
    vi.spyOn(attachments, "stage").mockRejectedValue(
      Object.assign(new Error("ENOSPC: no space left on device, write '/private/path'"), {
        code: "ENOSPC",
      }),
    );
    const queued = await service.enqueue({
      threadKind: "chat-thread",
      scopeId,
      profileInstanceId: profileId,
      modelId,
      prompt: "a red cube",
    });
    const failed = await service.whenTerminal(queued.id);
    expect(failed.status).toBe("failed");
    expect(failed.failure).toEqual({
      category: "unavailable",
      message: "Octant could not store the image because the disk is full. Free space and retry.",
    });
    expect(JSON.stringify(failed)).not.toContain("/private/path");
    expect(failed.artifacts).toEqual([]);
  });

  it("fails a provider image that declares dimensions beyond the bound without storing it", async () => {
    const bomb = Uint8Array.from(png);
    new DataView(bomb.buffer).setUint32(16, 30_000);
    new DataView(bomb.buffer).setUint32(20, 30_000);
    const { service, attachments, directory } = openHarness({
      generate: async () => ({
        status: "completed",
        images: [{ bytes: bomb, mediaType: "image/png" }],
      }),
    });
    const queued = await service.enqueue({
      threadKind: "chat-thread",
      scopeId,
      profileInstanceId: profileId,
      modelId,
      prompt: "a red cube",
    });
    const failed = await service.whenTerminal(queued.id);
    expect(failed.status).toBe("failed");
    expect(failed.failure?.category).toBe("protocol");
    expect(failed.artifacts).toEqual([]);
    expect(hasFinalizedImage(directory)).toBe(false);
    expect(await attachments.hasTemporaryFiles()).toBe(false);
  });

  it("fails a job when the running transition cannot be journaled", async () => {
    const generate = vi.fn(async () => ({
      status: "completed" as const,
      images: [{ bytes: png, mediaType: "image/png" as const }],
    }));
    const { service } = openHarness({ generate }, { failToStatus: "running" });
    const queued = await service.enqueue({
      threadKind: "chat-thread",
      scopeId,
      profileInstanceId: profileId,
      modelId,
      prompt: "never start",
      references: [{ bytes: png, mediaType: "image/png" }],
    });
    const failed = await service.whenTerminal(queued.id);
    expect(failed.status).toBe("failed");
    expect(failed.artifacts).toEqual([]);
    expect(generate).not.toHaveBeenCalled();
    const later = await service.enqueue({
      threadKind: "chat-thread",
      scopeId,
      profileInstanceId: profileId,
      modelId,
      prompt: "a red cube",
    });
    const completed = await service.whenTerminal(later.id);
    expect(completed.status).toBe("completed");
    expect(generate).toHaveBeenCalledOnce();
  });

  it("rejects waiters when a job failure cannot be journaled", async () => {
    const rejections: unknown[] = [];
    const onReject = (reason: unknown) => {
      rejections.push(reason);
    };
    process.on("unhandledRejection", onReject);
    try {
      const { service } = openHarness(
        {
          generate: async () => {
            throw new Error("adapter exploded");
          },
        },
        { failAppendAfter: 2 },
      );
      const queued = await service.enqueue({
        threadKind: "chat-thread",
        scopeId,
        profileInstanceId: profileId,
        modelId,
        prompt: "explode",
      });
      await expect(service.whenTerminal(queued.id)).rejects.toBeInstanceOf(ImageJobServiceError);
      await expect(service.whenTerminal(queued.id)).rejects.toBeInstanceOf(ImageJobServiceError);
      await Promise.resolve();
      await Promise.resolve();
      expect(rejections).toEqual([]);
    } finally {
      process.off("unhandledRejection", onReject);
    }
  });

  it("records an image carried in with a moved thread under the new thread, once, without usage or a provider call", async () => {
    const generate = vi.fn(successfulAdapter().generate);
    const { service, connection } = openHarness({ generate });
    const movedScope = decodeImageGenerationScopeId("a3000000-0000-4000-8000-000000000010");
    const carried = {
      jobId: "a3000000-0000-4000-8000-000000000011" as never,
      threadKind: "chat-thread" as const,
      scopeId: movedScope,
      profileInstanceId: profileId,
      modelId,
      promptHash: "a".repeat(64) as never,
      createdAt: now as never,
      updatedAt: now as never,
      images: [{ attachmentId: "a3000000-0000-4000-8000-000000000012" as never, bytes: png }],
    };
    await service.carryMovedJob(carried);
    // A finish asked again after a lost answer carries the same job again.
    await service.carryMovedJob(carried);

    const jobs = service.listByScope(movedScope);
    expect(jobs.map((job) => [job.id, job.status, job.artifacts.length])).toEqual([
      [carried.jobId, "completed", 1],
    ]);
    const read = await service.readArtifact(
      carried.jobId,
      carried.images[0]?.attachmentId ?? ("" as never),
    );
    expect(read?.bytes).toEqual(png);
    expect(generate).not.toHaveBeenCalled();
    const dashboard = readUsageDashboard(
      connection,
      { filter: { requestShape: IMAGE_GENERATION_REQUEST_SHAPE } },
      { queryAt: now, projectScope: { kind: "unfiled" } },
    );
    expect(dashboard.detail).toEqual([]);
  });

  it("removes finalized attachments when completion cannot be journaled", async () => {
    const { service, directory, attachments } = openHarness(successfulAdapter(), {
      failAppendAfter: 2,
    });
    const queued = await service.enqueue({
      threadKind: "chat-thread",
      scopeId,
      profileInstanceId: profileId,
      modelId,
      prompt: "a red cube",
    });
    await expect(service.whenTerminal(queued.id)).rejects.toBeInstanceOf(ImageJobServiceError);
    expect(hasFinalizedImage(directory)).toBe(false);
    expect(await attachments.hasTemporaryFiles()).toBe(false);
  });

  it("removes finalized attachments when cancelled after the adapter returns", async () => {
    const { service, attachments, directory, runtime } = openHarness(successfulAdapter());
    const originalFinalize = attachments.finalize.bind(attachments);
    vi.spyOn(attachments, "finalize").mockImplementation(async (staged) => {
      const finalized = await originalFinalize(staged);
      for (const job of runtime.imageJobProjection.listRunning()) {
        void service.cancel(job.id);
      }
      return finalized;
    });
    const queued = await service.enqueue({
      threadKind: "chat-thread",
      scopeId,
      profileInstanceId: profileId,
      modelId,
      prompt: "a red cube",
    });
    const cancelled = await service.whenTerminal(queued.id);
    expect(cancelled.status).toBe("cancelled");
    expect(cancelled.artifacts).toEqual([]);
    expect(hasFinalizedImage(directory)).toBe(false);
    expect(await attachments.hasTemporaryFiles()).toBe(false);
  });

  it("fails a job found running after restart without re-invoking the provider", async () => {
    let hangingResolve: ((value: never) => void) | undefined;
    const firstGenerate = vi.fn(
      async () =>
        new Promise<never>((_resolve) => {
          hangingResolve = _resolve;
        }),
    );
    const first = openHarness({ generate: firstGenerate });
    const queued = await first.service.enqueue({
      threadKind: "chat-thread",
      scopeId,
      profileInstanceId: profileId,
      modelId,
      prompt: "restart me",
    });
    await vi.waitFor(() => {
      expect(first.service.get(queued.id)?.status).toBe("running");
    });

    const restartedRuntime = createPhase1RuntimeRegistries();
    const restartedJournal = new Journal({
      connection: first.connection,
      registry: restartedRuntime.events,
      projections: restartedRuntime.projections,
      clock: () => now,
    });
    // Catch up every projection from its stored checkpoint, as host startup does.
    for (const projection of restartedRuntime.projections.all()) {
      catchUpProjection({
        connection: first.connection,
        journal: restartedJournal,
        projection,
        clock: () => now,
      });
    }
    expect(restartedRuntime.imageJobProjection.getById(queued.id)?.status).toBe("running");

    const secondGenerate = vi.fn(async () => ({
      status: "completed" as const,
      images: [{ bytes: png, mediaType: "image/png" as const }],
    }));
    const restarted = new ImageJobService({
      journal: restartedJournal,
      projection: restartedRuntime.imageJobProjection,
      attachments: new GeneratedImageStore(first.directory),
      readProviderInstance: () => imageProfile(),
      readImageGenerationCustomSources: () => [],
      credentialResolver: { has: async () => true, resolve: async () => "sk-test" },
      uuid: () => crypto.randomUUID(),
      clock: () => "2026-08-28T12:01:00.000Z",
      actor,
      createAdapter: () => ({ generate: secondGenerate }),
    });
    const interrupted = await restarted.reconcileInterruptedJobs();
    expect(interrupted).toHaveLength(1);
    expect(interrupted[0]?.status).toBe("failed");
    expect(interrupted[0]?.failure?.message).toBe(IMAGE_JOB_RESTART_INTERRUPTION_MESSAGE);
    expect(secondGenerate).not.toHaveBeenCalled();
    void hangingResolve;
  });
});

describe("image jobs across a host restart", () => {
  it("fails a job still queued at restart instead of leaving it queued forever", async () => {
    const first = openHarness(
      { generate: async () => new Promise<never>(() => {}) },
      {
        concurrency: 1,
      },
    );
    const running = await first.service.enqueue({
      threadKind: "chat-thread",
      scopeId,
      profileInstanceId: profileId,
      modelId,
      prompt: "holds the only slot",
    });
    const queued = await first.service.enqueue({
      threadKind: "chat-thread",
      scopeId,
      profileInstanceId: profileId,
      modelId,
      prompt: "waits for the slot",
    });
    await vi.waitFor(() => {
      expect(first.service.get(running.id)?.status).toBe("running");
    });
    expect(first.service.get(queued.id)?.status).toBe("queued");

    const restartedRuntime = createPhase1RuntimeRegistries();
    const restartedJournal = new Journal({
      connection: first.connection,
      registry: restartedRuntime.events,
      projections: restartedRuntime.projections,
      clock: () => now,
    });
    for (const projection of restartedRuntime.projections.all()) {
      catchUpProjection({
        connection: first.connection,
        journal: restartedJournal,
        projection,
        clock: () => now,
      });
    }
    const restarted = new ImageJobService({
      journal: restartedJournal,
      projection: restartedRuntime.imageJobProjection,
      attachments: new GeneratedImageStore(first.directory),
      readProviderInstance: () => imageProfile(),
      readImageGenerationCustomSources: () => [],
      credentialResolver: { has: async () => true, resolve: async () => "sk-test" },
      uuid: () => crypto.randomUUID(),
      clock: () => "2026-08-28T12:01:00.000Z",
      actor,
    });
    await restarted.reconcileInterruptedJobs();

    expect(restarted.get(queued.id)?.status).toBe("failed");
    expect(restarted.get(queued.id)?.failure?.message).toBe(IMAGE_JOB_RESTART_INTERRUPTION_MESSAGE);
    expect(restarted.get(running.id)?.status).toBe("failed");
  });
});

describe("custom image sources", () => {
  it("enqueues against a registered custom source", async () => {
    const customSources: ReadonlyArray<ImageGenerationCustomSource> = [
      { providerInstanceId: compatibleId, modelId: compatibleModelId, label: "Recraft" },
    ];
    const { service } = openHarness(successfulAdapter(), {
      compatibleInstance: compatibleInstance(),
      customSources,
    });
    const queued = await service.enqueue({
      threadKind: "chat-thread",
      scopeId,
      profileInstanceId: compatibleId,
      modelId: compatibleModelId,
      prompt: "a red cube",
    });
    const completed = await service.whenTerminal(queued.id);
    expect(completed.status).toBe("completed");
  });

  it("refuses a provider and model pair that was never registered as a custom source", async () => {
    const { service } = openHarness(successfulAdapter(), {
      compatibleInstance: compatibleInstance(),
      customSources: [],
    });
    await expect(
      service.enqueue({
        threadKind: "chat-thread",
        scopeId,
        profileInstanceId: compatibleId,
        modelId: compatibleModelId,
        prompt: "a red cube",
      }),
    ).rejects.toMatchObject({ category: "ineligible" });
  });

  it("refuses a disabled compatible instance even when it is a registered custom source", async () => {
    const customSources: ReadonlyArray<ImageGenerationCustomSource> = [
      { providerInstanceId: compatibleId, modelId: compatibleModelId, label: "Recraft" },
    ];
    const { service } = openHarness(successfulAdapter(), {
      compatibleInstance: compatibleInstance(false),
      customSources,
    });
    await expect(
      service.enqueue({
        threadKind: "chat-thread",
        scopeId,
        profileInstanceId: compatibleId,
        modelId: compatibleModelId,
        prompt: "a red cube",
      }),
    ).rejects.toMatchObject({ category: "ineligible" });
  });

  it("dispatches a registered custom source to the OpenAI-compatible image adapter", async () => {
    const fetch = vi.fn(async (url: string | URL | Request) => {
      expect(String(url)).toBe("https://api.recraft.ai/v1/images/generations");
      return Response.json({ data: [{ b64_json: Buffer.from(png).toString("base64") }] });
    });
    const customSources: ReadonlyArray<ImageGenerationCustomSource> = [
      { providerInstanceId: compatibleId, modelId: compatibleModelId, label: "Recraft" },
    ];
    // No `adapter` argument: the service must pick the real default adapter
    // for this configuration kind, not a test double.
    const { service } = openHarness(undefined, {
      compatibleInstance: compatibleInstance(),
      customSources,
      fetch,
    });
    const queued = await service.enqueue({
      threadKind: "chat-thread",
      scopeId,
      profileInstanceId: compatibleId,
      modelId: compatibleModelId,
      prompt: "a red cube",
    });
    const completed = await service.whenTerminal(queued.id);
    expect(completed.status).toBe("completed");
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("dispatches to the BFL image adapter through submit, poll, and the approved-URL fetch", async () => {
    let callCount = 0;
    const fetch = vi.fn(async (url: string | URL | Request) => {
      callCount += 1;
      if (callCount === 1) {
        expect(String(url)).toBe("https://api.bfl.ai/v1/flux-pro-1.1");
        return Response.json({
          id: "job-1",
          polling_url: "https://api.bfl.ai/v1/poll/job-1",
          cost: null,
          input_mp: null,
          output_mp: null,
        });
      }
      if (callCount === 2) {
        expect(String(url)).toBe("https://api.bfl.ai/v1/poll/job-1");
        return Response.json({
          id: "job-1",
          status: "Ready",
          result: { sample: "https://signed.example/generated.png?token=secret" },
        });
      }
      expect(String(url)).toBe("https://signed.example/generated.png?token=secret");
      return new Response(png, { status: 200 });
    });
    // No `adapter` argument: the service must pick the real default adapter
    // for this configuration kind, not a test double.
    const { service } = openHarness(undefined, { bflInstance: bflInstance(), fetch });
    const queued = await service.enqueue({
      threadKind: "chat-thread",
      scopeId,
      profileInstanceId: bflId,
      modelId: bflModelId,
      prompt: "a red cube",
    });
    const completed = await service.whenTerminal(queued.id);
    expect(completed.status).toBe("completed");
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("dispatches to the Ideogram image adapter through the multipart request and the approved-URL fetch", async () => {
    let callCount = 0;
    const fetch = vi.fn(async (url: string | URL | Request) => {
      callCount += 1;
      if (callCount === 1) {
        expect(String(url)).toBe("https://api.ideogram.ai/v1/ideogram-v3/generate");
        return Response.json({
          created: "2026-08-28T12:00:00.000Z",
          data: [
            {
              url: "https://signed.example/generated.png?token=secret",
              prompt: "a red cube",
              resolution: "1024x1024",
              is_image_safe: true,
              seed: 1,
              style_type: "AUTO",
            },
          ],
        });
      }
      expect(String(url)).toBe("https://signed.example/generated.png?token=secret");
      return new Response(png, { status: 200 });
    });
    // No `adapter` argument: the service must pick the real default adapter
    // for this configuration kind, not a test double.
    const { service } = openHarness(undefined, { ideogramInstance: ideogramInstance(), fetch });
    const queued = await service.enqueue({
      threadKind: "chat-thread",
      scopeId,
      profileInstanceId: ideogramId,
      modelId: ideogramModelId,
      prompt: "a red cube",
    });
    const completed = await service.whenTerminal(queued.id);
    expect(completed.status).toBe("completed");
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});

describe("image providers behind the image seam", () => {
  it.each([
    "openAiImageAdapter.ts",
    "geminiImageAdapter.ts",
    "bflImageAdapter.ts",
    "ideogramImageAdapter.ts",
  ])("keeps %s to the imports a third-party image plugin could make", (file) => {
    const source = readFileSync(join(import.meta.dirname, file), "utf8");
    const specifiers = [
      ...source.matchAll(/\bfrom\s+"([^"]+)"|\bimport\s*\(?\s*"([^"]+)"|\brequire\(\s*"([^"]+)"/g),
    ].map((match) => match[1] ?? match[2] ?? match[3]);
    expect(specifiers.length).toBeGreaterThan(0);
    for (const specifier of specifiers) {
      expect(["@octant/contracts", "@octant/provider-sdk/image-generation"]).toContain(specifier);
    }
  });

  it("builds a registered image driver's adapter with ports that carry the profile's credential", async () => {
    const fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      expect(headers.get("x-seam-key")).toBe("sk-test");
      return new Response(png, { status: 200 });
    });
    const seen: Array<string> = [];
    const driver: ImageGenerationDriver = {
      driverKind: "bfl-image",
      providerHosts: ["images.example.test"],
      create: ({ instance, ports }) => ({
        generate: async () => {
          seen.push(String(instance.id));
          const response = await ports.request({
            url: "https://images.example.test/v1/generate",
            method: "POST",
            auth: { header: "x-seam-key" },
            body: "{}",
          });
          const bytes = new Uint8Array(await response.arrayBuffer());
          const mediaType = ports.sniffMediaType(bytes);
          if (mediaType === undefined) {
            return { status: "failed", providerFailure: { category: "protocol", message: "bad" } };
          }
          return { status: "completed", images: [{ bytes, mediaType }] };
        },
      }),
    };
    const { service } = openHarness(undefined, {
      bflInstance: bflInstance(),
      fetch,
      imageDrivers: [driver],
    });
    const queued = await service.enqueue({
      threadKind: "chat-thread",
      scopeId,
      profileInstanceId: bflId,
      modelId: bflModelId,
      prompt: "a red cube",
    });
    const completed = await service.whenTerminal(queued.id);
    expect(completed.status).toBe("completed");
    expect(seen).toEqual([String(bflId)]);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("refuses a registered image driver's call outside its declared hosts before reading the credential", async () => {
    const fetch = vi.fn(async () => new Response(png, { status: 200 }));
    const resolve = vi.fn(async () => "sk-test");
    const driver: ImageGenerationDriver = {
      driverKind: "bfl-image",
      providerHosts: ["images.example.test"],
      create: ({ ports }) => ({
        generate: async () => {
          try {
            await ports.request({
              url: "https://collector.example.test/steal",
              method: "POST",
              auth: { header: "x-seam-key" },
            });
            return { status: "completed", images: [] };
          } catch (error) {
            return { status: "failed", providerFailure: sanitizeImageFailure(error) };
          }
        },
      }),
    };
    const { service } = openHarness(undefined, {
      bflInstance: bflInstance(),
      fetch,
      imageDrivers: [driver],
      resolveCredential: resolve,
    });
    const queued = await service.enqueue({
      threadKind: "chat-thread",
      scopeId,
      profileInstanceId: bflId,
      modelId: bflModelId,
      prompt: "a red cube",
    });
    const failed = await service.whenTerminal(queued.id);
    expect(failed.status).toBe("failed");
    expect(failed.failure?.category).toBe("unauthorized");
    expect(resolve).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("fails a job as unsupported without calling the provider when its image driver plugin is disabled", async () => {
    const fetch = vi.fn(async () => new Response(png, { status: 200 }));
    const { service } = openHarness(undefined, {
      bflInstance: bflInstance(),
      fetch,
      admittedImageDriverKinds: new Set<ProviderDriverKind>(["ideogram-image"]),
    });
    const queued = await service.enqueue({
      threadKind: "chat-thread",
      scopeId,
      profileInstanceId: bflId,
      modelId: bflModelId,
      prompt: "a red cube",
    });
    const failed = await service.whenTerminal(queued.id);
    expect(failed.status).toBe("failed");
    expect(failed.failure?.category).toBe("unsupported");
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("image job spend ceilings", () => {
  const projectId = "a3000000-0000-4000-8000-000000000090";

  function seedChatThreadProject(
    connection: ReturnType<typeof openSqlite>,
    threadId: string,
    targetProjectId: string,
  ): void {
    connection
      .prepare(
        `INSERT INTO chat_thread_projection (
          thread_id, project_id, lifecycle, schema_version, thread_json,
          aggregate_version, updated_at, last_sequence
        ) VALUES (?, ?, 'active', 1, '{}', 1, ?, 1)`,
      )
      .run(threadId, targetProjectId, now);
  }

  it("refuses an over-ceiling image generation under a thread monetary ceiling without calling the provider", async () => {
    const generate = vi.fn(async () => ({
      status: "completed" as const,
      images: [{ bytes: png, mediaType: "image/png" as const }],
    }));
    const { service, spendCeiling } = openHarness({ generate }, { withSpendCeiling: true });
    spendCeiling?.execute("local-window", {
      kind: "set-spend-ceiling",
      scope: { kind: "thread", threadType: "chat-thread", threadId: String(scopeId) },
      expectedVersion: decodeAggregateVersion(0),
      policy: { costBudgetUsdCents: 5 },
      window: { kind: "lifetime" },
    });

    await expect(
      service.enqueue({
        threadKind: "chat-thread",
        scopeId,
        profileInstanceId: profileId,
        modelId,
        quality: "high",
        size: "1024x1024",
        prompt: "a red cube",
      }),
    ).rejects.toMatchObject({
      category: "spend-ceiling",
      refusal: {
        kind: "exhausted",
        dimension: "monetary",
        scopeKind: "thread",
        remainingUsdCents: 5,
        ceilingUsdCents: 5,
      },
    });
    expect(generate).not.toHaveBeenCalled();
  });

  it("refuses an over-ceiling image generation under a Project monetary ceiling without calling the provider", async () => {
    const generate = vi.fn(async () => ({
      status: "completed" as const,
      images: [{ bytes: png, mediaType: "image/png" as const }],
    }));
    const { connection, service, spendCeiling } = openHarness(
      { generate },
      { withSpendCeiling: true, threadProjectId: projectId },
    );
    seedChatThreadProject(connection, String(scopeId), projectId);
    spendCeiling?.execute("local-window", {
      kind: "set-spend-ceiling",
      scope: { kind: "project", projectId: decodeProjectId(projectId) },
      expectedVersion: decodeAggregateVersion(0),
      policy: { costBudgetUsdCents: 7 },
      window: { kind: "calendar", period: "day", timeZone: "UTC" },
    });

    // Two variants of medium 1024x1024 gpt-image-2 cost 26,000 micros (3 cents);
    // two variants of high 1024x1024 cost 106,000 micros (11 cents) -> refused.
    await expect(
      service.enqueue({
        threadKind: "chat-thread",
        scopeId,
        profileInstanceId: profileId,
        modelId,
        quality: "high",
        size: "1024x1024",
        variantCount: 2,
        prompt: "a red cube",
      }),
    ).rejects.toMatchObject({
      category: "spend-ceiling",
      refusal: {
        kind: "exhausted",
        dimension: "monetary",
        scopeKind: "project",
        remainingUsdCents: 7,
        ceilingUsdCents: 7,
      },
    });
    expect(generate).not.toHaveBeenCalled();
  });

  it("refuses with unknown-spend when a monetary ceiling is active and the model or custom source has no price rate", async () => {
    const generate = vi.fn(async () => ({
      status: "completed" as const,
      images: [{ bytes: png, mediaType: "image/png" as const }],
    }));
    const unknownModelId = decodeProviderModelId("unlisted-image-model");
    const unlistedProfile: ProviderInstance = {
      id: decodeProviderInstanceId("a3000000-0000-4000-8000-000000000088"),
      displayName: "OpenAI Image (Unlisted)",
      enabled: true,
      environmentPolicy: "inherit-host",
      version: 1 as ProviderInstance["version"],
      createdAt: now as ProviderInstance["createdAt"],
      updatedAt: now as ProviderInstance["updatedAt"],
      driverKind: "openai-image",
      configuration: {
        kind: "openai-image-http",
        modelAllowlist: [unknownModelId],
        defaultModel: unknownModelId,
      },
    };
    const customSources: ReadonlyArray<ImageGenerationCustomSource> = [
      { providerInstanceId: compatibleId, modelId: compatibleModelId, label: "Recraft" },
    ];
    const { service, spendCeiling } = openHarness(
      { generate },
      {
        withSpendCeiling: true,
        extraProfile: unlistedProfile,
        compatibleInstance: compatibleInstance(),
        customSources,
      },
    );

    // Without a monetary ceiling, an unpriced custom source is admitted normally.
    const unconstrained = await service.enqueue({
      threadKind: "chat-thread",
      scopeId,
      profileInstanceId: compatibleId,
      modelId: compatibleModelId,
      prompt: "a blue sphere",
    });
    expect((await service.whenTerminal(unconstrained.id)).status).toBe("completed");
    expect(generate).toHaveBeenCalledTimes(1);

    const otherScope = decodeImageGenerationScopeId("a3000000-0000-4000-8000-000000000089");
    spendCeiling?.execute("local-window", {
      kind: "set-spend-ceiling",
      scope: { kind: "thread", threadType: "chat-thread", threadId: String(otherScope) },
      expectedVersion: decodeAggregateVersion(0),
      policy: { costBudgetUsdCents: 100 },
      window: { kind: "lifetime" },
    });

    await expect(
      service.enqueue({
        threadKind: "chat-thread",
        scopeId: otherScope,
        profileInstanceId: unlistedProfile.id,
        modelId: unknownModelId,
        prompt: "a red cube",
      }),
    ).rejects.toMatchObject({
      category: "spend-ceiling",
      refusal: {
        kind: "unknown-spend",
        dimension: "monetary",
        scopeKind: "thread",
      },
    });
    await expect(
      service.enqueue({
        threadKind: "chat-thread",
        scopeId: otherScope,
        profileInstanceId: compatibleId,
        modelId: compatibleModelId,
        prompt: "a red cube",
      }),
    ).rejects.toMatchObject({
      category: "spend-ceiling",
      refusal: {
        kind: "unknown-spend",
        dimension: "monetary",
        scopeKind: "thread",
      },
    });
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it("settles the reservation without double-counting on success and counts settled image spend on subsequent checks", async () => {
    let releaseFirst: (() => void) | undefined;
    let calls = 0;
    const adapter: ImageGenerationAdapter = {
      generate: async () => {
        calls += 1;
        if (calls === 1) {
          await new Promise<void>((resolve) => {
            releaseFirst = resolve;
          });
        }
        return {
          status: "completed",
          images: [{ bytes: png, mediaType: "image/png" }],
        };
      },
    };
    const { connection, service, spendCeiling } = openHarness(adapter, {
      withSpendCeiling: true,
      threadProjectId: projectId,
      bflInstance: bflInstance(),
    });
    seedChatThreadProject(connection, String(scopeId), projectId);
    // flux-pro-1.1 costs 40,000 micros = 4 cents. Budget = 7 cents -> fits 1, refuses 2nd.
    spendCeiling?.execute("local-window", {
      kind: "set-spend-ceiling",
      scope: { kind: "project", projectId: decodeProjectId(projectId) },
      expectedVersion: decodeAggregateVersion(0),
      policy: { costBudgetUsdCents: 7 },
      window: { kind: "calendar", period: "day", timeZone: "UTC" },
    });

    const first = await service.enqueue({
      threadKind: "chat-thread",
      scopeId,
      profileInstanceId: bflId,
      modelId: bflModelId,
      prompt: "first cube",
    });
    // While in flight, 4 cents are reserved so a second 4-cent job is refused.
    await expect(
      service.enqueue({
        threadKind: "chat-thread",
        scopeId,
        profileInstanceId: bflId,
        modelId: bflModelId,
        prompt: "concurrent second cube",
      }),
    ).rejects.toMatchObject({
      category: "spend-ceiling",
      refusal: { kind: "exhausted", dimension: "monetary", remainingUsdCents: 3 },
    });

    releaseFirst?.();
    expect((await service.whenTerminal(first.id)).status).toBe("completed");

    // Settled spend is 4 cents, reservation is released (no double-counting -> 3 cents left, not -1).
    const snapshot = spendCeiling?.snapshot({
      principalKind: "local-window",
      projectId,
    });
    expect(snapshot).toBeDefined();
    if (snapshot !== undefined && !("kind" in snapshot)) {
      expect(snapshot.projectRemaining).toMatchObject({
        ceilingUsdCents: 7,
        usedUsdCents: 4,
        remainingUsdCents: 3,
      });
    }

    // Subsequent 4-cent job still refuses against the settled 4 cents (3 cents left).
    await expect(
      service.enqueue({
        threadKind: "chat-thread",
        scopeId,
        profileInstanceId: bflId,
        modelId: bflModelId,
        prompt: "second cube after settle",
      }),
    ).rejects.toMatchObject({
      category: "spend-ceiling",
      refusal: { kind: "exhausted", dimension: "monetary", remainingUsdCents: 3 },
    });
    expect(calls).toBe(1);
  });

  it("releases its monetary reservation cleanly on failure, safety refusal, queued cancellation, running cancellation, and restart interruption", async () => {
    const budgetCents = 4;
    const assertFullRemaining = (spendCeiling: SpendCeilingService | undefined) => {
      const snapshot = spendCeiling?.snapshot({
        principalKind: "local-window",
        threadId: String(scopeId),
        threadType: "chat-thread",
      });
      if (snapshot === undefined || "kind" in snapshot) throw new Error("expected snapshot");
      expect(snapshot.threadRemaining).toMatchObject({
        ceilingUsdCents: budgetCents,
        usedUsdCents: 0,
        remainingUsdCents: budgetCents,
      });
    };
    const setThreadCeiling = (spendCeiling: SpendCeilingService | undefined) => {
      spendCeiling?.execute("local-window", {
        kind: "set-spend-ceiling",
        scope: { kind: "thread", threadType: "chat-thread", threadId: String(scopeId) },
        expectedVersion: decodeAggregateVersion(0),
        policy: { costBudgetUsdCents: budgetCents },
        window: { kind: "lifetime" },
      });
    };

    // 1. Provider failure releases reservation.
    {
      const { service, spendCeiling } = openHarness(
        {
          generate: async () => ({
            status: "failed",
            providerFailure: { category: "unavailable", message: "down" },
          }),
        },
        { withSpendCeiling: true, bflInstance: bflInstance() },
      );
      setThreadCeiling(spendCeiling);
      const job = await service.enqueue({
        threadKind: "chat-thread",
        scopeId,
        profileInstanceId: bflId,
        modelId: bflModelId,
        prompt: "fail me",
      });
      expect((await service.whenTerminal(job.id)).status).toBe("failed");
      assertFullRemaining(spendCeiling);
    }

    // 2. Safety refusal releases reservation.
    {
      const { service, spendCeiling } = openHarness(
        {
          generate: async () => ({ status: "refused", safetyRefusal: "blocked" }),
        },
        { withSpendCeiling: true, bflInstance: bflInstance() },
      );
      setThreadCeiling(spendCeiling);
      const job = await service.enqueue({
        threadKind: "chat-thread",
        scopeId,
        profileInstanceId: bflId,
        modelId: bflModelId,
        prompt: "refuse me",
      });
      expect((await service.whenTerminal(job.id)).status).toBe("failed");
      assertFullRemaining(spendCeiling);
    }

    // 3. Running cancellation (stop) and queued cancellation both release reservations.
    {
      const adapter: ImageGenerationAdapter = {
        generate: async (request) =>
          new Promise((resolve) => {
            request.signal?.addEventListener("abort", () =>
              resolve({
                status: "failed",
                providerFailure: { category: "interrupted", message: "cancelled" },
              }),
            );
          }),
      };
      const { service, spendCeiling } = openHarness(adapter, {
        withSpendCeiling: true,
        bflInstance: bflInstance(),
        concurrency: 1,
      });
      spendCeiling?.execute("local-window", {
        kind: "set-spend-ceiling",
        scope: { kind: "thread", threadType: "chat-thread", threadId: String(scopeId) },
        expectedVersion: decodeAggregateVersion(0),
        policy: { costBudgetUsdCents: 8 },
        window: { kind: "lifetime" },
      });
      const running = await service.enqueue({
        threadKind: "chat-thread",
        scopeId,
        profileInstanceId: bflId,
        modelId: bflModelId,
        prompt: "first running",
      });
      const queued = await service.enqueue({
        threadKind: "chat-thread",
        scopeId,
        profileInstanceId: bflId,
        modelId: bflModelId,
        prompt: "second queued",
      });
      expect((await service.cancel(queued.id)).status).toBe("cancelled");
      expect((await service.cancel(running.id)).status).toBe("cancelled");
      const snapshot = spendCeiling?.snapshot({
        principalKind: "local-window",
        threadId: String(scopeId),
        threadType: "chat-thread",
      });
      if (snapshot === undefined || "kind" in snapshot) throw new Error("expected snapshot");
      expect(snapshot.threadRemaining).toMatchObject({
        ceilingUsdCents: 8,
        usedUsdCents: 0,
        remainingUsdCents: 8,
      });
    }

    // 4. Restart interruption releases reservation.
    {
      const adapter: ImageGenerationAdapter = {
        generate: async () => new Promise(() => undefined),
      };
      const { service, spendCeiling } = openHarness(adapter, {
        withSpendCeiling: true,
        bflInstance: bflInstance(),
      });
      setThreadCeiling(spendCeiling);
      await service.enqueue({
        threadKind: "chat-thread",
        scopeId,
        profileInstanceId: bflId,
        modelId: bflModelId,
        prompt: "interrupted by restart",
      });
      const interrupted = await service.reconcileInterruptedJobs();
      expect(interrupted).toHaveLength(1);
      assertFullRemaining(spendCeiling);
    }
  });

  it("does not block an image job under a token-only ceiling or in the host image library", async () => {
    const { service, spendCeiling } = openHarness(successfulAdapter(), {
      withSpendCeiling: true,
      bflInstance: bflInstance(),
    });
    spendCeiling?.execute("local-window", {
      kind: "set-spend-ceiling",
      scope: { kind: "thread", threadType: "chat-thread", threadId: String(scopeId) },
      expectedVersion: decodeAggregateVersion(0),
      policy: { tokenBudget: 100 },
      window: { kind: "lifetime" },
    });

    const threadJob = await service.enqueue({
      threadKind: "chat-thread",
      scopeId,
      profileInstanceId: bflId,
      modelId: bflModelId,
      prompt: "a token-only thread",
    });
    expect((await service.whenTerminal(threadJob.id)).status).toBe("completed");

    const libraryJob = await service.enqueue({
      threadKind: "image-library",
      scopeId: IMAGE_LIBRARY_SCOPE_ID,
      profileInstanceId: bflId,
      modelId: bflModelId,
      prompt: "a library image",
    });
    expect((await service.whenTerminal(libraryJob.id)).status).toBe("completed");
  });

  it("freezes the profile defaults priced at enqueue time even when profile settings change while the job is queued", async () => {
    let releaseFirst: (() => void) | undefined;
    const dispatchedQualities: Array<string | undefined> = [];
    const adapter: ImageGenerationAdapter = {
      generate: async (request) => {
        dispatchedQualities.push(request.quality);
        if (dispatchedQualities.length === 1) {
          await new Promise<void>((resolve) => {
            releaseFirst = resolve;
          });
        }
        return {
          status: "completed",
          images: [{ bytes: png, mediaType: "image/png" }],
        };
      },
    };
    let currentQuality: "low" | "high" = "low";
    const dynamicProfile = (): ProviderInstance => ({
      id: profileId,
      displayName: "OpenAI Image",
      enabled: true,
      environmentPolicy: "inherit-host",
      version: 1 as ProviderInstance["version"],
      createdAt: now as ProviderInstance["createdAt"],
      updatedAt: now as ProviderInstance["updatedAt"],
      driverKind: "openai-image",
      configuration: {
        kind: "openai-image-http",
        modelAllowlist: [modelId],
        defaultModel: modelId,
        quality: currentQuality,
        size: "1024x1024",
      },
    });
    const directory = mkdtempSync(join(tmpdir(), "octant-image-job-frozen-"));
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
    const service = new ImageJobService({
      journal,
      projection: runtime.imageJobProjection,
      attachments: new GeneratedImageStore(directory),
      readProviderInstance: (id) =>
        String(id) === String(profileId) ? dynamicProfile() : undefined,
      readImageGenerationCustomSources: () => [],
      credentialResolver: { has: async () => true, resolve: async () => "sk-test" },
      uuid: () => crypto.randomUUID(),
      clock: () => now,
      actor,
      createAdapter: () => adapter,
      concurrency: 1,
      spendCeiling,
    });
    // Low square gpt-image-2 is 6,000 micros (0.6 cents); budget of 2 cents admits 2 low jobs, never a high job (53,000 micros).
    spendCeiling.execute("local-window", {
      kind: "set-spend-ceiling",
      scope: { kind: "thread", threadType: "chat-thread", threadId: String(scopeId) },
      expectedVersion: decodeAggregateVersion(0),
      policy: { costBudgetUsdCents: 2 },
      window: { kind: "lifetime" },
    });

    const first = await service.enqueue({
      threadKind: "chat-thread",
      scopeId,
      profileInstanceId: profileId,
      modelId,
      prompt: "first queued",
    });
    const second = await service.enqueue({
      threadKind: "chat-thread",
      scopeId,
      profileInstanceId: profileId,
      modelId,
      prompt: "second queued inheriting low",
    });
    // Raise profile default to high while the second job is still queued.
    currentQuality = "high";
    releaseFirst?.();
    expect((await service.whenTerminal(first.id)).status).toBe("completed");
    expect((await service.whenTerminal(second.id)).status).toBe("completed");
    expect(dispatchedQualities).toEqual(["low", "low"]);
  });

  it("records billed image cost against the spend ceiling when the provider succeeded but local storage fails", async () => {
    const adapter: ImageGenerationAdapter = {
      generate: async () => ({
        status: "completed",
        images: [{ bytes: png, mediaType: "image/png" }],
      }),
    };
    const { service, spendCeiling, attachments } = openHarness(adapter, {
      withSpendCeiling: true,
      bflInstance: bflInstance(),
    });
    // flux-pro-1.1 costs 40,000 micros (4 cents); a 4-cent ceiling allows only one billed generation.
    spendCeiling?.execute("local-window", {
      kind: "set-spend-ceiling",
      scope: { kind: "thread", threadType: "chat-thread", threadId: String(scopeId) },
      expectedVersion: decodeAggregateVersion(0),
      policy: { costBudgetUsdCents: 4 },
      window: { kind: "lifetime" },
    });
    const diskFull = Object.assign(new Error("no space"), { code: "ENOSPC" });
    vi.spyOn(attachments, "stage").mockRejectedValueOnce(diskFull);

    const first = await service.enqueue({
      threadKind: "chat-thread",
      scopeId,
      profileInstanceId: bflId,
      modelId: bflModelId,
      prompt: "billed then disk full",
    });
    const failed = await service.whenTerminal(first.id);
    expect(failed.status).toBe("failed");

    // The provider already billed 4 cents, so a retry must be refused by the 4-cent ceiling.
    await expect(
      service.enqueue({
        threadKind: "chat-thread",
        scopeId,
        profileInstanceId: bflId,
        modelId: bflModelId,
        prompt: "retry after disk full",
      }),
    ).rejects.toMatchObject({
      category: "spend-ceiling",
      refusal: {
        kind: "exhausted",
        dimension: "monetary",
        remainingUsdCents: 0,
        ceilingUsdCents: 4,
      },
    });
  });

  it("rechecks the destination Project ceiling before dispatching a queued job whose thread moved Projects", async () => {
    const projectB = "a3000000-0000-4000-8000-000000000095";
    let releaseFirst: (() => void) | undefined;
    let calls = 0;
    const adapter: ImageGenerationAdapter = {
      generate: async () => {
        calls += 1;
        if (calls === 1) {
          await new Promise<void>((resolve) => {
            releaseFirst = resolve;
          });
        }
        return {
          status: "completed",
          images: [{ bytes: png, mediaType: "image/png" }],
        };
      },
    };
    const directory = mkdtempSync(join(tmpdir(), "octant-image-job-move-"));
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
    let currentProjectId = projectId;
    seedChatThreadProject(connection, String(scopeId), projectId);
    const otherThread = decodeImageGenerationScopeId("a3000000-0000-4000-8000-000000000096");
    seedChatThreadProject(connection, String(otherThread), projectId);

    const service = new ImageJobService({
      journal,
      projection: runtime.imageJobProjection,
      attachments: new GeneratedImageStore(directory),
      readProviderInstance: (id) => (String(id) === String(bflId) ? bflInstance() : undefined),
      readImageGenerationCustomSources: () => [],
      credentialResolver: { has: async () => true, resolve: async () => "sk-test" },
      uuid: () => crypto.randomUUID(),
      clock: () => now,
      actor,
      createAdapter: () => adapter,
      concurrency: 1,
      spendCeiling,
      resolveThreadProjectId: ({ threadId }) =>
        threadId === String(scopeId) ? currentProjectId : projectId,
    });

    // Project B has a 2-cent ceiling (cannot afford a 4-cent FLUX job).
    spendCeiling.execute("local-window", {
      kind: "set-spend-ceiling",
      scope: { kind: "project", projectId: decodeProjectId(projectB) },
      expectedVersion: decodeAggregateVersion(0),
      policy: { costBudgetUsdCents: 2 },
      window: { kind: "calendar", period: "day", timeZone: "UTC" },
    });

    const first = await service.enqueue({
      threadKind: "chat-thread",
      scopeId: otherThread,
      profileInstanceId: bflId,
      modelId: bflModelId,
      prompt: "occupies the single slot",
    });
    const queuedInA = await service.enqueue({
      threadKind: "chat-thread",
      scopeId,
      profileInstanceId: bflId,
      modelId: bflModelId,
      prompt: "queued in Project A then moved to B",
    });

    // Move scopeId's thread to Project B while its job is still queued.
    currentProjectId = projectB;
    connection
      .prepare("UPDATE chat_thread_projection SET project_id = ? WHERE thread_id = ?")
      .run(projectB, String(scopeId));

    releaseFirst?.();
    expect((await service.whenTerminal(first.id)).status).toBe("completed");
    const movedResult = await service.whenTerminal(queuedInA.id);
    expect(movedResult.status).toBe("failed");
    expect(movedResult.failure?.message).toMatch(/Project's money ceiling/i);
    // Provider was called ONLY for the first job, never for the moved job.
    expect(calls).toBe(1);
  });

  it("re-admits moved queued jobs in FIFO order so a later oversized job does not block an affordable earlier job", async () => {
    const projectB = "a3000000-0000-4000-8000-000000000094";
    let releaseFirst: (() => void) | undefined;
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const dispatchedPrompts: Array<string> = [];
    const adapter: ImageGenerationAdapter = {
      generate: async (request) => {
        dispatchedPrompts.push(request.prompt);
        if (dispatchedPrompts.length === 1) {
          await firstBlocked;
        }
        return {
          status: "completed",
          images: Array.from({ length: request.variantCount ?? 1 }, () => ({
            bytes: png,
            mediaType: "image/png" as const,
          })),
          usage: { inputTokens: 0, outputTokens: 0 },
        };
      },
    };
    const directory = mkdtempSync(join(tmpdir(), "octant-image-job-fifo-move-"));
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
    let currentProjectId = projectId;
    seedChatThreadProject(connection, String(scopeId), projectId);
    const otherThread = decodeImageGenerationScopeId("a3000000-0000-4000-8000-000000000093");
    seedChatThreadProject(connection, String(otherThread), projectId);

    const service = new ImageJobService({
      journal,
      projection: runtime.imageJobProjection,
      attachments: new GeneratedImageStore(directory),
      readProviderInstance: (id) => (String(id) === String(profileId) ? imageProfile() : undefined),
      readImageGenerationCustomSources: () => [],
      credentialResolver: { has: async () => true, resolve: async () => "sk-test" },
      uuid: () => crypto.randomUUID(),
      clock: () => now,
      actor,
      createAdapter: () => adapter,
      concurrency: 1,
      spendCeiling,
      resolveThreadProjectId: ({ threadId }) =>
        threadId === String(scopeId) ? currentProjectId : projectId,
    });

    // Project B has an 8-cent ceiling: fits one 5.3-cent gpt-image-2 high square image,
    // not a 2-variant 10.6-cent request.
    spendCeiling.execute("local-window", {
      kind: "set-spend-ceiling",
      scope: { kind: "project", projectId: decodeProjectId(projectB) },
      expectedVersion: decodeAggregateVersion(0),
      policy: { costBudgetUsdCents: 8 },
      window: { kind: "calendar", period: "day", timeZone: "UTC" },
    });

    const blocker = await service.enqueue({
      threadKind: "chat-thread",
      scopeId: otherThread,
      profileInstanceId: profileId,
      modelId,
      prompt: "occupies the single slot",
      quality: "high",
      size: "1024x1024",
    });
    const affordable = await service.enqueue({
      threadKind: "chat-thread",
      scopeId,
      profileInstanceId: profileId,
      modelId,
      prompt: "affordable 5.3-cent job",
      quality: "high",
      size: "1024x1024",
      variantCount: 1,
    });
    const oversized = await service.enqueue({
      threadKind: "chat-thread",
      scopeId,
      profileInstanceId: profileId,
      modelId,
      prompt: "oversized 10.6-cent job",
      quality: "high",
      size: "1024x1024",
      variantCount: 2,
    });

    // Move scopeId from Project A (uncapped) to Project B (8-cent ceiling) while both jobs are queued.
    currentProjectId = projectB;
    connection
      .prepare("UPDATE chat_thread_projection SET project_id = ? WHERE thread_id = ?")
      .run(projectB, String(scopeId));

    releaseFirst?.();
    expect((await service.whenTerminal(blocker.id)).status).toBe("completed");
    expect((await service.whenTerminal(affordable.id)).status).toBe("completed");
    const oversizedResult = await service.whenTerminal(oversized.id);
    expect(oversizedResult.status).toBe("failed");
    expect(oversizedResult.failure?.message).toMatch(/Project's money ceiling/i);
    expect(dispatchedPrompts).toEqual(["occupies the single slot", "affordable 5.3-cent job"]);
    expect(
      spendCeiling.snapshot({ principalKind: "local-window", projectId: projectB }),
    ).toMatchObject({
      projectRemaining: { ceilingUsdCents: 8, usedUsdCents: 5, remainingUsdCents: 2 },
    });
  });

  it("rechecks a moved queued job against a Project ceiling installed after an earlier moved job started", async () => {
    const projectB = "a3000000-0000-4000-8000-000000000092";
    let releaseBlocker: (() => void) | undefined;
    const blockerPaused = new Promise<void>((resolve) => {
      releaseBlocker = resolve;
    });
    let notifyFirstMovedStarted: (() => void) | undefined;
    const firstMovedStarted = new Promise<void>((resolve) => {
      notifyFirstMovedStarted = resolve;
    });
    let releaseFirstMoved: (() => void) | undefined;
    const firstMovedPaused = new Promise<void>((resolve) => {
      releaseFirstMoved = resolve;
    });
    const dispatchedPrompts: Array<string> = [];
    const adapter: ImageGenerationAdapter = {
      generate: async (request) => {
        dispatchedPrompts.push(request.prompt);
        if (request.prompt === "occupies the single slot") {
          await blockerPaused;
        } else if (request.prompt === "first moved 4-cent job") {
          notifyFirstMovedStarted?.();
          await firstMovedPaused;
        }
        return {
          status: "completed",
          images: [{ bytes: png, mediaType: "image/png" as const }],
          usage: { inputTokens: 0, outputTokens: 0 },
        };
      },
    };
    const directory = mkdtempSync(join(tmpdir(), "octant-image-job-new-ceiling-"));
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
    let currentProjectId = projectId;
    seedChatThreadProject(connection, String(scopeId), projectId);
    const otherThread = decodeImageGenerationScopeId("a3000000-0000-4000-8000-000000000091");
    seedChatThreadProject(connection, String(otherThread), projectId);

    const service = new ImageJobService({
      journal,
      projection: runtime.imageJobProjection,
      attachments: new GeneratedImageStore(directory),
      readProviderInstance: (id) => (String(id) === String(bflId) ? bflInstance() : undefined),
      readImageGenerationCustomSources: () => [],
      credentialResolver: { has: async () => true, resolve: async () => "sk-test" },
      uuid: () => crypto.randomUUID(),
      clock: () => now,
      actor,
      createAdapter: () => adapter,
      concurrency: 1,
      spendCeiling,
      resolveThreadProjectId: ({ threadId }) =>
        threadId === String(scopeId) ? currentProjectId : projectId,
    });

    const blocker = await service.enqueue({
      threadKind: "chat-thread",
      scopeId: otherThread,
      profileInstanceId: bflId,
      modelId: bflModelId,
      prompt: "occupies the single slot",
    });
    const firstMoved = await service.enqueue({
      threadKind: "chat-thread",
      scopeId,
      profileInstanceId: bflId,
      modelId: bflModelId,
      prompt: "first moved 4-cent job",
    });
    const secondMoved = await service.enqueue({
      threadKind: "chat-thread",
      scopeId,
      profileInstanceId: bflId,
      modelId: bflModelId,
      prompt: "second moved 4-cent job",
    });

    // Move scopeId into Project B while Project B has no ceiling yet.
    currentProjectId = projectB;
    connection
      .prepare("UPDATE chat_thread_projection SET project_id = ? WHERE thread_id = ?")
      .run(projectB, String(scopeId));

    // Release blocker so firstMoved begins running on Project B (and secondMoved stays queued).
    releaseBlocker?.();
    await firstMovedStarted;

    // Install a 4-cent ceiling on Project B while firstMoved is running and secondMoved waits.
    spendCeiling.execute("local-window", {
      kind: "set-spend-ceiling",
      scope: { kind: "project", projectId: decodeProjectId(projectB) },
      expectedVersion: decodeAggregateVersion(0),
      policy: { costBudgetUsdCents: 4 },
      window: { kind: "calendar", period: "day", timeZone: "UTC" },
    });

    releaseFirstMoved?.();
    expect((await service.whenTerminal(blocker.id)).status).toBe("completed");
    expect((await service.whenTerminal(firstMoved.id)).status).toBe("completed");
    const secondResult = await service.whenTerminal(secondMoved.id);
    expect(secondResult.status).toBe("failed");
    expect(secondResult.failure?.message).toMatch(/Project's money ceiling/i);
    expect(dispatchedPrompts).toEqual(["occupies the single slot", "first moved 4-cent job"]);
    expect(
      spendCeiling.snapshot({ principalKind: "local-window", projectId: projectB }),
    ).toMatchObject({
      projectRemaining: { ceilingUsdCents: 4, usedUsdCents: 4, remainingUsdCents: 0 },
    });
  });
});

function appendToStatus(input: unknown): string | undefined {
  if (typeof input !== "object" || input === null || !("events" in input)) return undefined;
  const events = input.events;
  if (!Array.isArray(events)) return undefined;
  for (const event of events) {
    if (typeof event !== "object" || event === null || !("payload" in event)) continue;
    const payload = event.payload;
    if (typeof payload !== "object" || payload === null || !("toStatus" in payload)) continue;
    if (typeof payload.toStatus === "string") return payload.toStatus;
  }
  return undefined;
}

function hasFinalizedImage(directory: string): boolean {
  const root = join(directory, "generated-images");
  if (!existsSync(root)) return false;
  return readdirSync(root, { recursive: true }).some((entry) => {
    const name = String(entry);
    return name === "finalized.bin" || name.endsWith("/finalized.bin");
  });
}
