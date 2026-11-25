import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  decodeAggregateVersion,
  decodeImageGenerationScopeId,
  decodeProviderInstanceId,
  decodeProviderModelId,
  type OutsideVideoProviderInstance,
  type ProviderInstance,
} from "@octant/contracts";
import { ExtensionPackageState, type ExtensionActivationState } from "@octant/contracts/extensions";
import { OUTSIDE_DRIVER_MAX_REFERENCE_IMAGES_BYTES } from "@octant/contracts/outside-driver-protocol";
import { isOutsideDriverQuarantined, quarantineOutsideProviderDriver } from "@octant/domain";
import { Schema } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Journal } from "../persistence/journal";
import { catchUpProjection } from "../persistence/projection";
import { applyMigrations, MIGRATIONS } from "../persistence/migrations";
import { createPhase1RuntimeRegistries } from "../persistence/runtimeRegistry";
import { openSqlite } from "../persistence/sqlitePort";
import { SpendCeilingService } from "../spendCeilingService";
import { VideoClipStore } from "../video/videoClipStore";
import { VideoJobService } from "../video/videoJobService";
import { OutsideDriverAdmission } from "./outsideDriverAdmission";
import {
  FixtureDriverError,
  makeInMemoryOutsideDriverChannel,
  NO_ANSWER,
  serveFixtureDriver,
  type FixtureDriver,
  type FixtureDriverContext,
  type FixtureDriverHandler,
  type InMemoryDriverEnd,
} from "./outsideDriverFixture.test-support";
import { ProviderRuntimeRegistry } from "./providerRuntimeRegistry";

/**
 * An outside video driver through the host's own video job service: a fixture
 * package as the extension projection holds it, the host's admission and
 * proxy, and a fake driver at the far end of an in-memory channel. A clip runs
 * through the same price, reservation, settlement, storage, restart and
 * cleanup as a bundled driver's, and each way the driver can misbehave ends
 * closed, never past its reservation and never uncounted when the provider may
 * have been paid.
 */

const now = "2026-11-25T12:00:00.000Z";
const profileId = decodeProviderInstanceId("91000000-0000-4000-8000-000000000001");
const scopeId = decodeImageGenerationScopeId("91000000-0000-4000-8000-000000000002");
const pricedModel = decodeProviderModelId("example-video-1");
const unpricedModel = decodeProviderModelId("example-video-draft");
const ORIGIN = "https://video.example.test";
const CLIP_URL = "https://cdn.example.test/clips/1.mp4";
const driver = {
  extensionId: "91000000-0000-4000-8000-000000000011",
  packageId: "91000000-0000-4000-8000-000000000012",
  componentId: "video",
  version: "1.0.0",
  digest: `sha256:${"c".repeat(64)}`,
} as const;
const effective: ExtensionActivationState = {
  installed: true,
  trusted: true,
  pluginDesired: true,
  componentDesired: true,
  compatible: true,
  policyAllowed: true,
  quarantined: false,
  draining: false,
  broken: false,
  unavailable: false,
  interrupted: false,
  waiting: false,
};

/** The smallest file the host's own check reads as an MP4 clip. */
function mp4(): ArrayBuffer {
  const bytes = Buffer.alloc(64);
  bytes.writeUInt32BE(24, 0);
  bytes.write("ftypisom", 4, "latin1");
  bytes.writeUInt32BE(512, 12);
  bytes.write("isommp42", 16, "latin1");
  return Uint8Array.from(bytes).buffer;
}

const videoModel = {
  displayName: "Example Video",
  durations: { kind: "range", min: 2, max: 10 },
  resolutions: ["720p"],
  aspectRatios: [{ ratio: "16:9" }],
  audio: "none",
  inputs: { firstFrame: true, lastFrame: false, maxReferenceImages: 4 },
} as const;
const job = {
  cancel: "running",
  removal: { kind: "delete" },
  resumeWindowHours: 24,
} as const;

interface DeclaredOverrides {
  readonly price?: Record<string, unknown>;
  readonly job?: Record<string, unknown>;
}

