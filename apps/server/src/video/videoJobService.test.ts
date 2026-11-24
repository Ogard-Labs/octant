import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  decodeImageGenerationScopeId,
  decodeProviderInstanceId,
  decodeProviderModelId,
  type ProviderInstance,
  type ProviderModelId,
} from "@octant/contracts";
import {
  decodeVideoJobId,
  decodeVideoJobQueued,
  decodeVideoJobStatusChanged,
  decodeVideoModelCapabilities,
  VIDEO_JOB_TIMEOUT_MS,
  type VideoModelCapabilities,
} from "@octant/contracts/video-generation";
import {
  isProviderFailure,
  type VideoAdapterForget,
  type VideoAdapterPoll,
  type VideoAdapterRequest,
  type VideoAdapterStart,
  type VideoGenerationDriver,
  type VideoGenerationPorts,
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
import { VIDEO_HTTP_LIMITS } from "./videoHttp";
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

function capabilities(
  job: VideoModelCapabilities["job"],
  model: string = "gemini-omni-1.2-flash",
): VideoModelCapabilities {
  return decodeVideoModelCapabilities({
    modelId: model,
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

function profile(
  allowlist: ReadonlyArray<ProviderModelId> = [modelId],
  driverKind: "gemini-video" | "runway-video" | "fal-video" = "gemini-video",
): ProviderInstance {
  const base = {
    id: profileId,
    displayName: "Video Provider",
    enabled: true,
    environmentPolicy: "inherit-host" as const,
    version: 1 as ProviderInstance["version"],
    createdAt: now as ProviderInstance["createdAt"],
    updatedAt: now as ProviderInstance["updatedAt"],
  };
  const models = {
    modelAllowlist: [...allowlist],
    defaultModel: allowlist[0] ?? modelId,
  };
  switch (driverKind) {
    case "runway-video":
      return {
        ...base,
        driverKind,
        configuration: { kind: "runway-video-http", ...models },
      };
    case "fal-video":
      return {
        ...base,
        driverKind,
        configuration: { kind: "fal-video-http", ...models },
      };
    default:
      return {
        ...base,
        driverKind,
        configuration: { kind: "gemini-video-http", ...models },
      };
  }
}

interface Script {
  start?: (ports: VideoGenerationPorts, request: VideoAdapterRequest) => Promise<VideoAdapterStart>;
  response?: () => Response;
  polls?: Array<VideoAdapterPoll>;
  poll?: (signal: AbortSignal) => Promise<VideoAdapterPoll>;
  cancel?: (signal: AbortSignal | undefined) => Promise<VideoAdapterPoll>;
  credential?: () => Promise<string>;
  forget?: () => Promise<"removed" | "failed" | VideoAdapterForget>;
  model?: VideoModelCapabilities;
  beforeModels?: (call: number) => Promise<void>;
  /** Rejects models() once, on a numbered call, or for good, as a failed discovery read can. */
  modelsFail?: "once" | "always" | number;
  /** Answers models() from the read's count, for a catalog that changes under the host. */
  modelsRead?: (call: number) => ReadonlyArray<VideoModelCapabilities>;
  /** The profile's configured models; a shorter answer is a partial read. */
  allowlist?: ReadonlyArray<ProviderModelId>;
  /** Which video driver the profile and adapter pose as; Gemini by default. */
  driverKind?: "gemini-video" | "runway-video" | "fal-video";
}

function fakeDriver(script: Script) {
  const calls = { start: 0, poll: 0, cancel: 0, forget: 0, models: 0 };
  const model =
    script.model ??
    capabilities({ cancel: "running", removal: { kind: "delete" }, resumeWindowHours: 24 });
  let modelsFailOnce = script.modelsFail === "once";
  const driver: VideoGenerationDriver = {
    driverKind: script.driverKind ?? "gemini-video",
    providerName: "Example Video",
    providerHosts: ["video.example.test"],
    create: ({ ports }) => {
      return {
        models: async () => {
          calls.models += 1;
          const call = calls.models;
          if (script.beforeModels !== undefined) await script.beforeModels(call);
          if (modelsFailOnce || script.modelsFail === "always" || script.modelsFail === call) {
            modelsFailOnce = false;
            throw { category: "unavailable", message: "Discovery failed." };
          }
          return script.modelsRead?.(call) ?? [model];
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
          if (outcome === "removed") return { status: "removed" };
          if (outcome === "failed") {
            return {
              status: "failed",
              providerFailure: { category: "unavailable", message: "Try later." },
            };
          }
          return outcome;
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
  const instance: { current: ProviderInstance | undefined } = {
    current: profile(script.allowlist, script.driverKind),
  };
  const spend = {
    admit: vi.fn((_request: SpendCeilingTurnRequest) => ({
      status: "admitted" as const,
      reservedTokens: 0,
      reservations: [],
    })),
    settle: vi.fn(),
    abandon: vi.fn(),
  };
  const clips = new VideoClipStore(root);
  const service = new VideoJobService({
    journal,
    projection: runtime.videoJobProjection,
    clips,
    readProviderInstance: (id) => (String(id) === String(profileId) ? instance.current : undefined),
    listProviderInstances: () => (instance.current === undefined ? [] : [instance.current]),
    credentialResolver: {
      has: async () => true,
      resolve: async () => (await script.credential?.()) ?? "key",
    },
    fetch: async (input) => {
      fetched.push(String(input));
      return script.response?.() ?? new Response("{}", { status: 200 });
    },
    uuid: () => crypto.randomUUID(),
    clock: () => new Date(clockMs++).toISOString(),
    actor,
    drivers: [fake.driver],
    admittedDriverKinds: new Set([script.driverKind ?? "gemini-video"]),
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
    clips,
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

  it.each([
    [{ outputTokens: 28_960 }, 347_520],
    [undefined, 695_040],
  ] as const)(
    "settles a billed failure with usage %j without keeping a clip",
    async (usage, cost) => {
      const { service, spend } = harness({
        polls: [
          {
            status: "failed",
            providerFailure: {
              category: "protocol",
              message: "The provider returned an invalid clip.",
            },
            billed: true,
            ...(usage === undefined ? {} : { usage }),
          },
        ],
      });
      const queued = await enqueue(service);
      const done = await service.whenTerminal(queued.id);
      expect(done).toMatchObject({ status: "failed", settledCostUsdMicros: cost });
      expect(done?.clip).toBeUndefined();
      expect(spend.settle).toHaveBeenCalledOnce();
      expect(spend.abandon).not.toHaveBeenCalled();
    },
  );

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

  it("releases the reservation when a start times out before fetching with its key", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const reading = Promise.withResolvers<void>();
    const credential = Promise.withResolvers<string>();
    const { service, fetched, spend } = harness({
      credential: () => {
        reading.resolve();
        return credential.promise;
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
        } catch (error) {
          if (!isProviderFailure(error)) throw error;
          return { status: "failed", providerFailure: error };
        }
      },
    });
    try {
      const job = await enqueue(service);
      await reading.promise;
      await vi.advanceTimersByTimeAsync(VIDEO_HTTP_LIMITS.connectionTimeoutMs);
      const done = await service.whenTerminal(job.id);
      expect(done).toMatchObject({ status: "failed", failure: { category: "unavailable" } });
      expect(done?.settledCostUsdMicros).toBeUndefined();
      expect(spend.abandon).toHaveBeenCalledOnce();
      expect(spend.settle).not.toHaveBeenCalled();

      credential.resolve("key");
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(fetched).toEqual([]);
    } finally {
      credential.resolve("key");
      service.close();
      vi.useRealTimers();
    }
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

  it("leaves a successful start for recovery when shutdown interrupts its model lookup", async () => {
    const lookingUp = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    const { service, connection, root, calls, spend } = harness({
      beforeModels: async (call) => {
        if (call !== 2) return;
        lookingUp.resolve();
        await resume.promise;
      },
      poll: async () => ({ status: "running" }),
    });
    const queued = await enqueue(service);
    await lookingUp.promise;
    const running = service.getById(queued.id);
    expect(running?.status).toBe("running");
    expect(calls.start).toBe(1);
    service.close();
    resume.resolve();
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(service.getById(queued.id)).toEqual(running);
    expect(calls.poll).toBe(0);
    expect(spend.settle).not.toHaveBeenCalled();
    connection.close();

    const restarted = harness({}, root);
    try {
      await restarted.service.recover();
      expect(restarted.service.getById(queued.id)).toMatchObject({
        status: "failed",
        failure: { category: "interrupted" },
        settledCostUsdMicros: queued.estimatedCostUsdMicros,
      });
      expect(restarted.calls.start).toBe(0);
    } finally {
      restarted.service.close();
      restarted.connection.close();
    }
  });

  it("refuses a new clip quote that comes back after shutdown starts", async () => {
    const lookingUp = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    const { service, connection, calls, spend } = harness({
      beforeModels: () => {
        lookingUp.resolve();
        return resume.promise;
      },
    });
    const pending = enqueue(service);
    await lookingUp.promise;
    service.close();
    connection.close();
    resume.resolve();

    await expect(pending).rejects.toThrow("The host is shutting down.");
    expect(spend.admit).not.toHaveBeenCalled();
    expect(calls.start).toBe(0);
  });

  it("releases both slots when start responses stall past the job deadline", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const reading = Promise.withResolvers<void>();
    let responses = 0;
    let cancelledBodies = 0;
    const { service, calls } = harness({
      response: () => {
        responses += 1;
        if (responses === 2) reading.resolve();
        return responses > 2
          ? Response.json({ id: "remote-next" })
          : new Response(
              new ReadableStream<Uint8Array>({
                cancel: () => {
                  cancelledBodies += 1;
                },
              }),
            );
      },
      start: async (ports, request) => {
        try {
          const response = await ports.request({
            url: "https://video.example.test/start",
            method: "POST",
            auth: { header: "authorization", scheme: "Bearer" },
            signal: request.signal,
          });
          await response.json();
          return { status: "started", remoteId: "remote-next" };
        } catch {
          return {
            status: "failed",
            providerFailure: { category: "interrupted", message: "Aborted." },
          };
        }
      },
    });
    try {
      const first = await enqueue(service);
      const second = await enqueue(service);
      const next = await enqueue(service);
      await reading.promise;
      expect(calls.start).toBe(2);
      await vi.advanceTimersByTimeAsync(VIDEO_JOB_TIMEOUT_MS);
      for (const clip of [first, second]) {
        expect(service.getById(clip.id)).toMatchObject({
          status: "failed",
          settledCostUsdMicros: 695_040,
          failure: { category: "interrupted" },
        });
      }
      expect(cancelledBodies).toBe(2);
      expect(await service.whenTerminal(next.id)).toMatchObject({ status: "completed" });
    } finally {
      service.close();
      await new Promise<void>((resolve) => setImmediate(resolve));
      vi.useRealTimers();
    }
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

  it("leaves a job for recovery when its clip write finishes after shutdown", async () => {
    const { service, clips, root, spend, calls, connection } = harness({});
    const entered = Promise.withResolvers<string>();
    const resume = Promise.withResolvers<void>();
    const written = Promise.withResolvers<void>();
    const write = clips.write.bind(clips);
    vi.spyOn(clips, "write").mockImplementation(async (scope, clipId, bytes) => {
      entered.resolve(String(clipId));
      await resume.promise;
      const result = await write(scope, clipId, bytes);
      written.resolve();
      return result;
    });

    const queued = await enqueue(service);
    const clipId = await entered.promise;
    service.close();
    connection.close();
    resume.resolve();
    await written.promise;
    const clipPath = join(root, "generated-video", String(scopeId), `${clipId}.mp4`);
    await vi.waitFor(() => expect(existsSync(clipPath)).toBe(false));
    expect(spend.settle).not.toHaveBeenCalled();
    expect(calls.forget).toBe(0);

    const restarted = harness({}, root);
    try {
      expect(restarted.service.getById(queued.id)).toMatchObject({
        status: "running",
        remoteId: "remote-1",
      });
      await restarted.service.recover();
      await expect(restarted.service.whenTerminal(queued.id)).resolves.toMatchObject({
        status: "completed",
        settledCostUsdMicros: 347_520,
      });
    } finally {
      restarted.service.close();
      restarted.connection.close();
    }
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
      settledCostUsdMicros: 695_040,
    });
    expect(calls.cancel).toBe(0);
    // One removal is asked of a provider-expiring model too.
    await vi.waitFor(() => expect(service.getById(queued.id)?.providerCopy).toBe("removed"));
    expect(calls.forget).toBe(1);
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

  it.each([undefined, 0, 600_000])(
    "settles a billed safety refusal with the reported cost (%s) or its estimate",
    async (costUsdMicros) => {
      const { service, spend } = harness({
        polls: [
          {
            status: "refused",
            safetyRefusal: "Blocked by the provider's filters.",
            ...(costUsdMicros === undefined ? { billed: true } : { usage: { costUsdMicros } }),
          },
        ],
      });
      const job = await enqueue(service);
      expect(await service.whenTerminal(job.id)).toMatchObject({
        status: "failed",
        safetyRefusal: "Blocked by the provider's filters.",
        settledCostUsdMicros: costUsdMicros ?? job.estimatedCostUsdMicros,
      });
      expect(spend.settle).toHaveBeenCalledOnce();
      expect(spend.abandon).not.toHaveBeenCalled();
    },
  );

  it("keeps an owed removal through a failure and clears it on a later try", async () => {
    let refuse = true;
    const { service } = harness({ forget: async () => (refuse ? "failed" : "removed") });
    const done = await service.whenTerminal((await enqueue(service)).id);
    expect(done?.providerCopy).toBe("held");
    refuse = false;
    await service.retryOwedRemovals();
    expect(service.getById(done!.id)?.providerCopy).toBe("removed");
  });

  it("keeps an owed removal when the provider delete rejects", async () => {
    const forget = vi
      .fn<() => Promise<"removed" | "failed">>()
      .mockRejectedValueOnce(new Error("Provider connection closed"))
      .mockResolvedValue("removed");
    const { service } = harness({ forget });
    const job = await enqueue(service);
    expect(await service.whenTerminal(job.id)).toMatchObject({
      status: "completed",
      providerCopy: "held",
    });
    await vi.waitFor(() => expect(forget).toHaveBeenCalledOnce());
    await service.retryOwedRemovals();
    expect(forget).toHaveBeenCalledTimes(2);
    expect(service.getById(job.id)?.providerCopy).toBe("removed");
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

  it("lets the provider's own expiry end a refused removal, and skips the DELETE on that profile's later jobs", async () => {
    const model = capabilities({
      cancel: "running",
      removal: { kind: "expires", afterHours: 2 },
      resumeWindowHours: 24,
    });
    const { service, calls } = harness({
      model,
      forget: async () => ({
        status: "failed",
        providerFailure: { category: "unauthorized", message: "The key cannot delete payloads." },
      }),
    });
    const firstId = (await enqueue(service)).id;
    await service.whenTerminal(firstId);
    await vi.waitFor(() => expect(service.getById(firstId)?.providerCopy).toBe("expires"));
    expect(calls.forget).toBe(1);

    // A refused removal is never put on the retry loop.
    await service.retryOwedRemovals();
    expect(calls.forget).toBe(1);

    const secondId = (await enqueue(service)).id;
    await service.whenTerminal(secondId);
    expect(service.getById(secondId)?.providerCopy).toBe("expires");
    expect(calls.forget).toBe(1);
  });

  it("retries an owed removal on the loop but drops it once the provider's expiry has passed", async () => {
    const model = capabilities({
      cancel: "running",
      removal: { kind: "expires", afterHours: 2 },
      resumeWindowHours: 24,
    });
    const { service, calls, advance } = harness({
      model,
      forget: async () => ({
        status: "failed",
        providerFailure: { category: "provider-failed", message: "fal is down." },
      }),
    });
    const doneId = (await enqueue(service)).id;
    await service.whenTerminal(doneId);
    // The first removal has been asked by the time the loop next runs.
    await vi.waitFor(() => expect(calls.forget).toBe(1));
    expect(service.getById(doneId)?.providerCopy).toBe("held");

    await service.retryOwedRemovals();
    expect(calls.forget).toBe(2);
    expect(service.getById(doneId)?.providerCopy).toBe("held");

    advance(2 * 3_600_000 + 1);
    await service.retryOwedRemovals();
    expect(calls.forget).toBe(2);
    expect(service.getById(doneId)?.providerCopy).toBe("expires");
  });

  it("keeps a refused Runway removal owed so a restored key retries it", async () => {
    let refuse = true;
    const { service, calls } = harness({
      driverKind: "runway-video",
      forget: async () =>
        refuse
          ? {
              status: "failed" as const,
              providerFailure: {
                category: "unauthorized" as const,
                message: "The key cannot delete tasks.",
              },
            }
          : "removed",
    });
    const doneId = (await enqueue(service)).id;
    await service.whenTerminal(doneId);
    // A model that deletes for real gets no expiry fallback for a 403: the
    // copy stays owed and the loop keeps asking.
    await vi.waitFor(() => expect(calls.forget).toBe(1));
    expect(service.getById(doneId)?.providerCopy).toBe("held");
    await service.retryOwedRemovals();
    expect(calls.forget).toBe(2);
    expect(service.getById(doneId)?.providerCopy).toBe("held");

    refuse = false;
    await service.retryOwedRemovals();
    expect(service.getById(doneId)?.providerCopy).toBe("removed");
  });

  it("counts a provider-expiring copy's window from when the clip was made", async () => {
    const model = capabilities({
      cancel: "running",
      removal: { kind: "expires", afterHours: 2 },
      resumeWindowHours: 24,
    });
    let polls = 0;
    const { service, calls, advance } = harness({
      model,
      poll: async () => {
        polls += 1;
        // The clip takes 25 minutes to make, still inside the job's deadline.
        if (polls === 1) advance(25 * 60_000);
        return polls === 1
          ? { status: "running" as const }
          : {
              status: "completed" as const,
              video: { bytes: CONFORMANCE_MP4_BYTES, mediaType: "video/mp4" },
              usage: { outputTokens: 28_960 },
            };
      },
      forget: async () => ({
        status: "failed",
        providerFailure: { category: "provider-failed", message: "fal is down." },
      }),
    });
    const doneId = (await enqueue(service)).id;
    await service.whenTerminal(doneId);
    await vi.waitFor(() => expect(calls.forget).toBe(1));
    expect(service.getById(doneId)?.providerCopy).toBe("held");

    // Two hours from the job's start have passed, but only 100 minutes from
    // when the clip was made: the copy is still owed and still asked.
    advance(100 * 60_000);
    await service.retryOwedRemovals();
    expect(calls.forget).toBe(2);
    expect(service.getById(doneId)?.providerCopy).toBe("held");

    advance(25 * 60_000);
    await service.retryOwedRemovals();
    expect(calls.forget).toBe(2);
    expect(service.getById(doneId)?.providerCopy).toBe("expires");
  });

  it("drops a recovered owed removal past the provider's expiry after a restart", async () => {
    const model = capabilities({
      cancel: "running",
      removal: { kind: "expires", afterHours: 2 },
      resumeWindowHours: 24,
    });
    const down = {
      forget: async () => ({
        status: "failed" as const,
        providerFailure: { category: "provider-failed" as const, message: "fal is down." },
      }),
    };
    const first = harness({ model, ...down });
    const doneId = (await enqueue(first.service)).id;
    await first.service.whenTerminal(doneId);
    await vi.waitFor(() => expect(first.calls.forget).toBe(1));
    first.service.close();

    const second = harness({ model, ...down }, first.root);
    await second.service.recover();
    expect(second.service.getById(doneId)?.providerCopy).toBe("held");

    // Inside the expiry window the restarted host still asks; the cutoff is
    // read back from the journaled job, not remembered in memory.
    await second.service.retryOwedRemovals();
    expect(second.calls.forget).toBeGreaterThanOrEqual(1);
    expect(second.service.getById(doneId)?.providerCopy).toBe("held");

    second.advance(2 * 3_600_000 + 60_000);
    const asked = second.calls.forget;
    await second.service.retryOwedRemovals();
    expect(second.calls.forget).toBe(asked);
    expect(second.service.getById(doneId)?.providerCopy).toBe("expires");
  });

  it("keeps retrying an owed removal without ever reading the catalog again", async () => {
    const { service, calls } = harness({
      // Admission and the job read the catalog once each; every later read fails.
      modelsFail: 3,
      forget: async () => ({
        status: "failed",
        providerFailure: { category: "provider-failed", message: "The provider is down." },
      }),
    });
    const doneId = (await enqueue(service)).id;
    await service.whenTerminal(doneId);
    await vi.waitFor(() => expect(calls.forget).toBe(1));
    expect(service.getById(doneId)?.providerCopy).toBe("held");
    const reads = calls.models;

    await service.retryOwedRemovals();
    expect(calls.forget).toBe(2);
    expect(calls.models).toBe(reads);
    expect(service.getById(doneId)?.providerCopy).toBe("held");
  });

  it("drops an expired owed copy from the job's own record before any read or call", async () => {
    const model = capabilities({
      cancel: "running",
      removal: { kind: "expires", afterHours: 2 },
      resumeWindowHours: 24,
    });
    const { service, calls, advance } = harness({
      model,
      // Discovery stops answering once the job is admitted and read.
      modelsFail: 3,
      forget: async () => ({
        status: "failed",
        providerFailure: { category: "provider-failed", message: "fal is down." },
      }),
    });
    const doneId = (await enqueue(service)).id;
    await service.whenTerminal(doneId);
    await vi.waitFor(() => expect(calls.forget).toBe(1));
    expect(service.getById(doneId)?.providerCopy).toBe("held");
    const reads = calls.models;

    advance(2 * 3_600_000 + 1);
    await service.retryOwedRemovals();
    expect(service.getById(doneId)?.providerCopy).toBe("expires");
    expect(calls.forget).toBe(1);
    expect(calls.models).toBe(reads);
  });

  it("keeps a copy journaled before its cleanup was recorded owed past any expiry", async () => {
    const model = capabilities({
      cancel: "running",
      removal: { kind: "expires", afterHours: 2 },
      resumeWindowHours: 24,
    });
    const { service, calls, runtime, advance } = harness({
      model,
      forget: async () => ({
        status: "failed",
        providerFailure: { category: "provider-failed", message: "fal is down." },
      }),
    });
    const doneId = (await enqueue(service)).id;
    await service.whenTerminal(doneId);
    const done = service.getById(doneId);
    expect(done?.providerRemoval).toEqual({ kind: "expires", afterHours: 2 });
    await vi.waitFor(() => expect(calls.forget).toBe(1));

    // A job the journal wrote before cleanup kept the declaration: its
    // events still decode, and nothing on it says the copy expires.
    const legacyId = decodeVideoJobId(crypto.randomUUID());
    const { providerRemoval: _kept, remoteId, providerCopy: _copy, ...legacyJob } = done!;
    runtime.videoJobProjection.applyQueued(
      decodeVideoJobQueued({
        job: { ...legacyJob, id: legacyId, status: "queued", providerCopy: "none" },
      }).job,
    );
    runtime.videoJobProjection.applyStatusChanged(
      decodeVideoJobStatusChanged({
        jobId: legacyId,
        fromStatus: "queued",
        toStatus: "completed",
        version: legacyJob.version + 1,
        updatedAt: legacyJob.updatedAt,
        remoteId,
        providerCopy: "held",
      }),
    );
    expect(service.getById(legacyId)?.providerRemoval).toBeUndefined();

    // Past the expiry the recorded copy is dropped without a call, while the
    // copy without a declaration keeps its safe default: still owed, still
    // asked, never written off.
    const asked = calls.forget;
    advance(2 * 3_600_000 + 1);
    await service.retryOwedRemovals();
    expect(service.getById(doneId)?.providerCopy).toBe("expires");
    expect(service.getById(legacyId)?.providerCopy).toBe("held");
    expect(calls.forget).toBe(asked + 1);
  });

  it("refuses a seventeenth waiting job so a runaway loop cannot queue without end", async () => {
    const { service } = harness({ start: () => new Promise(() => undefined) });
    for (let index = 0; index < 18; index += 1) await enqueue(service);
    await expect(enqueue(service)).rejects.toThrow("Too many video jobs are queued.");
  });

  it("cancels a queued clip before either occupied generation slot opens", async () => {
    const { service, calls } = harness({ start: () => new Promise(() => undefined) });
    await enqueue(service);
    await enqueue(service);
    const queued = await enqueue(service);
    expect(service.getById(queued.id)?.status).toBe("queued");
    service.stop(queued.id);
    expect(service.getById(queued.id)).toMatchObject({ status: "cancelled" });
    expect(service.getById(queued.id)?.settledCostUsdMicros).toBeUndefined();
    expect(calls.start).toBe(2);
  });

  it("finishes startup while a recovered provider delete is still pending", async () => {
    const first = harness({ forget: async () => "failed" });
    const job = await enqueue(first.service);
    await first.service.whenTerminal(job.id);
    await vi.waitFor(() => expect(first.calls.forget).toBe(1));
    first.service.close();

    const removal = Promise.withResolvers<"removed" | "failed">();
    const second = harness({ forget: () => removal.promise }, first.root);
    const recovered = vi.fn();
    const recovery = second.service.recover().then(recovered);
    try {
      await vi.waitFor(() => expect(recovered).toHaveBeenCalledOnce());
      expect(second.calls.forget).toBe(1);
      expect(second.service.getById(job.id)?.providerCopy).toBe("held");
    } finally {
      removal.resolve("removed");
      await recovery;
      await vi.waitFor(() => expect(second.service.getById(job.id)?.providerCopy).toBe("removed"));
      second.service.close();
    }
  });

  it("reports a recovered deletion whose journal write fails and keeps it owed", async () => {
    const first = harness({ forget: async () => "failed" });
    const job = await enqueue(first.service);
    await first.service.whenTerminal(job.id);
    await vi.waitFor(() => expect(first.calls.forget).toBe(1));
    first.service.close();

    const second = harness({}, first.root);
    const error = new Error("Journal is busy");
    const append = vi.spyOn(second.journal, "append").mockImplementationOnce(() => {
      throw error;
    });
    const report = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      await second.service.recover();
      await vi.waitFor(() =>
        expect(report).toHaveBeenCalledWith(expect.any(String), error.message),
      );
      expect(second.service.getById(job.id)?.providerCopy).toBe("held");
      await second.service.retryOwedRemovals();
      expect(second.service.getById(job.id)?.providerCopy).toBe("removed");
    } finally {
      second.service.close();
      append.mockRestore();
      report.mockRestore();
    }
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

  it("leaves a waiting job for recovery when active polls finish after shutdown", async () => {
    const bothPolling = Promise.withResolvers<void>();
    const releasePolls = Promise.withResolvers<VideoAdapterPoll>();
    let active = 0;
    const { service, calls, root } = harness({
      poll: () => {
        active += 1;
        if (active === 2) bothPolling.resolve();
        return releasePolls.promise;
      },
    });
    await enqueue(service);
    await enqueue(service);
    const waiting = await enqueue(service);
    await bothPolling.promise;
    service.close();
    releasePolls.resolve({ status: "running" });
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(service.getById(waiting.id)).toMatchObject({
      status: "queued",
      version: waiting.version,
    });
    expect(calls.start).toBe(2);

    const restarted = harness({}, root);
    try {
      await restarted.service.recover();
      expect(restarted.service.getById(waiting.id)).toMatchObject({
        status: "failed",
        failure: { category: "interrupted" },
      });
      expect(restarted.service.getById(waiting.id)?.settledCostUsdMicros).toBeUndefined();
    } finally {
      restarted.service.close();
      await new Promise<void>((resolve) => setImmediate(resolve));
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

  it("lists a provider model that a later catalog read restores", async () => {
    const restoredId = decodeProviderModelId("fal-ai/restored");
    const job = { cancel: "running", removal: { kind: "delete" }, resumeWindowHours: 24 } as const;
    const first = capabilities(job);
    const restored = capabilities(job, "fal-ai/restored");
    const { service, advance } = harness({
      model: first,
      allowlist: [modelId, restoredId],
      modelsRead: (call) => (call === 1 ? [first] : [first, restored]),
    });
    await vi.waitFor(() => expect(service.readyProfilesNow()[0]?.models).toHaveLength(1));
    // Inside the retry window the partial list is offered without a new read.
    expect(service.readyProfilesNow()[0]?.models).toHaveLength(1);
    advance(61_000);
    await vi.waitFor(() =>
      expect(service.readyProfilesNow()[0]?.models.map((m) => String(m.modelId))).toContain(
        "fal-ai/restored",
      ),
    );
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

  it("interrupts a stalled status check so Stop reaches the provider promptly", async () => {
    let firstPoll: AbortSignal | undefined;
    let nextPoll: AbortSignal | undefined;
    let cancelSignal: AbortSignal | undefined;
    const { service, calls, spend } = harness({
      poll: (signal) => {
        if (firstPoll !== undefined) {
          nextPoll = signal;
          return Promise.resolve({ status: "cancelled" });
        }
        firstPoll = signal;
        return new Promise((resolve) => {
          signal?.addEventListener(
            "abort",
            () =>
              resolve({
                status: "failed",
                providerFailure: { category: "interrupted", message: "Status check interrupted." },
              }),
            { once: true },
          );
        });
      },
      cancel: async (signal) => {
        cancelSignal = signal;
        return { status: "running" };
      },
    });
    try {
      const job = await enqueue(service);
      await vi.waitFor(() => expect(firstPoll).toBeDefined());
      service.stop(job.id);
      expect(firstPoll?.aborted).toBe(true);
      const done = await service.whenTerminal(job.id);
      expect(done).toMatchObject({ status: "cancelled", settledCostUsdMicros: 695_040 });
      expect(cancelSignal?.aborted).toBe(false);
      expect(nextPoll?.aborted).toBe(false);
      expect(calls.cancel).toBe(1);
      expect(spend.settle).toHaveBeenCalledTimes(1);
    } finally {
      service.close();
    }
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

  it.each(["rate-limited", "unauthenticated", "unauthorized"] as const)(
    "keeps polling after a $0 status check until the provider completes the clip",
    async (category) => {
      const { service, calls } = harness({
        polls: [
          {
            status: "failed",
            providerFailure: { category, message: "Status unavailable." },
          },
        ],
      });
      const queued = await enqueue(service);
      const done = await service.whenTerminal(queued.id);
      expect(calls.poll).toBeGreaterThanOrEqual(2);
      expect(done).toMatchObject({ status: "completed" });
      expect(done?.settledCostUsdMicros).toBeGreaterThan(0);
    },
  );

  it("settles the estimate when an accepted clip still cannot be read at the deadline", async () => {
    const { service, calls, spend, advance } = harness({
      poll: async () => {
        if (calls.poll === 2) advance(VIDEO_JOB_TIMEOUT_MS);
        return {
          status: "failed",
          providerFailure: { category: "unauthorized", message: "Status access denied." },
        };
      },
    });
    const queued = await enqueue(service);
    const done = await service.whenTerminal(queued.id);
    expect(done).toMatchObject({
      status: "failed",
      remoteId: "remote-1",
      settledCostUsdMicros: queued.estimatedCostUsdMicros,
    });
    expect(calls.poll).toBe(2);
    expect(spend.abandon).not.toHaveBeenCalled();
    expect(spend.settle).toHaveBeenCalledOnce();
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
