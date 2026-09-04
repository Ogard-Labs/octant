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
import { makeAcpDriver } from "./acpDriver";
import { makeAcpProcessLive } from "./acpProcess";
import { acpProviderProfiles } from "./acpProfiles";
import { ProviderRuntimeRegistry } from "./providerRuntimeRegistry";

const enabled = process.env.OCTANT_GROK_SMOKE === "1";
const binaryPath = process.env.OCTANT_GROK_BINARY ?? "/opt/homebrew/bin/grok";
const grokHome = process.env.OCTANT_GROK_HOME ?? "/tmp/octant-grok-smoke";
const instanceId = decodeProviderInstanceId("80000000-0000-4000-8000-000000000341");
const completionSessionId = decodeProviderSessionId("80000000-0000-4000-8000-000000000342");
const interruptSessionId = decodeProviderSessionId("80000000-0000-4000-8000-000000000343");

describe("installed Grok Build runtime", () => {
  it.skipIf(!enabled)(
    "uses provider-native authentication for a harmless stream, exact resume, interrupt, and cleanup",
    async () => {
      const temporaryRoot = await realpath(await mkdtemp(join(tmpdir(), "octant-grok-smoke-")));
      const registry = new ProviderRuntimeRegistry();
      const driver = makeAcpDriver({
        profile: acpProviderProfiles.grok,
        instanceId,
        binaryPath,
        managedHome: grokHome,
        process: makeAcpProcessLive(),
        runtimeRegistry: registry,
      });
      try {
        await Effect.runPromise(
          Effect.scoped(
            Effect.gen(function* () {
              const probe = yield* driver.probe({ instanceId });
              expect(probe.readiness).toBe("ready");
              expect(probe.detectedVersion).toMatch(/^\d+\.\d+\.\d+/);
              expect(probe.models.length).toBeGreaterThan(0);
              const modelId = probe.models[0]!.id as ProviderModelId;
              const connection = yield* driver.acquire({
                instanceId,
                projectRoot: temporaryRoot,
                mode: "code",
              });

              const started = yield* connection.start({
                sessionId: completionSessionId,
                modelId,
                executionPolicy: "full-access",
              });
              const completion = yield* Effect.fork(
                collectTerminal(yield* connection.subscribe, completionSessionId),
              );
              yield* connection.send({
                sessionId: completionSessionId,
                prompt: "Reply with exactly: octant-grok-smoke",

                attachments: [],
                tools: [],
              });
              const completedEvents = Array.from(yield* Fiber.join(completion));
              expect(completedEvents.some((event) => event.kind === "text-delta")).toBe(true);
              expect(completedEvents.at(-1)?.kind).toBe("completed");
              yield* connection.stop(completionSessionId);

              if (started.resumeCursor === undefined)
                throw new Error("Grok resume cursor missing.");
              yield* connection.resume({
                sessionId: completionSessionId,
                resumeCursor: started.resumeCursor,
                executionPolicy: "full-access",
              });
              yield* connection.stop(completionSessionId);

              yield* connection.start({
                sessionId: interruptSessionId,
                modelId,
                executionPolicy: "full-access",
              });
              const interrupted = yield* Effect.fork(
                collectTerminal(yield* connection.subscribe, interruptSessionId),
              );
              yield* connection.send({
                sessionId: interruptSessionId,
                prompt: "Write a long explanation of orbital mechanics without using tools.",

                attachments: [],
                tools: [],
              });
              yield* connection.interrupt(interruptSessionId);
              expect(Array.from(yield* Fiber.join(interrupted)).at(-1)?.kind).toBe("interrupted");
              yield* connection.stop(interruptSessionId);
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
});

function collectTerminal(
  events: Stream.Stream<ProviderRuntimeEvent, import("@octant/contracts").ProviderFailure>,
  sessionId: ProviderRuntimeEvent["sessionId"],
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
