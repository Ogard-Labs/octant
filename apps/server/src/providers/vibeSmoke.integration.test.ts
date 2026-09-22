import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  decodeProviderInstanceId,
  decodeProviderSessionId,
  type ProviderFailure,
  type ProviderRuntimeEvent,
  type ProviderToolDefinition,
} from "@octant/contracts";
import type { ProviderConnection } from "@octant/provider-sdk/driver";
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
    let processStarts = 0;
    const processPort = makeAcpProcessLive({
      confinement: makeAcpConfinementLive({ hostAuthenticationPath: join(root, "provider") }),
    });
    const createDriver = (runtimeRegistry: ProviderRuntimeRegistry) =>
      makeAcpDriver({
        profile: acpProviderProfiles["mistral-vibe"],
        instanceId,
        binaryPath,
        managedHome: join(root, "managed"),
        runtimeRegistry,
        authentication: "api-key",
        credentialResolver: { has: async () => true, resolve: async () => credential },
        process: {
          start: (input) => {
            processStarts += 1;
            return processPort.start(input);
          },
        },
      });
    const marker = `octant-${crypto.randomUUID()}`;
    const tools: ReadonlyArray<ProviderToolDefinition> =
      process.env.OCTANT_VIBE_TOOL_SMOKE === "1"
        ? [
            {
              name: "octant_smoke_observe",
              description: "Return a fresh synthetic observation marker. This has no side effects.",
              inputSchema: { type: "object", properties: {}, additionalProperties: false },
            },
          ]
        : [];
    const toolInstruction =
      tools.length === 0
        ? "Do not use tools."
        : "Call octant_smoke_observe exactly once and include its returned marker. Do not use other tools.";
    const toolMarkers = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()];
    let turn = 0;
    let toolCalls = 0;
    const observe = (connection: ProviderConnection) => (event: ProviderRuntimeEvent) => {
      if (event.kind !== "tool-request") return Effect.void;
      expect(event.toolName).toBe("octant_smoke_observe");
      toolCalls += 1;
      return connection.answerTool({
        sessionId,
        requestId: event.requestId,
        resultJson: JSON.stringify({ marker: toolMarkers[turn] }),
        isError: false,
      });
    };
    const cleanupFailures: unknown[] = [];
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
              executionPolicy: "full-access",
              tools,
            });
            const events = yield* Effect.fork(
              collect((yield* connection.subscribe).pipe(Stream.tap(observe(connection)))),
            );
            yield* connection.send({
              sessionId,
              prompt: `Remember this marker for my next message: ${marker}. ${toolInstruction}`,
              attachments: [],
              tools,
            });
            const result = Array.from(yield* Fiber.join(events));
            expect(result.at(-1)?.kind).toBe("completed");
            if (tools.length > 0)
              expect(
                result
                  .flatMap((event) => (event.kind === "text-delta" ? [event.text] : []))
                  .join(""),
              ).toContain(toolMarkers[turn]);
            yield* connection.stop(sessionId);
            if (started.resumeCursor === undefined) throw new Error("Missing native cursor.");
            return started.resumeCursor;
          }),
        ),
      );
      turn = 1;
      const beforeWarm = processStarts;
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const connection = yield* driver.acquire({
              instanceId,
              projectRoot: root,
              mode: "code",
            });
            yield* connection.resume({
              sessionId,
              resumeCursor: cursor,
              executionPolicy: "full-access",
              tools,
            });
            expect(processStarts).toBe(beforeWarm);
            const events = yield* Effect.fork(
              collect((yield* connection.subscribe).pipe(Stream.tap(observe(connection)))),
            );
            yield* connection.send({
              sessionId,
              prompt: `Reply with the marker from my previous message. ${toolInstruction}`,
              attachments: [],
              tools,
            });
            const result = Array.from(yield* Fiber.join(events));
            expect(result.at(-1)?.kind).toBe("completed");
            if (tools.length > 0)
              expect(
                result
                  .flatMap((event) => (event.kind === "text-delta" ? [event.text] : []))
                  .join(""),
              ).toContain(toolMarkers[turn]);
            expect(
              result.flatMap((event) => (event.kind === "text-delta" ? [event.text] : [])).join(""),
            ).toContain(marker);
            yield* connection.stop(sessionId);
          }),
        ),
      );
      await registry.closeAll();
      turn = 2;
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
              executionPolicy: "full-access",
              tools,
            });
            expect(resumed.resumeCursor?.value).toBe(cursor.value);
            const events = yield* Effect.fork(
              collect((yield* connection.subscribe).pipe(Stream.tap(observe(connection)))),
            );
            yield* connection.send({
              sessionId,
              prompt: `Reply with the marker I asked you to remember. ${toolInstruction}`,
              attachments: [],
              tools,
            });
            const result = Array.from(yield* Fiber.join(events));
            expect(result.at(-1)?.kind).toBe("completed");
            if (tools.length > 0)
              expect(
                result
                  .flatMap((event) => (event.kind === "text-delta" ? [event.text] : []))
                  .join(""),
              ).toContain(toolMarkers[turn]);
            expect(
              result.flatMap((event) => (event.kind === "text-delta" ? [event.text] : [])).join(""),
            ).toContain(marker);
            yield* connection.stop(sessionId);
          }),
        ),
      );
      expect(restartedRegistry.activeSessionCount(instanceId)).toBe(0);
      if (tools.length > 0) expect(toolCalls).toBe(3);
    } finally {
      const cleanup = await Promise.allSettled([registry.closeAll(), restartedRegistry.closeAll()]);
      const failed = cleanup.find((result) => result.status === "rejected");
      if (failed?.status === "rejected") cleanupFailures.push(failed.reason);
      await rm(root, { recursive: true, force: true }).catch((error: unknown) => {
        cleanupFailures.push(error);
      });
    }
    if (cleanupFailures.length > 0)
      throw new AggregateError(cleanupFailures, "Smoke cleanup failed.");
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