/** 5 cents a second, so a five-second clip is estimated at 25 cents. */
function fixturePackage(
  activation: Partial<ExtensionActivationState> = {},
  declared: DeclaredOverrides = {},
) {
  return Schema.decodeUnknownSync(ExtensionPackageState)({
    extensionId: driver.extensionId,
    packageId: driver.packageId,
    slug: "example-video",
    displayName: "Example video",
    stateVersion: 3,
    version: driver.version,
    digest: driver.digest,
    source: { kind: "local-folder", sourceRef: "folder-video" },
    compatibility: { platforms: ["macos"], modes: ["chat", "work", "code"], providerFamilies: [] },
    activation: { ...effective, ...activation },
    components: [
      {
        component: {
          id: "video",
          kind: "provider-driver",
          displayName: "Example video",
          declaredCapabilities: [],
          entryPoint: "dist/video.mjs",
          mediaGeneration: {
            media: "video",
            models: [
              {
                ...videoModel,
                modelId: String(pricedModel),
                price: declared.price ?? {
                  kind: "per-second",
                  rates: [{ resolution: "720p", usdMicrosPerSecond: 50_000 }],
                },
                job: declared.job ?? job,
              },
              {
                ...videoModel,
                modelId: String(unpricedModel),
                price: { kind: "unpublished" },
                job,
              },
            ],
          },
        },
        activation: { ...effective, ...activation },
        effectiveState: { kind: "effective" },
      },
    ],
    diagnostics: [],
  });
}

function outsideProfile(
  overrides: Partial<OutsideVideoProviderInstance> = {},
): OutsideVideoProviderInstance {
  return {
    id: profileId,
    displayName: "Example video",
    enabled: true,
    environmentPolicy: "inherit-host",
    version: 1 as ProviderInstance["version"],
    createdAt: now as ProviderInstance["createdAt"],
    updatedAt: now as ProviderInstance["updatedAt"],
    driverKind: "outside-video",
    configuration: {
      kind: "outside-video",
      driver: driver as never,
      baseUrl: ORIGIN,
      key: { header: "authorization", scheme: "Bearer" },
      modelAllowlist: [pricedModel, unpricedModel],
      defaultModel: pricedModel,
    },
    ...overrides,
  };
}

const auth = { header: "authorization", scheme: "Bearer" };

function call(
  context: FixtureDriverContext,
  method: "GET" | "POST" | "PUT" | "DELETE",
  path: string,
  extra: Record<string, unknown> = {},
) {
  return context.http({ requestId: context.id, url: `${ORIGIN}${path}`, method, auth, ...extra });
}

/** A well-behaved driver: submit, read the status, read the address, remove. */
const videoHandlers: Readonly<Record<string, FixtureDriverHandler>> = {
  initialize: () => ({ protocolVersion: "video-generation/1" }),
  "video/start": async (params, context) => {
    const answer = await call(context, "POST", "/v1/videos", {
      headers: [["content-type", "application/json"]],
      body: JSON.stringify({ model: params.modelId, prompt: params.prompt }),
    });
    if (answer.status !== 200) throw new FixtureDriverError("bad", { category: "provider-failed" });
    return { status: "started", remoteId: "remote-1" };
  },
  "video/poll": async (_params, context) => {
    await call(context, "GET", "/v1/videos/remote-1");
    return { status: "completed", url: CLIP_URL };
  },
  "video/cancel": async (_params, context) => {
    await call(context, "PUT", "/v1/videos/remote-1/cancel");
    return { status: "cancelled" };
  },
  "video/forget": async (_params, context) => {
    await call(context, "DELETE", "/v1/videos/remote-1");
    return { status: "removed" };
  },
};

const opened: Array<() => void> = [];
afterEach(() => {
  for (const close of opened.splice(0)) close();
});

interface HarnessOptions {
  readonly handlers?: Readonly<Record<string, FixtureDriverHandler>>;
  readonly provider?: (url: string, init: RequestInit) => Response | Promise<Response>;
  readonly clip?: (url: string) => Response;
  readonly resolve?: (hostname: string) => Promise<ReadonlyArray<string>>;
  readonly directory?: string;
  readonly declared?: DeclaredOverrides;
}

