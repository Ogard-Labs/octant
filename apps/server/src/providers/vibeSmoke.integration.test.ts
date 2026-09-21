import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  decodeProviderInstanceId,
  decodeProviderSessionId,
  type ProviderFailure,
  type ProviderRuntimeEvent,
} from "@octant/contracts";
import { Effect, Fiber, Stream } from "effect";
import { expect, it } from "vitest";
import { makeAcpDriver } from "./acpDriver";
import { makeAcpConfinementLive, makeAcpProcessLive } from "./acpProcess";
import { acpProviderProfiles } from "./acpProfiles";
import { ProviderRuntimeRegistry } from "./providerRuntimeRegistry";

it.skipIf(process.env.OCTANT_VIBE_SMOKE !== "1")(
  "recalls prior input after restarting the native Vibe runtime in an isolated home",
  async () => {
    const credential = process.env.MISTRAL_API_KEY;
    const binaryPath = process.env.OCTANT_VIBE_BINARY;
    if (!credential || !binaryPath)
      throw new Error("Set MISTRAL_API_KEY and OCTANT_VIBE_BINARY for the isolated native smoke.");
    const root = await realpath(await mkdtemp(join(tmpdir(), "octant-vibe-smoke-")));
    const instanceId = decodeProviderInstanceId("80000000-0000-4000-8000-000000000381");
    const sessionId = decodeProviderSessionId("80000000-0000-4000-8000-000000000382");
    const registry = new ProviderRuntimeRegistry();
    const restartedRegistry = new ProviderRuntimeRegistry();
    const createDriver = (runtimeRegistry: ProviderRuntimeRegistry) =>
      makeAcpDriver({
        profile: acpProviderProfiles["mistral-vibe"],
        instanceId,
        binaryPath,
        managedHome: join(root, "managed"),
        runtimeRegistry,
        authentication: "api-key",
        credentialResolver: { has: async () => true, resolve: async () => credential },
        process: makeAcpProcessLive({
          confinement: makeAcpConfinementLive({ hostAuthenticationPath: join(root, "provider") }),
        }),
      });
    const marker = `octant-${crypto.randomUUID()}`;
    try {
      const driver = createDriver(registry);
      const cursor = await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const probe = yield* driver.probe({ instanceId });
            expect(probe.readiness).toBe("ready");
            const model =
              probe.models.find((entry) => entry.id === process.env.OCTANT_VIBE_MODEL) ??
              probe.models[0];
            if (model === undefined) throw new Error("Vibe did not offer a model.");
            const connection = yield* driver.acquire({
              instanceId,
              projectRoot: root,
              mode: "code",
            });
            const started = yield* connection.start({
              sessionId,
              modelId: model.id,
              executionPolicy: "approval-gated",
            });
            const events = yield* Effect.fork(collect(yield* connection.subscribe));
            yield* connection.send({
              sessionId,
              prompt: `Remember this marker for my next message: ${marker}. Reply only OK. Do not use tools.`,
              attachments: [],
              tools: [],
            });
            const result = Array.from(yield* Fiber.join(events));
            expect(result.at(-1)?.kind).toBe("completed");
            yield* connection.stop(sessionId);
            if (started.resumeCursor === undefined) throw new Error("Missing native cursor.");
            return started.resumeCursor;
          }),
        ),
      );
      await registry.closeAll();
      const restarted = createDriver(restartedRegistry);
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const connection = yield* restarted.acquire({
              instanceId,
              projectRoot: root,
              mode: "code",
            });
            const resumed = yield* connection.resume({
              sessionId,
              resumeCursor: cursor,
              executionPolicy: "approval-gated",
            });
            expect(resumed.resumeCursor?.value).toBe(cursor.value);
            const events = yield* Effect.fork(collect(yield* connection.subscribe));
            yield* connection.send({
              sessionId,
              prompt: "Reply with only the marker I asked you to remember. Do not use tools.",
              attachments: [],
              tools: [],
            });
            const result = Array.from(yield* Fiber.join(events));
            expect(result.at(-1)?.kind).toBe("completed");
            expect(
              result.flatMap((event) => (event.kind === "text-delta" ? [event.text] : [])).join(""),
            ).toContain(marker);
            yield* connection.stop(sessionId);
          }),
        ),
      );
      expect(restartedRegistry.activeSessionCount(instanceId)).toBe(0);
    } finally {
      const cleanup = await Promise.allSettled([registry.closeAll(), restartedRegistry.closeAll()]);
      const failed = cleanup.find((result) => result.status === "rejected");
      if (failed?.status === "rejected") throw failed.reason;
      await rm(root, { recursive: true, force: true });
    }
  },
  120_000,
);

function collect(events: Stream.Stream<ProviderRuntimeEvent, ProviderFailure>) {
  return Stream.runCollect(
    events.pipe(
      Stream.takeUntil((event) =>
        ["completed", "failed", "interrupted", "waiting"].includes(event.kind),
      ),
    ),
  );
}
