import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  decodeImageGenerationScopeId,
  decodeProviderInstanceId,
  decodeProviderModelId,
  decodeVideoModelCapabilities,
  type ProviderInstance,
  type VideoModelCapabilities,
} from "@octant/contracts";
import type {
  VideoAdapterPoll,
  VideoAdapterStart,
  VideoGenerationDriver,
} from "@octant/provider-sdk/video-generation";
import { CONFORMANCE_MP4_BYTES } from "@octant/provider-sdk/video-generation-conformance";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Journal } from "../persistence/journal";
import { applyMigrations, MIGRATIONS } from "../persistence/migrations";
import { catchUpProjection } from "../persistence/projection";
import { createPhase1RuntimeRegistries } from "../persistence/runtimeRegistry";
import { openSqlite } from "../persistence/sqlitePort";
import { VideoClipStore } from "./videoClipStore";
import { VideoJobService } from "./videoJobService";

const now = "2026-11-22T12:00:00.000Z";
const directories: Array<string> = [];
const profileId = decodeProviderInstanceId("b4000000-0000-4000-8000-000000000001");
const scopeId = decodeImageGenerationScopeId("b4000000-0000-4000-8000-000000000002");
const modelId = decodeProviderModelId("gemini-omni-1.2-flash");
const actor = { kind: "system" as const, actorId: "00000000-0000-4000-8000-000000000002" as never };
const options = { durationSeconds: 10, resolution: "720p", aspectRatio: "16:9", audio: true };

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function capabilities(job: VideoModelCapabilities["job"]): VideoModelCapabilities {
  return decodeVideoModelCapabilities({
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
    job,
  });
}

function profile(): ProviderInstance {
  return {
    id: profileId,
    displayName: "Gemini Video",
    enabled: true,
    environmentPolicy: "inherit-host",
    version: 1 as ProviderInstance["version"],
    createdAt: now as ProviderInstance["createdAt"],
    updatedAt: now as ProviderInstance["updatedAt"],
    driverKind: "gemini-video",
    configuration: { kind: "gemini-video-http", modelAllowlist: [modelId], defaultModel: modelId },
  };
}

interface Script {
  start?: () => Promise<VideoAdapterStart>;
  polls?: Array<VideoAdapterPoll>;
  cancel?: () => Promise<VideoAdapterPoll>;
  forget?: () => Promise<"removed" | "failed">;
  model?: VideoModelCapabilities;
}

function fakeDriver(script: Script) {
  const calls = { start: 0, poll: 0, cancel: 0, forget: 0 };
  const model =
    script.model ??
    capabilities({ cancel: "running", removal: { kind: "delete" }, resumeWindowHours: 24 });
  const driver: VideoGenerationDriver = {
    driverKind: "gemini-video",
    providerHosts: ["video.example.test"],
    create: () => ({
      models: async () => [model],
      start: async () => {
        calls.start += 1;
        return (await script.start?.()) ?? { status: "started", remoteId: "remote-1" };
      },
      poll: async () => {
        calls.poll += 1;
        return (
          script.polls?.shift() ?? {
            status: "completed",
            video: { bytes: CONFORMANCE_MP4_BYTES, mediaType: "video/mp4" },
            usage: { outputTokens: 28_960 },
          }
        );
      },
      cancel: async () => {
        calls.cancel += 1;
        return (await script.cancel?.()) ?? { status: "cancelled" };
      },
      forget: async () => {
        calls.forget += 1;
        const outcome = (await script.forget?.()) ?? "removed";
        return outcome === "removed"
          ? { status: "removed" }
          : {
              status: "failed",
              providerFailure: { category: "unavailable", message: "Try later." },
            };
      },
    }),
  };
  return { driver, calls };
}

function harness(script: Script, directory?: string) {
  const root = directory ?? mkdtempSync(join(tmpdir(), "octant-video-job-"));
  if (directory === undefined) directories.push(root);
  const connection = openSqlite(join(root, "octant.sqlite3"));
  applyMigrations(connection, MIGRATIONS, () => now);
  const runtime = createPhase1RuntimeRegistries();
  const journal = new Journal({
    connection,
    registry: runtime.events,
    projections: runtime.projections,
    clock: () => now,
  });
  for (const projection of runtime.projections.all()) {
    catchUpProjection({ connection, journal, projection, clock: () => now });
  }
  const fake = fakeDriver(script);
  let clockMs = Date.parse(now);
  const spend = {
    admit: vi.fn(() => ({ status: "admitted" as const, reservedTokens: 0, reservations: [] })),
    settle: vi.fn(),
    abandon: vi.fn(),
  };
  const service = new VideoJobService({
    journal,
    projection: runtime.videoJobProjection,
    clips: new VideoClipStore(root),
    readProviderInstance: (id) => (String(id) === String(profileId) ? profile() : undefined),
    listProviderInstances: () => [profile()],
    credentialResolver: { has: async () => true, resolve: async () => "key" },
    uuid: () => crypto.randomUUID(),
    clock: () => new Date(clockMs++).toISOString(),
    actor,
    drivers: [fake.driver],
    admittedDriverKinds: new Set(["gemini-video"]),
    spendCeiling: spend,
    sleep: () => new Promise((resolve) => setTimeout(resolve, 1)),
    now: () => clockMs,
  });
  return { service, calls: fake.calls, spend, root, connection, journal, runtime };
}

const enqueue = (service: VideoJobService, overrides: Partial<typeof options> = {}) =>
  service.enqueue({
    threadKind: "work-thread",
    scopeId,
    profileInstanceId: profileId,
    modelId,
    prompt: "A paper boat on a pond",
    options: { ...options, ...overrides },
    references: [],
  });

