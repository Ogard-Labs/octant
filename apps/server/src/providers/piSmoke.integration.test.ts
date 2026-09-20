import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  decodeProviderInstanceId,
  decodeProviderSessionId,
  type ProviderModelId,
  type ProviderRuntimeEvent,
} from "@octant/contracts";
import { Effect, Fiber, Stream } from "effect";
import { describe, expect, it } from "vitest";
import { makePiDriver } from "./piDriver";
import { makePiConfinementLive, makePiProcessLive } from "./piProcess";
import { ProviderRuntimeRegistry } from "./providerRuntimeRegistry";

const probeEnabled = process.env.OCTANT_PI_PROBE === "1";
const smokeEnabled = process.env.OCTANT_PI_SMOKE === "1";
const binaryPath = process.env.OCTANT_PI_BINARY ?? "/opt/homebrew/bin/pi";
const instanceId = decodeProviderInstanceId("80000000-0000-4000-8000-000000000721");
const sessionId = decodeProviderSessionId("80000000-0000-4000-8000-000000000722");

async function fixture() {
  const temporaryRoot = await realpath(await mkdtemp(join(tmpdir(), "octant-pi-smoke-")));
  const piHome = join(temporaryRoot, "managed");
  const registry = new ProviderRuntimeRegistry();
  const driver = makePiDriver({
    instanceId,
    binaryPath,
    piHome,
    process: makePiProcessLive(),
    runtimeRegistry: registry,
  });
  return { temporaryRoot, registry, driver };
}

describe("installed Pi runtime", () => {
  it.skipIf(!probeEnabled)(
    "performs bounded version and model discovery without sending a prompt",
    async () => {
      const { temporaryRoot, registry, driver } = await fixture();
      try {
        const probe = await Effect.runPromise(Effect.scoped(driver.probe({ instanceId })));
        expect(probe.readiness).toBe("ready");
        expect(probe.detectedVersion).toMatch(/^\d+\.\d+\.\d+$/);
        expect(probe.models.length).toBeGreaterThan(0);
        expect(registry.activeSessionCount(instanceId)).toBe(0);
      } finally {
        await registry.closeAll();
        await rm(temporaryRoot, { recursive: true, force: true });
      }
    },
    30_000,
  );

  it.skipIf(!smokeEnabled)(
    "streams a harmless turn, resumes exactly, interrupts, and cleans up",
    async () => {
      const { temporaryRoot, registry, driver } = await fixture();
      try {
        await Effect.runPromise(
          Effect.scoped(
            Effect.gen(function* () {
              const probe = yield* driver.probe({ instanceId });
              const modelId = probe.models[0]?.id as ProviderModelId | undefined;
              if (modelId === undefined) throw new Error("Pi model missing.");
              const connection = yield* driver.acquire({
                instanceId,
                projectRoot: temporaryRoot,
                mode: "code",
              });
              const started = yield* connection.start({
                sessionId,
                modelId,
                executionPolicy: "full-access",
              });
              const completion = yield* Effect.fork(collectTerminal(yield* connection.subscribe));
              yield* connection.send({
                sessionId,
                prompt: "Reply with exactly: octant-pi-smoke",

                attachments: [],
                tools: [],
              });
              const events = Array.from(yield* Fiber.join(completion));
              expect(events.some((event) => event.kind === "text-delta")).toBe(true);
              expect(events.at(-1)?.kind).toBe("completed");
              yield* connection.stop(sessionId);
              if (started.resumeCursor === undefined) throw new Error("Pi resume cursor missing.");
              yield* connection.resume({
                sessionId,
                resumeCursor: started.resumeCursor,
                executionPolicy: "full-access",
              });
              yield* connection.stop(sessionId);
            }),
          ),
        );
        expect(registry.activeSessionCount(instanceId)).toBe(0);
      } finally {
        await registry.closeAll();
        await rm(temporaryRoot, { recursive: true, force: true });
      }
    },
    120_000,
  );

  // The table in piProcess.ts mirrors the variables Pi reads for each provider. Dummy
  // keys and no linked auth.json mean a provider is listed only if Pi found its
  // credential in the environment Octant passed, so a renamed variable fails here.
  it.skipIf(!probeEnabled)(
    "shows Pi a host credential only for the model provider it belongs to",
    async () => {
      const temporaryRoot = await realpath(await mkdtemp(join(tmpdir(), "octant-pi-env-")));
      const piHome = join(temporaryRoot, "managed");
      const port = makePiProcessLive({
        confinement: makePiConfinementLive({
          credentialPath: join(temporaryRoot, "absent-auth.json"),
          modelsPath: join(temporaryRoot, "absent-models.json"),
        }),
        inheritedEnvironment: {
          PATH: process.env.PATH ?? "/usr/bin:/bin",
          ANTHROPIC_API_KEY: "not-a-real-key",
          OPENAI_API_KEY: "not-a-real-key",
        },
      });
      const availableProviders = (modelProvider?: string) =>
        Effect.runPromise(
          Effect.scoped(
            Effect.gen(function* () {
              const connection = yield* port.start({
                binaryPath,
                root: piHome,
                piHome,
                sessionDirectory: join(piHome, "sessions"),
                sessionId: `probe-${crypto.randomUUID()}`,
                mode: "chat",
                executionPolicy: "approval-gated",
                ...(modelProvider === undefined ? {} : { modelProvider }),
              });
              const response = yield* Effect.promise(() =>
                connection.rpc.request("get_available_models"),
              );
              const models = (response.data as { models?: ReadonlyArray<{ provider: string }> })
                .models;
              return new Set((models ?? []).map((model) => model.provider));
            }),
          ),
        );
      try {
        const anthropic = await availableProviders("anthropic");
        expect(anthropic.has("anthropic")).toBe(true);
        expect(anthropic.has("openai")).toBe(false);
        const openai = await availableProviders("openai");
        expect(openai.has("openai")).toBe(true);
        expect(openai.has("anthropic")).toBe(false);
        const discovery = await availableProviders();
        expect(discovery.has("anthropic") || discovery.has("openai")).toBe(false);
      } finally {
        await rm(temporaryRoot, { recursive: true, force: true });
      }
    },
    60_000,
  );
});

function collectTerminal(
  events: Stream.Stream<ProviderRuntimeEvent, import("@octant/contracts").ProviderFailure>,
) {
  return Stream.runCollect(
    events.pipe(
      Stream.filter((event) => event.sessionId === sessionId),
      Stream.takeUntil((event) =>
        ["completed", "interrupted", "failed", "waiting"].includes(event.kind),
      ),
    ),
  );
}
