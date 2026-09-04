import {
  decodeProviderInstanceId,
  decodeProviderModelId,
  decodeProviderSessionId,
  type ProviderFailure,
  type ProviderRuntimeEvent,
} from "@octant/contracts";
import { Effect, Fiber, Stream } from "effect";
import { describe, expect, it } from "vitest";
import { makeOllamaDriver } from "./ollamaDriver";
import { ProviderRuntimeRegistry } from "./providerRuntimeRegistry";

const probeEnabled = process.env.OCTANT_OLLAMA_PROBE === "1";
const smokeEnabled = process.env.OCTANT_OLLAMA_SMOKE === "1";
const baseUrl = process.env.OCTANT_OLLAMA_BASE_URL ?? "http://127.0.0.1:11434";
const instanceId = decodeProviderInstanceId("80000000-0000-4000-8000-000000000731");
const sessionId = decodeProviderSessionId("80000000-0000-4000-8000-000000000732");

function fixture() {
  const registry = new ProviderRuntimeRegistry();
  const driver = makeOllamaDriver({
    instanceId,
    configuration: { kind: "ollama-native-http", baseUrl },
    runtimeRegistry: registry,
  });
  return { registry, driver };
}

describe("installed Ollama service", () => {
  it.skipIf(!probeEnabled)(
    "performs bounded non-mutating version and model discovery",
    async () => {
      const { registry, driver } = fixture();
      const probe = await Effect.runPromise(Effect.scoped(driver.probe({ instanceId })));
      expect(probe.readiness).toBe("ready");
      expect(probe.detectedVersion).toMatch(/^\d+\.\d+\.\d+/);
      expect(probe.models.length).toBeGreaterThan(0);
      expect(registry.activeSessionCount(instanceId)).toBe(0);
    },
    30_000,
  );

  it.skipIf(!smokeEnabled)(
    "streams one local-model turn, resumes Octant history, and releases requests",
    async () => {
      const { registry, driver } = fixture();
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const probe = yield* driver.probe({ instanceId });
            const configuredModel = process.env.OCTANT_OLLAMA_MODEL;
            const modelId =
              configuredModel === undefined
                ? probe.models[0]?.id
                : decodeProviderModelId(configuredModel);
            if (modelId === undefined) throw new Error("Ollama smoke requires an installed model.");
            const connection = yield* driver.acquire({
              instanceId,
              projectRoot: "/tmp",
              mode: "code",
            });
            const started = yield* connection.start({
              sessionId,
              modelId,
              executionPolicy: "approval-gated",
            });
            const completion = yield* Effect.fork(collectTerminal(yield* connection.subscribe));
            yield* connection.send({
              sessionId,
              prompt: "Reply with exactly: octant-ollama-smoke",

              attachments: [],
              tools: [],
            });
            const events = Array.from(yield* Fiber.join(completion));
            expect(events.some((event) => event.kind === "text-delta")).toBe(true);
            expect(events.at(-1)?.kind).toBe("completed");
            yield* connection.stop(sessionId);
            if (started.resumeCursor === undefined)
              throw new Error("Ollama resume cursor missing.");
            yield* connection.resume({
              sessionId,
              resumeCursor: started.resumeCursor,
              executionPolicy: "approval-gated",
            });
            yield* connection.stop(sessionId);
          }),
        ),
      );
      expect(registry.activeSessionCount(instanceId)).toBe(0);
    },
    120_000,
  );
});

function collectTerminal(events: Stream.Stream<ProviderRuntimeEvent, ProviderFailure>) {
  return Stream.runCollect(
    events.pipe(
      Stream.filter((event) => event.sessionId === sessionId),
      Stream.takeUntil((event) =>
        ["completed", "interrupted", "failed", "waiting"].includes(event.kind),
      ),
    ),
  );
}