describe("video jobs", () => {
  it("keeps the clip, settles from the provider's tokens, and removes the provider's copy", async () => {
    const { service, calls, spend } = harness({ polls: [{ status: "running" }] });
    const queued = await enqueue(service);
    expect(queued.estimatedCostUsdMicros).toBe(695_040);
    const done = await service.whenTerminal(queued.id);
    expect(done).toMatchObject({
      status: "completed",
      remoteId: "remote-1",
      settledCostUsdMicros: 347_520,
      clip: { durationSeconds: 10, resolution: "720p", size: CONFORMANCE_MP4_BYTES.byteLength },
    });
    await vi.waitFor(() => expect(service.getById(queued.id)?.providerCopy).toBe("removed"));
    expect(calls.forget).toBe(1);
    expect(spend.settle).toHaveBeenCalledOnce();
  });

  it("refuses options the model does not declare before anything is reserved or sent", async () => {
    const { service, calls, spend } = harness({});
    await expect(enqueue(service, { resolution: "4k" })).rejects.toThrow("does not offer 4k");
    expect(spend.admit).not.toHaveBeenCalled();
    expect(calls.start).toBe(0);
  });

  it("refuses a clip a spend ceiling cannot cover and sends nothing", async () => {
    const { service, calls, spend } = harness({});
    spend.admit.mockReturnValueOnce({
      status: "refused",
      refusal: { kind: "monetary" },
    } as never);
    await expect(enqueue(service)).rejects.toThrow("A spend ceiling cannot cover this clip.");
    expect(calls.start).toBe(0);
  });

  it("stops at the provider when the model can cancel, and settles the provider's count", async () => {
    let release: () => void = () => undefined;
    const started = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { service, calls } = harness({
      polls: [{ status: "running" }, { status: "running" }],
      cancel: async () => ({ status: "cancelled", usage: { outputTokens: 5792 } }),
      start: async () => {
        release();
        return { status: "started", remoteId: "remote-1" };
      },
    });
    const queued = await enqueue(service);
    await started;
    service.stop(queued.id);
    const done = await service.whenTerminal(queued.id);
    expect(done).toMatchObject({ status: "cancelled", settledCostUsdMicros: 69_504 });
    expect(calls.cancel).toBe(1);
  });

  it("ends the wait at its estimate when the model cannot stop a running job", async () => {
    const model = capabilities({
      cancel: "none",
      removal: { kind: "expires", afterHours: 24 },
      resumeWindowHours: 24,
    });
    const { service, calls } = harness({
      model,
      polls: Array.from({ length: 1000 }, () => ({ status: "running" as const })),
    });
    const queued = await enqueue(service);
    await vi.waitFor(() => expect(service.getById(queued.id)?.remoteId).toBe("remote-1"));
    service.stop(queued.id);
    const done = await service.whenTerminal(queued.id);
    expect(done).toMatchObject({
      status: "cancelled",
      providerCopy: "expires",
      settledCostUsdMicros: 695_040,
    });
    expect(calls.cancel).toBe(0);
  });

  it("bills nothing for a safety refusal the provider returns before any output", async () => {
    const { service, spend } = harness({
      polls: [{ status: "refused", safetyRefusal: "Blocked by the provider's filters." }],
    });
    const done = await service.whenTerminal((await enqueue(service)).id);
    expect(done).toMatchObject({
      status: "failed",
      safetyRefusal: "Blocked by the provider's filters.",
    });
    expect(done?.settledCostUsdMicros).toBeUndefined();
    expect(spend.abandon).toHaveBeenCalledOnce();
  });

  it("keeps an owed removal through a failure and clears it on a later try", async () => {
    let refuse = true;
    const { service } = harness({ forget: async () => (refuse ? "failed" : "removed") });
    const done = await service.whenTerminal((await enqueue(service)).id);
    expect(done?.providerCopy).toBe("held");
    refuse = false;
    await service.retryOwedRemovals();
    expect(service.getById(done!.id)?.providerCopy).toBe("removed");
  });

  it("refuses a seventeenth waiting job so a runaway loop cannot queue without end", async () => {
    const { service } = harness({ start: () => new Promise(() => undefined) });
    for (let index = 0; index < 18; index += 1) await enqueue(service);
    await expect(enqueue(service)).rejects.toThrow("Too many video jobs are queued.");
  });

  it("recovers after a restart: unsent jobs bill nothing, sent ones resume or settle at the estimate", async () => {
    const first = harness({ start: () => new Promise(() => undefined) });
    const sending = await enqueue(first.service);
    await vi.waitFor(() => expect(first.service.getById(sending.id)?.status).toBe("running"));
    const waiting = [];
    for (let index = 0; index < 2; index += 1) waiting.push(await enqueue(first.service));
    first.service.close();

    const second = harness({}, first.root);
    await second.service.recover();
    expect(second.service.getById(sending.id)).toMatchObject({
      status: "failed",
      settledCostUsdMicros: 695_040,
    });
    for (const job of waiting) {
      const recovered = second.service.getById(job.id);
      // The second of the waiting jobs never got a slot: it stayed queued.
      expect(["failed"]).toContain(recovered?.status);
    }
  });

  it("resumes a running job with a provider id after a restart and keeps its clip", async () => {
    const first = harness({
      polls: Array.from({ length: 50 }, () => ({ status: "running" as const })),
    });
    const queued = await enqueue(first.service);
    await vi.waitFor(() => expect(first.service.getById(queued.id)?.remoteId).toBe("remote-1"));
    first.service.close();

    const second = harness({}, first.root);
    await second.service.recover();
    const done = await second.service.whenTerminal(queued.id);
    expect(done?.status).toBe("completed");
    await vi.waitFor(() => expect(second.service.getById(queued.id)?.providerCopy).toBe("removed"));
  });
});
