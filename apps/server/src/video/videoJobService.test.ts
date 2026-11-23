import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  decodeImageGenerationScopeId,
  decodeProviderInstanceId,
  decodeProviderModelId,
  type ProviderInstance,
} from "@octant/contracts";
import {
  decodeVideoModelCapabilities,
  type VideoModelCapabilities,
} from "@octant/contracts/video-generation";
import type {
  VideoAdapterPoll,
  VideoAdapterRequest,
  VideoAdapterStart,
  VideoGenerationDriver,
  VideoGenerationPorts,
} from "@octant/provider-sdk/video-generation";
import { CONFORMANCE_MP4_BYTES } from "@octant/provider-sdk/video-generation-conformance";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Journal } from "../persistence/journal";
import { applyMigrations, MIGRATIONS } from "../persistence/migrations";
import { catchUpProjection } from "../persistence/projection";
import { createPhase1RuntimeRegistries } from "../persistence/runtimeRegistry";
import { openSqlite } from "../persistence/sqlitePort";
import type { SpendCeilingTurnRequest } from "../spendCeilingService";
import { VideoClipStore } from "./videoClipStore";
import { VideoJobService } from "./videoJobService";

const now = "2026-11-22T12:00:00.000Z";
const directories: Array<string> = [];
const profileId = decodeProviderInstanceId("b4000000-0000-4000-8000-000000000001");
const scopeId = decodeImageGenerationScopeId("b4000000-0000-4000-8000-000000000002");
const projectId = "b4000000-0000-4000-8000-000000000003";
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
  start?: (ports: VideoGenerationPorts, request: VideoAdapterRequest) => Promise<VideoAdapterStart>;
  polls?: Array<VideoAdapterPoll>;
  poll?: (signal: AbortSignal) => Promise<VideoAdapterPoll>;
  cancel?: (signal: AbortSignal | undefined) => Promise<VideoAdapterPoll>;
  credential?: () => Promise<string>;
  forget?: () => Promise<"removed" | "failed">;
  model?: VideoModelCapabilities;
  /** Rejects models() once, on a numbered call, or for good, as a failed discovery read can. */
  modelsFail?: "once" | "always" | number;
}

