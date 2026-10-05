import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decodeProviderInstanceId, decodeProviderSessionId } from "@octant/contracts";
import { Effect, Fiber, Stream } from "effect";
import { describe, expect, it } from "vitest";
import { makeAcpDriver } from "./acpDriver";
import { makeAcpProcessLive } from "./acpProcess";
import { acpProviderProfiles } from "./acpProfiles";
import type { AcpSessionConfigOption } from "./acpProtocol";
import { ProviderRuntimeRegistry } from "./providerRuntimeRegistry";

const enabled = process.env.OCTANT_DEVIN_SMOKE === "1";
const binaryPath = process.env.OCTANT_DEVIN_BINARY ?? "/opt/homebrew/bin/devin";
const instanceId = decodeProviderInstanceId("80000000-0000-4000-8000-000000000371");

describe("installed Devin runtime", () => {
  it.skipIf(!enabled)(
    "discovers and restores Fusion pairing, effort, and Fast Mode after a minimal turn",
    async () => {
      const managedHome = await realpath(await mkdtemp(join(tmpdir(), "octant-devin-smoke-")));
      const registry = new ProviderRuntimeRegistry();
      let reported: ReadonlyArray<AcpSessionConfigOption> = [];
      const driver = makeAcpDriver({
        profile: acpProviderProfiles.devin,
        instanceId,
        binaryPath,
        managedHome,
        process: makeAcpProcessLive(),
        runtimeRegistry: registry,
        clientFactory: (connection) => ({
          ...connection.acp,
          setConfigOption: async (sessionId, configId, value) => {
            const result = await connection.acp.setConfigOption(sessionId, configId, value);
            reported = result.configOptions;
            return result;
          },
        }),
      });
      try {
        const probe = await Effect.runPromise(Effect.scoped(driver.probe({ instanceId })));
        expect(probe.readiness).toBe("ready");
        expect(probe.detectedVersion).toMatch(/^\d+\.\d+\.\d+$/);
        expect(probe.models.length).toBeGreaterThan(0);
        expect(registry.activeSessionCount(instanceId)).toBe(0);
        const pairing = probe.models.find(
          (model) =>
            model.configuration?.family === "Fusion" &&
            model.options.some(
              (option) =>
                option.kind === "selection" &&
                option.id === "speed" &&
                option.values.includes("fast"),
            ),
        );
        if (pairing === undefined)
          throw new Error("The authenticated account must offer a Fusion pairing with Fast Mode.");
        const thinking = pairing.options.find(
          (option) => option.id === "thought_level" && option.kind === "selection",
        );
        if (thinking === undefined || thinking.kind !== "selection")
          throw new Error("Expected Fusion effort choices.");
        const level = thinking.values[0];
        const sessionId = decodeProviderSessionId("80000000-0000-4000-8000-000000000372");
        await Effect.runPromise(
          Effect.scoped(
            Effect.gen(function* () {
              const connection = yield* driver.acquire({
                instanceId,
                projectRoot: managedHome,
                mode: "code",
              });
              const input = {
                sessionId,
                modelId: pairing.id,
                executionPolicy: "approval-gated" as const,
                modelOptionValues: { [thinking.id]: level, speed: "fast" },
              };
              const started = yield* connection.start(input);
              const assertSettings = () => {
                expect(reported.find((option) => option.id === "model")?.currentValue).toBe(
                  String(pairing.id),
                );
                expect(reported.find((option) => option.id === thinking.id)?.currentValue).toBe(
                  level,
                );
                expect(reported.find((option) => option.id === "speed")?.currentValue).toBe("fast");
                expect(reported.find((option) => option.id === "mode")?.currentValue).toBe("ask");
              };
              assertSettings();
              const events = yield* connection.subscribe;
              const terminal = yield* Effect.fork(
                Stream.runCollect(
                  events.pipe(
                    Stream.filter((event) => event.sessionId === sessionId),
                    Stream.takeUntil((event) =>
                      ["completed", "interrupted", "failed", "waiting"].includes(event.kind),
                    ),
                  ),
                ),
              );
              yield* connection.send({
                sessionId,
                prompt: "Reply with READY only. Do not use any tools or change any files.",
                attachments: [],
                tools: [],
              });
              const completed = Array.from(yield* Fiber.join(terminal));
              expect(completed.at(-1)?.kind).toBe("completed");
              yield* connection.stop(sessionId);
              if (started.resumeCursor === undefined)
                throw new Error("Expected native Fusion cursor.");
              yield* connection.resume({ ...input, resumeCursor: started.resumeCursor });
              assertSettings();
              yield* connection.stop(sessionId);
            }),
          ),
        );
        expect(registry.activeSessionCount(instanceId)).toBe(0);
      } finally {
        await registry.closeAll();
        await rm(managedHome, { recursive: true, force: true });
      }
    },
    90_000,
  );
});
