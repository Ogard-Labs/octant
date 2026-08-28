import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  IMAGE_GENERATION_REQUEST_SHAPE,
  IMAGE_JOB_RESTART_INTERRUPTION_MESSAGE,
  MAX_GENERATED_IMAGE_BYTES,
  decodeImageGenerationScopeId,
  decodeProviderInstanceId,
  decodeProviderModelId,
  type ProviderInstance,
} from "@octant/contracts";
import { Journal } from "../persistence/journal";
import { ConcurrencyConflict } from "../persistence/journalErrors";
import { applyMigrations, MIGRATIONS } from "../persistence/migrations";
import { createPhase1RuntimeRegistries } from "../persistence/runtimeRegistry";
import { openSqlite } from "../persistence/sqlitePort";
import { readUsageDashboard } from "../usageDashboardService";
import { GeneratedImageStore } from "./generatedImageStore";
import type { ImageGenerationAdapter } from "./imageAdapter";
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

function openHarness(
  adapter: ImageGenerationAdapter,
  options: { readonly concurrency?: number; readonly failAppendAfter?: number } = {},
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
  const journal =
    options.failAppendAfter === undefined
      ? innerJournal
      : {
          append: (input: unknown) => {
            appendCount += 1;
            if (appendCount > options.failAppendAfter!) {
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
  const service = new ImageJobService({
    journal,
    projection: runtime.imageJobProjection,
    attachments,
    readProviderInstance: (id) => (String(id) === String(profileId) ? imageProfile() : undefined),
    credentialResolver: { has: async () => true, resolve: async () => "sk-test" },
    uuid: () => crypto.randomUUID(),
    clock: () => new Date(clockMs++).toISOString(),
    actor,
    createAdapter: () => adapter,
    ...(options.concurrency === undefined ? {} : { concurrency: options.concurrency }),
  });
  return { directory, connection, journal: innerJournal, runtime, attachments, service };
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
    expect(payload).not.toContain("b64");
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
      expect(rejections).toEqual([]);
    } finally {
      process.off("unhandledRejection", onReject);
    }
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
    for (const event of restartedJournal.replay({ afterSequence: 0, limit: 1000 } as never)) {
      restartedRuntime.imageJobProjection.apply(first.connection, event);
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
      credentialResolver: { has: async () => true, resolve: async () => "sk-test" },
      uuid: () => crypto.randomUUID(),
      clock: () => "2026-08-28T12:01:00.000Z",
      actor,
      createAdapter: () => ({ generate: secondGenerate }),
    });
    const interrupted = await restarted.reconcileInterruptedRunningJobs();
    expect(interrupted).toHaveLength(1);
    expect(interrupted[0]?.status).toBe("failed");
    expect(interrupted[0]?.failure?.message).toBe(IMAGE_JOB_RESTART_INTERRUPTION_MESSAGE);
    expect(secondGenerate).not.toHaveBeenCalled();
    void hangingResolve;
  });
});

function hasFinalizedImage(directory: string): boolean {
  const root = join(directory, "generated-images");
  if (!existsSync(root)) return false;
  return readdirSync(root, { recursive: true }).some((entry) => {
    const name = String(entry);
    return name === "finalized.bin" || name.endsWith("/finalized.bin");
  });
}
