import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  IMAGE_JOB_RESTART_INTERRUPTION_MESSAGE,
  decodeAggregateVersion,
  decodeImageGenerationScopeId,
  decodeProviderInstanceId,
  decodeProviderModelId,
  type OutsideImageProviderInstance,
  type ProviderInstance,
} from "@octant/contracts";
import { ExtensionPackageState, type ExtensionActivationState } from "@octant/contracts/extensions";
import { Schema } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GeneratedImageStore } from "../image/generatedImageStore";
import { ImageJobService } from "../image/imageJobService";
import { Journal } from "../persistence/journal";
import { applyMigrations, MIGRATIONS } from "../persistence/migrations";
import { createPhase1RuntimeRegistries } from "../persistence/runtimeRegistry";
import { openSqlite } from "../persistence/sqlitePort";
import { SpendCeilingService } from "../spendCeilingService";
import { OutsideDriverAdmission } from "./outsideDriverAdmission";
import {
  FixtureDriverError,
  makeInMemoryOutsideDriverChannel,
  NO_ANSWER,
  serveFixtureDriver,
  type FixtureDriver,
  type FixtureDriverHandler,
  type InMemoryDriverEnd,
} from "./outsideDriverFixture.test-support";
import { ProviderRuntimeRegistry } from "./providerRuntimeRegistry";

/**
 * An outside image driver through the host's own image job service: a fixture
 * package as the extension projection holds it, the host's admission and
 * proxy, and a fake driver at the far end of an in-memory channel. The job
 * runs through the same price, spend reservation and settlement, storage and
 * restart handling as a bundled image driver, and every way the driver can
 * misbehave ends as a named, closed failure that is never charged past its
 * reservation.
 */

