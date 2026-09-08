import {
  decodeProviderInstanceId,
  decodeProviderSessionId,
  type ProviderModelId,
} from "@octant/contracts";
import { accessSync, constants, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { Effect, Fiber, Stream } from "effect";
import { describe, expect, it } from "vitest";
import { makeOfficialOpenCodeClient, makeOpenCodeDriver } from "./openCodeDriver";
import { makeOpenCodeProcessLive } from "./openCodeProcess";
import { ProviderRuntimeRegistry } from "./providerRuntimeRegistry";

const enabled = process.env.OCTANT_OPENCODE_SMOKE === "1";

describe("real OpenCode integration", () => {
  it.skipIf(!enabled)(
    "runs only with OCTANT_OPENCODE_SMOKE=1 because it starts the installed authenticated CLI",
    async () => {
      const binaryPath = findExecutable("opencode");
      expect(binaryPath, "enabled smoke requires an installed OpenCode CLI").not.toBeNull();
      const instanceId = decodeProviderInstanceId("80000000-0000-4000-8000-000000000301");
      const sessionId = decodeProviderSessionId("80000000-0000-4000-8000-000000000302");
      const registry = new ProviderRuntimeRegistry();
      const driver = makeOpenCodeDriver({
        instanceId,
        binaryPath: binaryPath!,
        process: makeOpenCodeProcessLive({ startupTimeoutMs: 20_000 }),
        runtimeRegistry: registry,
        idleLeaseMs: 0,
        permissionPersistence: () => "current-session",
      });
      const projectRoot = process.cwd();
      const probe = await Effect.runPromise(Effect.scoped(driver.probe({ instanceId })));
      expect(probe.readiness).toBe("ready");
      expect(probe.detectedVersion).toMatch(/^\d+\.\d+\.\d+/);
      expect(probe.models.length).toBeGreaterThan(0);

      await Effect.runPromise(
        Effect.scoped(
          driver.acquire({ instanceId, projectRoot }).pipe(
            Effect.flatMap((connection) =>
              connection
                .start({
                  sessionId,
                  modelId: probe.models[0]!.id as ProviderModelId,
                  executionPolicy: "plan",
                })
                .pipe(Effect.tap(() => connection.interrupt(sessionId))),
            ),
          ),
        ),
      );
      await registry.closeAll();
      expect(registry.hasRuntime(instanceId)).toBe(false);
    },
    60_000,
  );
  it.skipIf(process.env.OCTANT_OPENCODE_TOOL_SMOKE !== "1")(
    "round-trips a read-only app tool through the installed runtime when explicitly enabled",
    async () => {
      const binaryPath = findExecutable("opencode");
      if (binaryPath === undefined) throw new Error("The enabled smoke requires an installed CLI.");
      const requestedModel = process.env.OCTANT_OPENCODE_TOOL_MODEL;
      if (requestedModel === undefined)
        throw new Error(
          "Set OCTANT_OPENCODE_TOOL_MODEL to an anonymous model available in an empty profile.",
        );
      const instanceId = decodeProviderInstanceId("80000000-0000-4000-8000-000000000303");
      const sessionId = decodeProviderSessionId("80000000-0000-4000-8000-000000000304");
      const registry = new ProviderRuntimeRegistry();
      const projectRoot = realpathSync(mkdtempSync(join(tmpdir(), "octant-managed-tool-smoke-")));
      const processPort = makeOpenCodeProcessLive({
        startupTimeoutMs: 20_000,
        inheritedEnvironment: {
          PATH: process.env.PATH,
          HOME: projectRoot,
          XDG_CONFIG_HOME: join(projectRoot, "config"),
          XDG_DATA_HOME: join(projectRoot, "data"),
          XDG_STATE_HOME: join(projectRoot, "state"),
          XDG_CACHE_HOME: join(projectRoot, "cache"),
          OPENCODE_DISABLE_AUTOUPDATE: "1",
          OPENCODE_DISABLE_LSP_DOWNLOAD: "1",
          OPENCODE_DISABLE_PROJECT_CONFIG: "1",
          OPENCODE_DISABLE_EXTERNAL_SKILLS: "1",
        },
      });
      const driver = makeOpenCodeDriver({
        instanceId,
        binaryPath,
        process: {
          start: (input) =>
            processPort
              .start({ ...input, cwd: projectRoot })
              .pipe(
                Effect.map((runtime) => ({ ...runtime, isolatedConfiguration: true as const })),
              ),
        },
        clientFactory: (runtime) => makeOfficialOpenCodeClient(runtime, projectRoot),
        runtimeRegistry: registry,
        idleLeaseMs: 0,
        permissionPersistence: () => "current-session",
      });
      const marker = "octant-managed-tool-roundtrip";
      const tool = {
        name: "octant_smoke_echo",
        description: "A read-only integration check that returns the supplied text.",
        inputSchema: {
          type: "object",
          properties: { text: { type: "string" } },
          required: ["text"],
          additionalProperties: false,
        },
      } as const;
      let toolCalls = 0;
      let approvalRequests = 0;
      let reply = "";
      const eventKinds: string[] = [];
      const failures: string[] = [];
      try {
        const probe = await Effect.runPromise(Effect.scoped(driver.probe({ instanceId })));
        expect(probe.capabilities.appManagedTools).toBe("supported");
        const models = probe.models.filter(
          (model) => String(model.id) === requestedModel || model.displayName === requestedModel,
        );
        const model = models[0];
        if (models.length !== 1 || model === undefined)
          throw new Error("The selected smoke model must match exactly one configured model.");
        await Effect.runPromise(
          Effect.scoped(
            Effect.gen(function* () {
              const connection = yield* driver.acquire({ instanceId, projectRoot });
              const events = yield* connection.subscribe;
              const consume = yield* Effect.forkScoped(
                Stream.runForEach(
                  events.pipe(
                    Stream.takeUntil((event) =>
                      ["completed", "failed", "interrupted"].includes(event.kind),
                    ),
                  ),
                  (event) =>
                    Effect.gen(function* () {
                      if (eventKinds.length < 100) eventKinds.push(event.kind);
                      if (event.kind === "failed") failures.push(event.failure.category);
                      if (event.kind === "tool-request") {
                        toolCalls += 1;
                        expect(event.toolName).toBe(tool.name);
                        expect(JSON.parse(event.inputJson)).toEqual({ text: marker });
                        yield* connection.answerTool({
                          sessionId,
                          requestId: event.requestId,
                          resultJson: JSON.stringify({ text: marker }),
                          isError: false,
                        });
                      } else if (event.kind === "approval-request") {
                        approvalRequests += 1;
                        yield* connection.answerApproval({
                          sessionId,
                          requestId: event.requestId,
                          approved: false,
                        });
                      } else if (event.kind === "text-delta") {
                        reply += event.text;
                      }
                    }),
                ),
              );
              yield* connection.start({
                sessionId,
                modelId: model.id,
                executionPolicy: "plan",
                tools: [tool],
              });
              yield* connection.send({
                sessionId,
                prompt: `Call octant_smoke_echo exactly once with {"text":"${marker}"}. Reply with the returned text. Do not use any other tools, read files, or change files.`,
                attachments: [],
                tools: [tool],
              });
              yield* Fiber.join(consume).pipe(Effect.timeout("90 seconds"));
            }),
          ),
        );
        expect(toolCalls, JSON.stringify({ eventKinds, failures, approvalRequests, reply })).toBe(
          1,
        );
        expect(approvalRequests).toBe(0);
        expect(reply).toContain(marker);
      } finally {
        await registry.closeAll();
        rmSync(projectRoot, { recursive: true, force: true });
      }
    },
    120_000,
  );
});

function findExecutable(name: string): string | undefined {
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    const candidate = join(directory, name);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Keep searching the inherited PATH without invoking a shell.
    }
  }
  return undefined;
}