function harness(options: HarnessOptions = {}) {
  const directory = options.directory ?? mkdtempSync(join(tmpdir(), "octant-outside-video-"));
  const connection = openSqlite(join(directory, "octant.sqlite3"));
  applyMigrations(connection, MIGRATIONS, () => now);
  const runtime = createPhase1RuntimeRegistries();
  const journal = new Journal({
    connection,
    registry: runtime.events,
    projections: runtime.projections,
    clock: () => now,
  });
  catchUpProjection({
    connection,
    journal,
    projection: runtime.videoJobProjection,
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
  let clockMs = Date.parse(now);
  const state: {
    profile: OutsideVideoProviderInstance | undefined;
    package: ReturnType<typeof fixturePackage>;
  } = { profile: outsideProfile(), package: fixturePackage({}, options.declared) };
  const drivers: Array<{ readonly end: InMemoryDriverEnd; readonly fixture: FixtureDriver }> = [];
  const brokered: Array<{
    readonly method: string;
    readonly url: string;
    readonly authorization: string | null;
  }> = [];
  const downloaded: Array<string> = [];
  const providerFetch = vi.fn(async (url: string, init: RequestInit) => {
    brokered.push({
      method: init.method ?? "GET",
      url,
      authorization: new Headers(init.headers).get("authorization"),
    });
    return (
      (await options.provider?.(url, init)) ??
      new Response(JSON.stringify({ id: "remote-1", output: CLIP_URL }), { status: 200 })
    );
  });
  const admission = new OutsideDriverAdmission({
    platform: "darwin",
    packages: () => [state.package],
    isCompatible: () => true,
    entry: async () => ({ packageRoot: directory, entryPoint: "dist/video.mjs" }),
    processes: {
      start: async () => {
        const { host, driver: end } = makeInMemoryOutsideDriverChannel();
        drivers.push({
          end,
          fixture: serveFixtureDriver(end, { ...videoHandlers, ...options.handlers }),
        });
        return { status: "started", channel: host };
      },
      stop: async () => undefined,
    },
    runtimeRegistry: new ProviderRuntimeRegistry(),
    credentialResolver: { has: async () => true, resolve: async () => "sk-outside" },
    fetch: providerFetch,
    resolve: options.resolve ?? (async () => ["93.184.216.34"]),
  });
  const service = new VideoJobService({
    journal,
    projection: runtime.videoJobProjection,
    clips: new VideoClipStore(directory),
    readProviderInstance: (id) => (String(id) === String(profileId) ? state.profile : undefined),
    listProviderInstances: () => (state.profile === undefined ? [] : [state.profile]),
    credentialResolver: { has: async () => true, resolve: async () => "sk-outside" },
    uuid: () => crypto.randomUUID(),
    clock: () => new Date(clockMs++).toISOString(),
    actor: { kind: "system", actorId: "00000000-0000-4000-8000-000000000002" as never },
    fetch: async (input) => {
      downloaded.push(String(input));
      return options.clip?.(String(input)) ?? new Response(mp4(), { status: 200 });
    },
    spendCeiling,
    sleep: (ms: number) => {
      clockMs += ms;
      return new Promise((resolve) => setTimeout(resolve, 1));
    },
    now: () => clockMs,
    outsideVideoDrivers: {
      admits: (instance) => !isOutsideDriverQuarantined(instance) && admission.isAdmitted(instance),
      adapter: (instance, current, ports, sends) =>
        admission.videoAdapter(instance, current, ports, sends),
    },
  });
  let closed = false;
  opened.push(() => {
    service.close();
    if (!closed) connection.close();
    if (options.directory === undefined) rmSync(directory, { recursive: true, force: true });
  });
  const setCeiling = (cents: number) =>
    spendCeiling.execute("local-window", {
      kind: "set-spend-ceiling",
      scope: { kind: "thread", threadType: "chat-thread", threadId: String(scopeId) },
      expectedVersion: decodeAggregateVersion(0),
      policy: { costBudgetUsdCents: cents },
      window: { kind: "lifetime" },
    });
  const used = () => {
    const snapshot = spendCeiling.snapshot({
      principalKind: "local-window",
      threadId: String(scopeId),
      threadType: "chat-thread",
    });
    if (snapshot === undefined || "kind" in snapshot) throw new Error("expected a snapshot");
    return snapshot.threadRemaining?.usedUsdCents;
  };
  const enqueue = (
    input: {
      readonly modelId?: typeof pricedModel;
      readonly references?: ReadonlyArray<{
        readonly mediaType: "image/png";
        readonly bytes: Uint8Array;
      }>;
    } = {},
  ) =>
    service.enqueue({
      threadKind: "chat-thread",
      scopeId,
      profileInstanceId: profileId,
      modelId: input.modelId ?? pricedModel,
      prompt: "a lighthouse at dusk",
      options: { durationSeconds: 5, resolution: "720p", aspectRatio: "16:9", audio: false },
      references: input.references ?? [],
    });
  const received = (method: string) =>
    drivers.flatMap(({ fixture }) => fixture.received.filter((m) => m.method === method));
  return {
    admission,
    service,
    state,
    drivers,
    brokered,
    downloaded,
    setCeiling,
    used,
    enqueue,
    received,
    directory,
    /** Ends this host as a shutdown would, leaving its data for the next one. */
    shutDown: () => {
      service.close();
      connection.close();
      closed = true;
    },
  };
}

const PROFILE_TURNED_OFF = { enabled: false } as const;

describe("an outside video driver in the video job service", () => {
  it("runs a clip at the package's declared price, stores it, and removes the provider's copy", async () => {
    const h = harness();
    h.setCeiling(100);
    const queued = await h.enqueue();
    expect(queued.estimatedCostUsdMicros).toBe(250_000);
    const done = await h.service.whenTerminal(queued.id);
    expect(done).toMatchObject({
      status: "completed",
      driverKind: "outside-video",
      remoteId: "remote-1",
      settledCostUsdMicros: 250_000,
    });
    expect(h.used()).toBe(25);
    await vi.waitFor(() => expect(h.service.getById(queued.id)?.providerCopy).toBe("removed"));
    // The key went only to the configured origin, set by the host; the clip was
    // fetched by the host without it; the driver never held it.
    expect(h.brokered.map(({ method, url }) => `${method} ${url}`)).toEqual([
      `POST ${ORIGIN}/v1/videos`,
      `GET ${ORIGIN}/v1/videos/remote-1`,
      `DELETE ${ORIGIN}/v1/videos/remote-1`,
    ]);
    expect(new Set(h.brokered.map((entry) => entry.authorization))).toEqual(
      new Set(["Bearer sk-outside"]),
    );
    expect(h.downloaded).toEqual([CLIP_URL]);
    expect(JSON.stringify(h.received("video/start"))).not.toContain("sk-outside");
  });

  it("offers the profile with the package's declared models and names the configured address as the recipient, starting nothing", async () => {
    const h = harness();
    const ready = await h.service.readyProfiles();
    expect(ready.map((entry) => entry.models.map((model) => String(model.modelId)))).toEqual([
      ["example-video-1", "example-video-draft"],
    ]);
    expect(
      await h.service.quote({
        profileInstanceId: profileId,
        modelId: pricedModel,
        prompt: "x",
        options: { durationSeconds: 5, resolution: "720p", aspectRatio: "16:9", audio: false },
        firstFrame: false,
        lastFrame: false,
        referenceCount: 0,
      }),
    ).toMatchObject({
      status: "ready",
      providerName: "video.example.test",
      estimate: { kind: "estimate", usdMicros: 250_000 },
    });
    expect(h.drivers).toHaveLength(0);
    expect(h.admission.listings()).toMatchObject([
      {
        displayName: "Example video",
        videoGeneration: {
          models: [
            { modelId: "example-video-1", displayName: "Example Video", publishesPrice: true },
            { modelId: "example-video-draft", displayName: "Example Video", publishesPrice: false },
          ],
        },
      },
    ]);
    expect(h.admission.listings()[0]).not.toHaveProperty("imageGeneration");
  });

  it("refuses a clip a spend limit cannot cover, or with no published price under one, before any process starts", async () => {
    const h = harness();
    h.setCeiling(24);
    await expect(h.enqueue()).rejects.toMatchObject({ category: "spend-ceiling" });
    await expect(h.enqueue({ modelId: unpricedModel })).rejects.toMatchObject({
      category: "spend-ceiling",
    });
    expect(h.drivers).toHaveLength(0);
  });

  it.each([
    ["untrusted", { trusted: false }],
    ["disabled", { pluginDesired: false }],
    ["quarantined", { quarantined: true }],
  ] as const)("offers and runs nothing when the driver is %s", async (_label, activation) => {
    const h = harness();
    h.state.package = fixturePackage(activation);
    expect(await h.service.readyProfiles()).toEqual([]);
    expect(h.service.readyProfilesNow()).toEqual([]);
    await expect(h.enqueue()).rejects.toMatchObject({ category: "ineligible" });
    expect(h.admission.listings()).toEqual([]);
    expect(h.drivers).toHaveLength(0);
  });

  it("offers nothing for a driver held at the crash limit", async () => {
    const h = harness();
    const held = quarantineOutsideProviderDriver(outsideProfile(), now as never);
    if (held.driverKind !== "outside-video") throw new Error("expected a video profile");
    h.state.profile = held;
    expect(await h.service.readyProfiles()).toEqual([]);
    await expect(h.enqueue()).rejects.toMatchObject({ category: "ineligible" });
  });

  it("settles a reported count at the declared price, never above the reservation", async () => {
    for (const [billedSeconds, settled] of [
      [3, 150_000],
      [500, 250_000],
    ] as const) {
      const h = harness({
        handlers: {
          "video/poll": async (_params, context) => {
            await call(context, "GET", "/v1/videos/remote-1");
            return { status: "completed", url: CLIP_URL, usage: { billedSeconds } };
          },
        },
      });
      const queued = await h.enqueue();
      expect(await h.service.whenTerminal(queued.id)).toMatchObject({
        status: "completed",
        settledCostUsdMicros: settled,
      });
    }
  });

  it("keeps a per-token driver's reported tokens under the reservation", async () => {
    const h = harness({
      declared: {
        price: {
          kind: "per-token",
          outputTokensPerSecond: [{ resolution: "720p", tokens: 1_000 }],
          outputUsdMicrosPerMillionTokens: 10_000_000,
        },
      },
      handlers: {
        "video/poll": async (_params, context) => {
          await call(context, "GET", "/v1/videos/remote-1");
          return { status: "completed", url: CLIP_URL, usage: { outputTokens: 900_000_000 } };
        },
      },
    });
    const queued = await h.enqueue();
    expect(await h.service.whenTerminal(queued.id)).toMatchObject({
      settledCostUsdMicros: queued.estimatedCostUsdMicros,
    });
  });

  it("stops a running clip at the provider when the package declares it can", async () => {
    let polls = 0;
    const h = harness({
      handlers: {
        "video/poll": () => {
          polls += 1;
          return NO_ANSWER;
        },
        "video/cancel": async (_params, context) => {
          await call(context, "PUT", "/v1/videos/remote-1/cancel");
          return { status: "cancelled", usage: { billedSeconds: 1 } };
        },
      },
    });
    const queued = await h.enqueue();
    await vi.waitFor(() => expect(polls).toBeGreaterThan(0));
    h.service.stop(queued.id);
    expect(await h.service.whenTerminal(queued.id)).toMatchObject({
      status: "cancelled",
      settledCostUsdMicros: 50_000,
    });
    expect(h.brokered.map((entry) => entry.method)).toContain("PUT");
  });

  it("never asks a driver to stop or remove what its package does not declare it can", async () => {
    let polls = 0;
    const h = harness({
      declared: {
        job: { cancel: "none", removal: { kind: "expires", afterHours: 2 }, resumeWindowHours: 24 },
      },
      handlers: {
        "video/poll": () => {
          polls += 1;
          return NO_ANSWER;
        },
      },
    });
    const queued = await h.enqueue();
    await vi.waitFor(() => expect(polls).toBeGreaterThan(0));
    h.service.stop(queued.id);
    expect(await h.service.whenTerminal(queued.id)).toMatchObject({
      status: "cancelled",
      settledCostUsdMicros: 250_000,
    });
    await vi.waitFor(() => expect(h.service.getById(queued.id)?.providerCopy).toBe("expires"));
    expect(h.received("video/cancel")).toEqual([]);
    expect(h.received("video/forget")).toEqual([]);
  });
});

describe("what an outside video start may have cost", () => {
  const failing =
    (data: unknown): FixtureDriverHandler =>
    async (_params, context) => {
      await call(context, "POST", "/v1/videos", { body: "{}" });
      throw new FixtureDriverError("attacker text", data);
    };

  it.each(["provider-failed", "rate-limited", "unauthorized", "unsupported"])(
    "counts the estimate when the provider accepted the request and the driver then says %s",
    async (category) => {
      const h = harness({ handlers: { "video/start": failing({ category }) } });
      const queued = await h.enqueue();
      const done = await h.service.whenTerminal(queued.id);
      expect(done).toMatchObject({ status: "failed", settledCostUsdMicros: 250_000 });
      expect(JSON.stringify(done)).not.toContain("attacker text");
    },
  );

  it("counts the estimate when the driver calls an accepted request a refusal, or answers unreadably", async () => {
    for (const result of [{ status: "refused" }, { status: "started" }, "nonsense"]) {
      const h = harness({
        handlers: {
          "video/start": async (_params, context) => {
            await call(context, "POST", "/v1/videos", { body: "{}" });
            return result;
          },
        },
      });
      const queued = await h.enqueue();
      expect(await h.service.whenTerminal(queued.id)).toMatchObject({
        status: "failed",
        settledCostUsdMicros: 250_000,
      });
    }
  });

  it.each([400, 402, 422, 429])(
    "charges nothing when the provider refused the request with HTTP %i",
    async (status) => {
      const h = harness({
        provider: () => new Response("{}", { status }),
        handlers: {
          "video/start": async (_params, context) => {
            await call(context, "POST", "/v1/videos", { body: "{}" });
            return { status: "refused" };
          },
        },
      });
      const queued = await h.enqueue();
      const done = await h.service.whenTerminal(queued.id);
      expect(done).toMatchObject({
        status: "failed",
        safetyRefusal: "The video provider declined this request.",
      });
      expect(done?.settledCostUsdMicros).toBeUndefined();
    },
  );

  it.each([408, 500, 503])(
    "counts the estimate when HTTP %i leaves the outcome unknown, whatever the driver says",
    async (status) => {
      const h = harness({
        provider: () => new Response("{}", { status }),
        handlers: { "video/start": failing({ category: "rate-limited" }) },
      });
      const queued = await h.enqueue();
      expect(await h.service.whenTerminal(queued.id)).toMatchObject({
        status: "failed",
        settledCostUsdMicros: 250_000,
      });
    },
  );

  it("charges nothing when the driver sent nothing, even if it crashed", async () => {
    for (const handler of [
      () => {
        throw new FixtureDriverError("x", { category: "unavailable" });
      },
      (_params: unknown, context: FixtureDriverContext) => {
        context.writeRaw("not json");
        return NO_ANSWER;
      },
    ] as ReadonlyArray<FixtureDriverHandler>) {
      const h = harness({ handlers: { "video/start": handler } });
      const queued = await h.enqueue();
      const done = await h.service.whenTerminal(queued.id);
      expect(done?.status).toBe("failed");
      expect(done?.settledCostUsdMicros).toBeUndefined();
      expect(h.brokered).toEqual([]);
    }
  });

  it("stops a driver that sends a billable request outside the call it serves", async () => {
    const h = harness({
      handlers: {
        "video/start": (_params, context) => {
          void context.http({ url: `${ORIGIN}/v1/videos`, method: "POST", auth });
          return NO_ANSWER;
        },
      },
    });
    const queued = await h.enqueue();
    expect(await h.service.whenTerminal(queued.id)).toMatchObject({
      status: "failed",
      failure: { category: "incompatible" },
    });
    expect(h.brokered).toEqual([]);
  });

  it("refuses images past the channel's bound before the driver is asked", async () => {
    const h = harness();
    const queued = await h.enqueue({
      references: [
        {
          mediaType: "image/png",
          bytes: new Uint8Array(OUTSIDE_DRIVER_MAX_REFERENCE_IMAGES_BYTES + 1),
        },
      ],
    });
    const done = await h.service.whenTerminal(queued.id);
    expect(done).toMatchObject({
      status: "failed",
      failure: { category: "invalid-configuration" },
    });
    expect(done?.settledCostUsdMicros).toBeUndefined();
    expect(h.received("video/start")).toEqual([]);
  });

  it("releases a queued clip unstarted when its driver moves to a newly trusted digest", async () => {
    const gate: { release: () => void } = { release: () => undefined };
    const held = new Promise<void>((resolve) => {
      gate.release = resolve;
    });
    const h = harness({
      handlers: {
        "video/poll": async () => {
          await held;
          return { status: "failed", category: "provider-failed" };
        },
      },
    });
    // Two clips hold the host's slots, so the third waits in the queue.
    await h.enqueue();
    await h.enqueue();
    const waiting = await h.enqueue();
    const digest = `sha256:${"d".repeat(64)}`;
    h.state.package = Schema.decodeUnknownSync(ExtensionPackageState)({
      ...Schema.encodeSync(ExtensionPackageState)(h.state.package),
      digest,
    });
    h.state.profile = outsideProfile({
      configuration: {
        ...outsideProfile().configuration,
        driver: { ...driver, digest } as never,
      },
    });
    gate.release();
    const done = await h.service.whenTerminal(waiting.id);
    expect(done).toMatchObject({ status: "failed", failure: { category: "unsupported" } });
    expect(done?.settledCostUsdMicros).toBeUndefined();
    expect(done?.remoteId).toBeUndefined();
  });
});

describe("how an outside clip the provider accepted can end", () => {
  const polling = (answer: (context: FixtureDriverContext) => unknown): HarnessOptions => ({
    handlers: { "video/poll": async (_params, context) => answer(context) },
  });

  it.each([
    ["an address the provider never returned", "https://cdn.example.test/other.mp4"],
    ["a prefix of a returned address", "https://cdn.example.test/clips/1"],
    ["a plain HTTP address", "http://cdn.example.test/clips/1.mp4"],
    ["an address with credentials", "https://user:pw@cdn.example.test/clips/1.mp4"],
    ["a loopback address", "https://127.0.0.1/clip.mp4"],
  ])("downloads nothing for %s, and counts the clip", async (_label, url) => {
    const h = harness(
      polling(async (context) => {
        await call(context, "GET", "/v1/videos/remote-1");
        return { status: "completed", url };
      }),
    );
    const queued = await h.enqueue();
    expect(await h.service.whenTerminal(queued.id)).toMatchObject({
      status: "failed",
      failure: { category: "protocol" },
      settledCostUsdMicros: 250_000,
    });
    expect(h.downloaded).toEqual([]);
  });

  it("downloads nothing from a returned address that resolves to a private network", async () => {
    const h = harness({ resolve: async () => ["10.0.0.8"] });
    const queued = await h.enqueue();
    expect(await h.service.whenTerminal(queued.id)).toMatchObject({
      status: "failed",
      settledCostUsdMicros: 250_000,
    });
    expect(h.downloaded).toEqual([]);
  });

  it("keeps no file whose bytes are not a clip, and counts it", async () => {
    const h = harness({ clip: () => new Response("<html>", { status: 200 }) });
    const queued = await h.enqueue();
    const done = await h.service.whenTerminal(queued.id);
    expect(done).toMatchObject({
      status: "failed",
      failure: { category: "protocol" },
      settledCostUsdMicros: 250_000,
    });
    expect(done?.clip).toBeUndefined();
  });

  it("asks again when the download breaks off, and completes", async () => {
    let downloads = 0;
    const h = harness({
      clip: () => {
        downloads += 1;
        if (downloads === 1) throw new Error("connection reset");
        return new Response(mp4(), { status: 200 });
      },
    });
    const queued = await h.enqueue();
    expect(await h.service.whenTerminal(queued.id)).toMatchObject({ status: "completed" });
    expect(downloads).toBe(2);
  });

  it("starts the driver again after it crashes between checks, and completes", async () => {
    let polls = 0;
    const h = harness(
      polling(async (context) => {
        polls += 1;
        if (polls === 1) {
          h.drivers.at(-1)?.end.exit();
          return NO_ANSWER;
        }
        await call(context, "GET", "/v1/videos/remote-1");
        return { status: "completed", url: CLIP_URL };
      }),
    );
    const queued = await h.enqueue();
    expect(await h.service.whenTerminal(queued.id)).toMatchObject({ status: "completed" });
    expect(h.drivers).toHaveLength(2);
  });

  it.each([
    ["an unreadable answer", { status: "completed", data: "AAAA" }],
    ["a price of its own", { status: "completed", url: CLIP_URL, usage: { costUsdMicros: 1 } }],
    ["text of its own", { status: "refused", message: "attacker text" }],
  ])("stops a driver that answers a check with %s, and counts the clip", async (_label, answer) => {
    const h = harness(polling(() => answer));
    const queued = await h.enqueue();
    const done = await h.service.whenTerminal(queued.id);
    expect(done).toMatchObject({
      status: "failed",
      failure: { category: "incompatible" },
      settledCostUsdMicros: 250_000,
    });
    expect(JSON.stringify(done)).not.toContain("attacker text");
  });

  it("gives a stated failure Octant's words and charges it only when the driver says it was billed", async () => {
    for (const [billed, settled] of [
      [undefined, undefined],
      [true, 250_000],
    ] as const) {
      const h = harness(
        polling(() => ({
          status: "failed",
          category: "provider-failed",
          ...(billed === undefined ? {} : { billed }),
        })),
      );
      const queued = await h.enqueue();
      const done = await h.service.whenTerminal(queued.id);
      expect(done).toMatchObject({
        status: "failed",
        failure: { category: "provider-failed", message: "The provider request failed." },
      });
      expect(done?.settledCostUsdMicros).toBe(settled);
    }
  });

  it.each([
    [
      "the profile is turned off",
      (h: ReturnType<typeof harness>) => {
        h.state.profile = outsideProfile(PROFILE_TURNED_OFF);
      },
    ],
    [
      "the profile is removed",
      (h: ReturnType<typeof harness>) => {
        h.state.profile = undefined;
      },
    ],
    [
      "its driver is no longer trusted",
      (h: ReturnType<typeof harness>) => {
        h.state.package = fixturePackage({ trusted: false });
      },
    ],
    [
      "its address changes",
      (h: ReturnType<typeof harness>) => {
        h.state.profile = outsideProfile({
          configuration: {
            ...outsideProfile().configuration,
            baseUrl: "https://other.example.test",
          },
        });
      },
    ],
  ])("sends nothing more once %s, and counts the running clip", async (_label, change) => {
    let polls = 0;
    let sent = 0;
    // The change lands during the first check, so it cannot race the job's clock.
    const h: ReturnType<typeof harness> = harness(
      polling(() => {
        polls += 1;
        if (polls === 1) {
          sent = h.brokered.length;
          change(h);
        }
        return { status: "running" };
      }),
    );
    const queued = await h.enqueue();
    const done = await h.service.whenTerminal(queued.id);
    expect(done).toMatchObject({
      status: "failed",
      failure: { category: "unsupported", message: "This provider driver is not available." },
      settledCostUsdMicros: 250_000,
    });
    expect(polls).toBe(1);
    expect(h.brokered).toHaveLength(sent);
  });

  it("fails a clip that never finishes at its estimate when its time runs out", async () => {
    const h = harness(polling(() => ({ status: "running" })));
    const queued = await h.enqueue();
    expect(await h.service.whenTerminal(queued.id)).toMatchObject({
      status: "failed",
      failure: { category: "unavailable" },
      settledCostUsdMicros: 250_000,
    });
  });

  it("does not let a driver remove or change anything for a call that is not a video one", async () => {
    const h = harness({
      handlers: {
        initialize: (_params, context) => {
          void context.http({ url: `${ORIGIN}/v1/videos/remote-1`, method: "DELETE", auth });
          return NO_ANSWER;
        },
      },
    });
    const queued = await h.enqueue();
    expect(await h.service.whenTerminal(queued.id)).toMatchObject({
      status: "failed",
      failure: { category: "incompatible" },
    });
    expect(h.brokered).toEqual([]);
  });
});

describe("an outside clip across a restart", () => {
  it("resumes a sent clip on the next host, once, and completes it", async () => {
    const directory = mkdtempSync(join(tmpdir(), "octant-outside-video-"));
    try {
      const first = harness({
        directory,
        handlers: { "video/poll": () => NO_ANSWER },
      });
      const queued = await first.enqueue();
      await vi.waitFor(() => expect(first.service.getById(queued.id)?.remoteId).toBe("remote-1"));
      first.shutDown();
      const second = harness({ directory });
      await second.service.recover();
      expect(await second.service.whenTerminal(queued.id)).toMatchObject({ status: "completed" });
      // The clip was not asked for again.
      expect(second.received("video/start")).toEqual([]);
    } finally {
      for (const close of opened.splice(0)) close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