const now = "2026-11-22T12:00:00.000Z";
const directories: Array<string> = [];
const profileId = decodeProviderInstanceId("90000000-0000-4000-8000-000000000001");
const scopeId = decodeImageGenerationScopeId("90000000-0000-4000-8000-000000000002");
const pricedModel = decodeProviderModelId("example-image-1");
const unpricedModel = decodeProviderModelId("example-image-draft");
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);
const pngBase64 = png.toString("base64");
const driver = {
  extensionId: "90000000-0000-4000-8000-000000000011",
  packageId: "90000000-0000-4000-8000-000000000012",
  componentId: "images",
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

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

/** The fixture package: one image driver declaring a priced and an unpriced model. */
function fixturePackage(activation: Partial<ExtensionActivationState> = {}) {
  return Schema.decodeUnknownSync(ExtensionPackageState)({
    extensionId: driver.extensionId,
    packageId: driver.packageId,
    slug: "example-images",
    displayName: "Example images",
    stateVersion: 3,
    version: driver.version,
    digest: driver.digest,
    source: { kind: "local-folder", sourceRef: "folder-images" },
    compatibility: { platforms: ["macos"], modes: ["chat", "work", "code"], providerFamilies: [] },
    activation: { ...effective, ...activation },
    components: [
      {
        component: {
          id: "images",
          kind: "provider-driver",
          displayName: "Example images",
          declaredCapabilities: [],
          entryPoint: "dist/images.mjs",
          mediaGeneration: {
            media: "image",
            models: [
              { modelId: String(pricedModel), usdMicrosPerImage: 40_000 },
              { modelId: String(unpricedModel) },
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

function outsideProfile(): OutsideImageProviderInstance {
  return {
    id: profileId,
    displayName: "Example images",
    enabled: true,
    environmentPolicy: "inherit-host",
    version: 1 as ProviderInstance["version"],
    createdAt: now as ProviderInstance["createdAt"],
    updatedAt: now as ProviderInstance["updatedAt"],
    driverKind: "outside-image",
    configuration: {
      kind: "outside-image",
      driver: driver as never,
      baseUrl: "https://images.example.test",
      key: { header: "authorization", scheme: "Bearer" },
      modelAllowlist: [pricedModel, unpricedModel],
      defaultModel: pricedModel,
    },
  };
}

const imageHandlers: Readonly<Record<string, FixtureDriverHandler>> = {
  initialize: () => ({ protocolVersion: "image-generation/1" }),
  "image/generate": async (params, context) => {
    const answer = await context.http({
      requestId: context.id,
      url: "https://images.example.test/v1/generate",
      method: "POST",
      headers: [["content-type", "application/json"]],
      body: JSON.stringify({ model: params.modelId, prompt: params.prompt }),
      auth: { header: "authorization", scheme: "Bearer" },
    });
    if (answer.status !== 200) throw new FixtureDriverError("bad", { category: "provider-failed" });
    const count = typeof params.variantCount === "number" ? params.variantCount : 1;
    return {
      status: "completed",
      images: Array.from({ length: count }, () => ({ mediaType: "image/png", data: pngBase64 })),
    };
  },
};

function harness(
  options: {
    readonly handlers?: Readonly<Record<string, FixtureDriverHandler>>;
    readonly activation?: Partial<ExtensionActivationState>;
    readonly sendTimeoutMs?: number;
    readonly providerBody?: string;
    readonly imageFetch?: (url: string) => Response;
  } = {},
) {
  const directory = mkdtempSync(join(tmpdir(), "octant-outside-image-"));
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
  const drivers: Array<{ readonly end: InMemoryDriverEnd; readonly fixture: FixtureDriver }> = [];
  const brokered: Array<{ readonly url: string; readonly authorization: string | null }> = [];
  const providerFetch = vi.fn(async (url: string, init: RequestInit) => {
    brokered.push({ url, authorization: new Headers(init.headers).get("authorization") });
    return new Response(options.providerBody ?? '{"ok":true}', { status: 200 });
  });
  const admission = new OutsideDriverAdmission({
    platform: "darwin",
    packages: () => [fixturePackage(options.activation)],
    isCompatible: () => true,
    entry: async () => ({ packageRoot: directory, entryPoint: "dist/images.mjs" }),
    processes: {
      start: async () => {
        const { host, driver: end } = makeInMemoryOutsideDriverChannel();
        drivers.push({ end, fixture: serveFixtureDriver(end, options.handlers ?? imageHandlers) });
        return { status: "started", channel: host };
      },
      stop: async () => undefined,
    },
    runtimeRegistry: new ProviderRuntimeRegistry(),
    credentialResolver: { has: async () => true, resolve: async () => "sk-outside" },
    fetch: providerFetch,
    ...(options.sendTimeoutMs === undefined
      ? {}
      : { limits: { sendTimeoutMs: options.sendTimeoutMs } }),
  });
  const service = new ImageJobService({
    journal,
    projection: runtime.imageJobProjection,
    attachments: new GeneratedImageStore(directory),
    readProviderInstance: (id) => (String(id) === String(profileId) ? outsideProfile() : undefined),
    readImageGenerationCustomSources: () => [],
    credentialResolver: { has: async () => true, resolve: async () => "sk-outside" },
    uuid: () => crypto.randomUUID(),
    clock: () => now,
    actor: { kind: "system", actorId: "00000000-0000-4000-8000-000000000002" as never },
    fetch: async (url) => options.imageFetch?.(String(url)) ?? new Response(null, { status: 404 }),
    spendCeiling,
    outsideImageDrivers: {
      admits: (instance) => admission.isAdmitted(instance),
      declaredUsdMicrosPerImage: (instance, modelId) =>
        admission
          .imageDriverModels(instance.configuration.driver)
          ?.find((model) => model.modelId === String(modelId))?.usdMicrosPerImage,
      adapter: (instance, ports) => admission.imageAdapter(instance, ports),
    },
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
  const enqueue = (input: { readonly modelId?: typeof pricedModel; readonly variants?: number }) =>
    service.enqueue({
      threadKind: "chat-thread",
      scopeId,
      profileInstanceId: profileId,
      modelId: input.modelId ?? pricedModel,
      prompt: "a lighthouse at dusk",
      ...(input.variants === undefined ? {} : { variantCount: input.variants }),
    });
  return {
    admission,
    connection,
    drivers,
    brokered,
    journal,
    runtime,
    service,
    setCeiling,
    used,
    enqueue,
    directory,
  };
}

describe("an outside image driver in the image job service", () => {
  it("runs a job at the package's declared price, reserves and settles exactly that, and stores the image", async () => {
    const { enqueue, service, setCeiling, used, brokered, drivers } = harness();
    setCeiling(100);
    const queued = await enqueue({ variants: 2 });
    const completed = await service.whenTerminal(queued.id);
    expect(completed.status).toBe("completed");
    expect(completed.artifacts).toHaveLength(2);
    expect(completed.artifacts[0]?.mime).toBe("image/png");
    // Two variants at 4 cents each were reserved before dispatch and settled as reserved.
    expect(used()).toBe(8);
    // The host set the key, at the configured origin only; the driver never held it.
    expect(brokered).toEqual([
      { url: "https://images.example.test/v1/generate", authorization: "Bearer sk-outside" },
    ]);
    const generate = drivers[0]?.fixture.received.find(
      (message) => message.method === "image/generate",
    );
    expect(generate?.params).toMatchObject({ modelId: "example-image-1", variantCount: 2 });
    expect(JSON.stringify(generate?.params)).not.toContain("sk-outside");
  });

  it("refuses an untrusted or switched-off driver before anything is reserved or any process starts", async () => {
    for (const activation of [{ trusted: false }, { pluginDesired: false }]) {
      const { enqueue, drivers, admission } = harness({ activation });
      expect(admission.isAdmitted(outsideProfile())).toBe(false);
      await expect(enqueue({})).rejects.toMatchObject({ category: "ineligible" });
      expect(drivers).toHaveLength(0);
    }
  });

  it("fails a job found running after a restart as interrupted and never asks the driver again", async () => {
    const first = harness({ handlers: { ...imageHandlers, "image/generate": () => NO_ANSWER } });
    const queued = await first.enqueue({});
    await vi.waitFor(() => expect(first.service.get(queued.id)?.status).toBe("running"));
    const restarted = new ImageJobService({
      journal: first.journal,
      projection: first.runtime.imageJobProjection,
      attachments: new GeneratedImageStore(first.directory),
      readProviderInstance: () => outsideProfile(),
      readImageGenerationCustomSources: () => [],
      credentialResolver: { has: async () => true, resolve: async () => "sk-outside" },
      uuid: () => crypto.randomUUID(),
      clock: () => now,
      actor: { kind: "system", actorId: "00000000-0000-4000-8000-000000000002" as never },
    });
    await restarted.reconcileInterruptedJobs();
    const job = restarted.get(queued.id);
    expect(job?.status).toBe("failed");
    expect(job?.status === "failed" ? job.failure?.message : undefined).toBe(
      IMAGE_JOB_RESTART_INTERRUPTION_MESSAGE,
    );
    expect(first.drivers).toHaveLength(1);
  });
});

describe("an outside image driver that misbehaves", () => {
  it("refuses a model its package prices at nothing while a spend limit is set, before the driver is asked", async () => {
    const { enqueue, setCeiling, drivers } = harness();
    setCeiling(100);
    await expect(enqueue({ modelId: unpricedModel })).rejects.toMatchObject({
      category: "spend-ceiling",
    });
    expect(drivers).toHaveLength(0);
  });

  it("fails as protocol and charges no more than the reservation when the driver returns more images than asked", async () => {
    const { enqueue, service, setCeiling, used } = harness({
      handlers: {
        ...imageHandlers,
        "image/generate": () => ({
          status: "completed",
          images: [
            { mediaType: "image/png", data: pngBase64 },
            { mediaType: "image/png", data: pngBase64 },
          ],
        }),
      },
    });
    setCeiling(100);
    const job = await service.whenTerminal((await enqueue({})).id);
    expect(job.status).toBe("failed");
    expect(job.status === "failed" ? job.failure?.category : undefined).toBe("protocol");
    expect(job.artifacts).toHaveLength(0);
    expect(used()).toBeLessThanOrEqual(4);
  });

  it("fails with Octant's own words, and releases the reservation, when the driver crashes mid-job", async () => {
    const { enqueue, service, setCeiling, used, drivers } = harness({
      handlers: { ...imageHandlers, "image/generate": () => NO_ANSWER },
    });
    setCeiling(100);
    const queued = await enqueue({});
    await vi.waitFor(() => expect(drivers).toHaveLength(1));
    await vi.waitFor(() =>
      expect(drivers[0]?.fixture.received.some((m) => m.method === "image/generate")).toBe(true),
    );
    drivers[0]?.end.exit();
    const job = await service.whenTerminal(queued.id);
    expect(job.status).toBe("failed");
    expect(job.status === "failed" ? job.failure?.message : undefined).toBe(
      "The provider driver stopped.",
    );
    expect(used()).toBe(0);
  });

  it("fails a job the driver never answers at its deadline, tells the driver to cancel, and charges nothing", async () => {
    const { enqueue, service, setCeiling, used, drivers } = harness({
      handlers: { ...imageHandlers, "image/generate": () => NO_ANSWER },
      sendTimeoutMs: 50,
    });
    setCeiling(100);
    const job = await service.whenTerminal((await enqueue({})).id);
    expect(job.status).toBe("failed");
    expect(job.status === "failed" ? job.failure?.message : undefined).toBe(
      "The provider driver did not answer in time.",
    );
    expect(drivers[0]?.fixture.received.some((m) => m.method === "image/cancel")).toBe(true);
    expect(used()).toBe(0);
  });

  it("keeps a driver's own error text and refusal text from the job", async () => {
    const failing = harness({
      handlers: {
        ...imageHandlers,
        "image/generate": () => {
          throw new FixtureDriverError("attacker text", {
            category: "rate-limited",
            note: "more attacker text",
          });
        },
      },
    });
    const failed = await failing.service.whenTerminal((await failing.enqueue({})).id);
    expect(JSON.stringify(failed)).not.toContain("attacker");
    expect(failed.status === "failed" ? failed.failure?.category : undefined).toBe("protocol");

    const refusing = harness({
      handlers: { ...imageHandlers, "image/generate": () => ({ status: "refused" }) },
    });
    const refused = await refusing.service.whenTerminal((await refusing.enqueue({})).id);
    expect(refused.status === "failed" ? refused.safetyRefusal : undefined).toBe(
      "The image provider declined this request.",
    );
  });

  it("refuses bytes that are not the image the driver says they are", async () => {
    const { enqueue, service } = harness({
      handlers: {
        ...imageHandlers,
        "image/generate": () => ({
          status: "completed",
          images: [{ mediaType: "image/jpeg", data: pngBase64 }],
        }),
      },
    });
    const job = await service.whenTerminal((await enqueue({})).id);
    expect(job.status === "failed" ? job.failure?.category : undefined).toBe("protocol");
  });

  it("fetches an image address only when the provider's own answer named it", async () => {
    const named = "https://cdn.images.example.test/out/1.png";
    const imageFetch = vi.fn(() => new Response(png, { status: 200 }));
    const handlers = (url: string): Readonly<Record<string, FixtureDriverHandler>> => ({
      ...imageHandlers,
      "image/generate": async (_params, context) => {
        await context.http({
          requestId: context.id,
          url: "https://images.example.test/v1/generate",
          method: "POST",
          auth: { header: "authorization", scheme: "Bearer" },
        });
        return { status: "completed", images: [{ url }] };
      },
    });
    const honest = harness({
      handlers: handlers(named),
      providerBody: JSON.stringify({ url: named }),
      imageFetch,
    });
    const completed = await honest.service.whenTerminal((await honest.enqueue({})).id);
    expect(completed.status).toBe("completed");
    expect(imageFetch).toHaveBeenCalledTimes(1);

    const forged = harness({
      handlers: handlers("https://attacker.example.test/steal.png"),
      providerBody: JSON.stringify({ url: named }),
      imageFetch,
    });
    const refused = await forged.service.whenTerminal((await forged.enqueue({})).id);
    expect(refused.status === "failed" ? refused.failure?.category : undefined).toBe(
      "unauthorized",
    );
    expect(imageFetch).toHaveBeenCalledTimes(1);
  });
});
