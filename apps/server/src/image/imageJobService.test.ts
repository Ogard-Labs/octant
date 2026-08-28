import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  IMAGE_GENERATION_REQUEST_SHAPE,
  IMAGE_JOB_RESTART_INTERRUPTION_MESSAGE,
  decodeImageGenerationScopeId,
  decodeProviderInstanceId,
  decodeProviderModelId,
  type ProviderInstance,
} from "@octant/contracts";
import { Journal } from "../persistence/journal";
import { applyMigrations, MIGRATIONS } from "../persistence/migrations";
import { createPhase1RuntimeRegistries } from "../persistence/runtimeRegistry";
import { openSqlite } from "../persistence/sqlitePort";
import { readUsageDashboard } from "../usageDashboardService";
import { GeneratedImageStore } from "./generatedImageStore";
import type { ImageGenerationAdapter } from "./imageAdapter";
import { ImageJobService } from "./imageJobService";

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

function openHarness(adapter: ImageGenerationAdapter) {
  const directory = mkdtempSync(join(tmpdir(), "octant-image-job-"));
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
  });
  return { directory, connection, journal, runtime, attachments, service };
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