function fakeDriver(script: Script) {
  const calls = { start: 0, poll: 0, cancel: 0, forget: 0 };
  const model =
    script.model ??
    capabilities({ cancel: "running", removal: { kind: "delete" }, resumeWindowHours: 24 });
  // Read counts persist across adapters: the service creates one per call.
  let modelsCalls = 0;
  let modelsFailOnce = script.modelsFail === "once";
  const driver: VideoGenerationDriver = {
    driverKind: "gemini-video",
    providerHosts: ["video.example.test"],
    create: ({ ports }) => {
      return {
        models: async () => {
          modelsCalls += 1;
          if (
            modelsFailOnce ||
            script.modelsFail === "always" ||
            script.modelsFail === modelsCalls
          ) {
            modelsFailOnce = false;
            throw { category: "unavailable", message: "Discovery failed." };
          }
          return [model];
        },
        start: async (request) => {
          calls.start += 1;
          return (
            (await script.start?.(ports, request)) ?? { status: "started", remoteId: "remote-1" }
          );
        },
        poll: async (_remoteId, signal) => {
          calls.poll += 1;
          if (script.poll !== undefined) return script.poll(signal);
          return (
            script.polls?.shift() ?? {
              status: "completed",
              video: { bytes: CONFORMANCE_MP4_BYTES, mediaType: "video/mp4" },
              usage: { outputTokens: 28_960 },
            }
          );
        },
        cancel: async (_remoteId, signal) => {
          calls.cancel += 1;
          return (await script.cancel?.(signal)) ?? { status: "cancelled" };
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
      };
    },
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
  const fetched: Array<string> = [];
  const sleeps: Array<number> = [];
  let clockMs = Date.parse(now);
  const instance: { current: ProviderInstance | undefined } = { current: profile() };
  const spend = {
    admit: vi.fn((_request: SpendCeilingTurnRequest) => ({
      status: "admitted" as const,
      reservedTokens: 0,
      reservations: [],
    })),
    settle: vi.fn(),
    abandon: vi.fn(),
  };
  const service = new VideoJobService({
    journal,
    projection: runtime.videoJobProjection,
    clips: new VideoClipStore(root),
    readProviderInstance: (id) => (String(id) === String(profileId) ? instance.current : undefined),
    listProviderInstances: () => (instance.current === undefined ? [] : [instance.current]),
    credentialResolver: {
      has: async () => true,
      resolve: async () => (await script.credential?.()) ?? "key",
    },
    fetch: async (input) => {
      fetched.push(String(input));
      return new Response("{}", { status: 200 });
    },
    uuid: () => crypto.randomUUID(),
    clock: () => new Date(clockMs++).toISOString(),
    actor,
    drivers: [fake.driver],
    admittedDriverKinds: new Set(["gemini-video"]),
    spendCeiling: spend,
    resolveThreadProjectId: () => projectId,
    sleep: (ms: number) => {
      sleeps.push(ms);
      return new Promise((resolve) => setTimeout(resolve, 1));
    },
    now: () => clockMs,
  });
  const advance = (ms: number) => {
    clockMs += ms;
  };
  return {
    service,
    calls: fake.calls,
    spend,
    instance,
    root,
    connection,
    journal,
    runtime,
    fetched,
    sleeps,
    advance,
  };
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

  it("settles at the estimate when Stop interrupts a start that may have reached the provider", async () => {
    let entered: () => void = () => undefined;
    const sending = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const { service } = harness({
      start: () =>
        new Promise((resolve) => {
          entered();
          setTimeout(
            () =>
              resolve({
                status: "failed",
                providerFailure: { category: "interrupted", message: "Aborted." },
              }),
            5,
          );
        }),
    });
    const queued = await enqueue(service);
    await sending;
    service.stop(queued.id);
    const done = await service.whenTerminal(queued.id);
    expect(done).toMatchObject({ status: "cancelled", settledCostUsdMicros: 695_040 });
  });

  it("bills nothing when Stop lands while the start is still reading its key", async () => {
    let keyRequested: () => void = () => undefined;
    const reading = new Promise<void>((resolve) => {
      keyRequested = resolve;
    });
    const { service, fetched, spend } = harness({
      credential: () => {
        keyRequested();
        return new Promise(() => undefined);
      },
      start: async (ports, request) => {
        try {
          await ports.request({
            url: "https://video.example.test/start",
            method: "POST",
            auth: { header: "authorization", scheme: "Bearer" },
            signal: request.signal,
          });
          return { status: "started", remoteId: "remote-1" };
        } catch {
          return {
            status: "failed",
            providerFailure: { category: "interrupted", message: "Aborted." },
          };
        }
      },
    });
    const queued = await enqueue(service);
    await reading;
    service.stop(queued.id);
    const done = await service.whenTerminal(queued.id);
    expect(done?.status).toBe("cancelled");
    expect(done?.settledCostUsdMicros).toBeUndefined();
    expect(fetched).toEqual([]);
    expect(spend.settle).not.toHaveBeenCalled();
  });

  it("bills nothing when shutdown lands while the start is still reading its key", async () => {
    let keyRequested: () => void = () => undefined;
    const reading = new Promise<void>((resolve) => {
      keyRequested = resolve;
    });
    const { service, fetched } = harness({
      credential: () => {
        keyRequested();
        return new Promise(() => undefined);
      },
      start: async (ports, request) => {
        try {
          await ports.request({
            url: "https://video.example.test/start",
            method: "POST",
            auth: { header: "authorization", scheme: "Bearer" },
            signal: request.signal,
          });
          return { status: "started", remoteId: "remote-1" };
        } catch {
          return {
            status: "failed",
            providerFailure: { category: "interrupted", message: "Aborted." },
          };
        }
      },
    });
    const queued = await enqueue(service);
    await reading;
    service.close();
    const job = service.getById(queued.id);
    expect(job).toMatchObject({ status: "failed", failure: { category: "interrupted" } });
    expect(job?.settledCostUsdMicros).toBeUndefined();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(fetched).toEqual([]);
  });

  it("settles a job whose time ran out without waiting on the provider's stop", async () => {
    let cancelSignal: AbortSignal | undefined;
    const harnessed = harness({
      polls: Array.from({ length: 1000 }, () => ({ status: "running" as const })),
      // A stop that finds the clip finished and starts downloading it again.
      cancel: (signal) => {
        cancelSignal = signal;
        return new Promise(() => undefined);
      },
    });
    const { service, calls, advance } = harnessed;
    const queued = await enqueue(service);
    await vi.waitFor(() => expect(service.getById(queued.id)?.remoteId).toBe("remote-1"));
    advance(31 * 60 * 1000);
    const done = await service.whenTerminal(queued.id);
    expect(done).toMatchObject({ status: "failed", settledCostUsdMicros: 695_040 });
    await vi.waitFor(() => expect(calls.cancel).toBe(1));
    expect(cancelSignal?.aborted).toBe(false);
    service.close();
    expect(cancelSignal?.aborted).toBe(true);
  });

  it("leaves a job running for the next host when shutdown interrupts its cancel", async () => {
    const { service, calls } = harness({
      polls: Array.from({ length: 1000 }, () => ({ status: "running" as const })),
      cancel: (signal) =>
        new Promise((resolve) =>
          signal?.addEventListener("abort", () =>
            resolve({
              status: "failed",
              providerFailure: { category: "interrupted", message: "Aborted." },
            }),
          ),
        ),
    });
    const queued = await enqueue(service);
    await vi.waitFor(() => expect(service.getById(queued.id)?.remoteId).toBe("remote-1"));
    service.stop(queued.id);
    await vi.waitFor(() => expect(calls.cancel).toBe(1));
    service.close();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(service.getById(queued.id)).toMatchObject({
      status: "running",
      remoteId: "remote-1",
    });
  });

  it("keeps a deleted thread's late clip off disk and ends its job cancelled", async () => {
    let releasePoll: ((answer: VideoAdapterPoll) => void) | undefined;
    const { service, root } = harness({
      poll: () => new Promise((resolve) => (releasePoll = resolve)),
    });
    const queued = await enqueue(service);
    await vi.waitFor(() => expect(service.getById(queued.id)?.remoteId).toBe("remote-1"));
    const purged = service.purgeScope(scopeId);
    releasePoll?.({
      status: "completed",
      video: { bytes: CONFORMANCE_MP4_BYTES, mediaType: "video/mp4" },
      usage: { outputTokens: 5792 },
    });
    await purged;
    const done = await service.whenTerminal(queued.id);
    expect(done).toMatchObject({ status: "cancelled", settledCostUsdMicros: 69_504 });
    expect(existsSync(join(root, "generated-video", String(scopeId)))).toBe(false);
  });

  it("leaves a job running for the next host when shutdown interrupts its poll", async () => {
    const { service } = harness({
      poll: (signal) =>
        new Promise((resolve) =>
          signal.addEventListener("abort", () =>
            resolve({
              status: "failed",
              providerFailure: { category: "interrupted", message: "Aborted." },
            }),
          ),
        ),
    });
    const queued = await enqueue(service);
    await vi.waitFor(() => expect(service.getById(queued.id)?.remoteId).toBe("remote-1"));
    service.close();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(service.getById(queued.id)?.status).toBe("running");
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

  it("holds no slot for a pending provider delete, and never asks the same delete twice", async () => {
    // Two finished jobs wait on deferred provider deletes while a third still
    // runs to the end, because a delete holds no concurrency slot; and a
    // sweep while one is in flight does not send the same DELETE again.
    const deferreds: Array<(outcome: "removed" | "failed") => void> = [];
    const { service, calls } = harness({
      forget: () =>
        new Promise<"removed" | "failed">((resolve) => {
          deferreds.push(resolve);
        }),
    });
    const jobs = await Promise.all([enqueue(service), enqueue(service), enqueue(service)]);
    const done = await Promise.all(jobs.map((job) => service.whenTerminal(job.id, 5_000)));
    expect(done.map((job) => job?.status)).toEqual(["completed", "completed", "completed"]);
    await vi.waitFor(() => expect(calls.forget).toBe(3));
    await service.retryOwedRemovals();
    expect(calls.forget).toBe(3);
    // A failed delete leaves the copy owed, so the sweep sends it again: the
    // in-flight marker was released when the first answer arrived.
    deferreds[0]?.("failed");
    await new Promise((resolve) => setTimeout(resolve, 0));
    const retry = service.retryOwedRemovals();
    await vi.waitFor(() => expect(calls.forget).toBe(4));
    deferreds[3]?.("removed");
    await retry;
    deferreds[1]?.("removed");
    deferreds[2]?.("removed");
    await vi.waitFor(() =>
      expect(jobs.map((job) => service.getById(job.id)?.providerCopy)).toEqual([
        "removed",
        "removed",
        "removed",
      ]),
    );
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

  it("keeps polling a sent job whose post-start model lookup fails", async () => {
    const { service } = harness({ modelsFail: 2 });
    const queued = await enqueue(service);
    const done = await service.whenTerminal(queued.id);
    expect(done).toMatchObject({ status: "completed", remoteId: "remote-1" });
  });

  it("ends a sent job as interrupted when discovery cannot describe it after a restart", async () => {
    const first = harness({
      polls: Array.from({ length: 50 }, () => ({ status: "running" as const })),
    });
    const queued = await enqueue(first.service);
    await vi.waitFor(() => expect(first.service.getById(queued.id)?.remoteId).toBe("remote-1"));
    first.service.close();

    const second = harness({ modelsFail: "always" }, first.root);
    await second.service.recover();
    const done = await second.service.whenTerminal(queued.id);
    expect(done).toMatchObject({
      status: "failed",
      settledCostUsdMicros: 695_040,
    });
  });

  it("keeps polling when the provider's cancel fails, and completes billed with its clip", async () => {
    let release: () => void = () => undefined;
    const started = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { service, calls, spend } = harness({
      cancel: async () => ({
        status: "failed",
        providerFailure: { category: "unavailable", message: "Could not reach the provider." },
      }),
      start: async () => {
        release();
        return { status: "started", remoteId: "remote-1" };
      },
    });
    const queued = await enqueue(service);
    await started;
    service.stop(queued.id);
    const done = await service.whenTerminal(queued.id);
    expect(done).toMatchObject({ status: "completed" });
    expect(done?.clip?.clipId).toBeDefined();
    expect(done?.settledCostUsdMicros).toBeGreaterThan(0);
    expect(calls.cancel).toBe(1);
    expect(spend.settle).toHaveBeenCalledTimes(1);
  });

  it("acts on the job's own answer after the provider's cancel request fails", async () => {
    // A failed cancel answer says the request failed, not the job: the
    // immediately following poll's confirmed failure ends the stopped job.
    let releasePoll: ((answer: VideoAdapterPoll) => void) | undefined;
    const { service, calls, spend } = harness({
      cancel: async () => ({
        status: "failed",
        providerFailure: { category: "provider-failed", message: "No such job." },
      }),
      poll: () =>
        new Promise((resolve) => {
          if (calls.poll === 1) resolve({ status: "running" });
          else releasePoll = resolve;
        }),
    });
    const queued = await enqueue(service);
    await vi.waitFor(() => expect(calls.poll).toBe(2));
    service.stop(queued.id);
    releasePoll?.({ status: "running" });
    await vi.waitFor(() => expect(calls.poll).toBe(3));
    releasePoll?.({
      status: "failed",
      providerFailure: { category: "provider-failed", message: "The job failed." },
    });
    const done = await service.whenTerminal(queued.id);
    expect(done?.status).toBe("cancelled");
    expect(done?.settledCostUsdMicros).toBeUndefined();
    expect(calls.cancel).toBe(1);
    expect(spend.abandon).toHaveBeenCalledTimes(1);
    expect(spend.settle).not.toHaveBeenCalled();
  });

  it("settles billed seconds plus the per-image fees the estimate charged for a first frame and a reference", async () => {
    const { service, spend } = harness({
      model: {
        ...capabilities({
          cancel: "running",
          removal: { kind: "delete" },
          resumeWindowHours: 24,
        }),
        price: {
          kind: "per-second",
          rates: [{ resolution: "720p", usdMicrosPerSecond: 100_000 }],
          inputUsdMicrosPerImage: 50_000,
        },
      },
      polls: [
        {
          status: "completed",
          video: { bytes: CONFORMANCE_MP4_BYTES, mediaType: "video/mp4" },
          usage: { billedSeconds: 2 },
        },
      ],
    });
    const image = { bytes: new Uint8Array([1]), mediaType: "image/png" as const };
    const queued = await service.enqueue({
      threadKind: "work-thread",
      scopeId,
      profileInstanceId: profileId,
      modelId,
      prompt: "A paper boat on a pond",
      options,
      firstFrame: image,
      references: [image],
    });
    expect(queued.estimatedCostUsdMicros).toBe(1_100_000);
    const done = await service.whenTerminal(queued.id);
    expect(done).toMatchObject({ status: "completed", settledCostUsdMicros: 300_000 });
    expect(spend.settle).toHaveBeenCalledTimes(1);
  });

  it("settles an interrupted start at the estimate when the request may have reached the provider", async () => {
    const { service, calls, spend } = harness({
      start: async () => ({
        status: "failed",
        providerFailure: { category: "unavailable", message: "The connection dropped." },
      }),
    });
    const queued = await enqueue(service);
    const done = await service.whenTerminal(queued.id);
    expect(done).toMatchObject({
      status: "failed",
      failure: {
        category: "interrupted",
        message: "The provider may have started this clip; the estimate is counted.",
      },
      settledCostUsdMicros: 695_040,
    });
    expect(spend.settle).toHaveBeenCalledTimes(1);
    expect(calls.forget).toBe(0);
  });

  it.each([
    { category: "provider-failed", message: "Rejected." },
    { category: "rate-limited", message: "The provider rate limit was reached." },
  ] as const)(
    "bills nothing when a start's confirmed $category failure could not have reached a job",
    async (providerFailure) => {
      const { service, spend } = harness({
        start: async () => ({ status: "failed", providerFailure }),
      });
      const queued = await enqueue(service);
      const done = await service.whenTerminal(queued.id);
      expect(done).toMatchObject({
        status: "failed",
        failure: { category: providerFailure.category },
      });
      expect(done?.settledCostUsdMicros).toBeUndefined();
      expect(spend.settle).not.toHaveBeenCalled();
      expect(spend.abandon).toHaveBeenCalledTimes(1);
    },
  );

  it("waits out the provider's retry-after before polling again", async () => {
    const { service, sleeps } = harness({
      polls: [
        {
          status: "failed",
          providerFailure: {
            category: "rate-limited",
            message: "Slow down.",
            retryAfterMs: 60_000,
          },
        },
        { status: "running" },
      ],
    });
    const queued = await enqueue(service);
    const done = await service.whenTerminal(queued.id);
    expect(done?.status).toBe("completed");
    expect(sleeps[0]).toBe(60_000);
  });

  it("keeps polling through a rate-limited answer until the provider completes the clip", async () => {
    const { service, calls } = harness({
      polls: [
        {
          status: "failed",
          providerFailure: { category: "rate-limited", message: "Slow down." },
        },
      ],
    });
    const queued = await enqueue(service);
    const done = await service.whenTerminal(queued.id);
    expect(calls.poll).toBeGreaterThanOrEqual(2);
    expect(done).toMatchObject({ status: "completed" });
    expect(done?.settledCostUsdMicros).toBeGreaterThan(0);
  });

  it("ends a job on the provider's own failure answer, billed nothing", async () => {
    const { service, spend } = harness({
      polls: [
        {
          status: "failed",
          providerFailure: { category: "provider-failed", message: "The clip failed." },
        },
      ],
    });
    const queued = await enqueue(service);
    const done = await service.whenTerminal(queued.id);
    expect(done).toMatchObject({
      status: "failed",
      failure: { category: "provider-failed" },
    });
    expect(done?.settledCostUsdMicros).toBeUndefined();
    expect(spend.abandon).toHaveBeenCalledTimes(1);
  });

  it("counts a resumed job's estimate against the ceiling after a restart", async () => {
    const first = harness({
      polls: Array.from({ length: 50 }, () => ({ status: "running" as const })),
    });
    const queued = await enqueue(first.service);
    await vi.waitFor(() => expect(first.service.getById(queued.id)?.remoteId).toBe("remote-1"));
    first.service.close();

    const second = harness(
      { polls: Array.from({ length: 50 }, () => ({ status: "running" as const })) },
      first.root,
    );
    let admitted: unknown;
    second.spend.admit.mockImplementation((request) => {
      admitted = request;
      return { status: "admitted" as const, reservedTokens: 0, reservations: [] };
    });
    await second.service.recover();
    // Recovery re-reserved the resumed job's estimate, under the same thread
    // and Project shape a fresh admission uses.
    expect(second.spend.admit).toHaveBeenCalledTimes(1);
    expect(admitted).toMatchObject({
      threadId: String(scopeId),
      threadType: "work-thread",
      projectId,
      estimatedCostUsdMicros: 695_040,
      countsAsTurn: false,
    });
    // A new admission the ceiling cannot cover alongside it is refused.
    second.spend.admit.mockReturnValueOnce({
      status: "refused",
      refusal: { kind: "monetary" },
    } as never);
    await expect(enqueue(second.service)).rejects.toThrow(
      "A spend ceiling cannot cover this clip.",
    );
    // The reservation settles when the resumed job ends.
    second.service.stop(queued.id);
    const done = await second.service.whenTerminal(queued.id);
    expect(done?.status).toBe("cancelled");
    expect(second.spend.settle).toHaveBeenCalledTimes(1);
  });

  it("refuses a queued clip whose profile was turned off before it sent", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { service, calls, spend, instance } = harness({
      start: async () => {
        await gate;
        return { status: "started", remoteId: "remote-1" };
      },
    });
    // Both run slots stay busy until the gate opens, so the third job is
    // still queued when the profile is turned off.
    const held = [await enqueue(service), await enqueue(service)];
    const queued = await enqueue(service);
    instance.current = { ...profile(), enabled: false };
    release();
    const done = await service.whenTerminal(queued.id);
    expect(done).toMatchObject({
      status: "failed",
      failure: {
        category: "unsupported",
        message: "That video profile was turned off before the clip started.",
      },
    });
    expect(done?.settledCostUsdMicros).toBeUndefined();
    expect(calls.start).toBe(2);
    expect(spend.abandon).toHaveBeenCalledTimes(1);
    for (const job of held) await service.whenTerminal(job.id);
  });
});
