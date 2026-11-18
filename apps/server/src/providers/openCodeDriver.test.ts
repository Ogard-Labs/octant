import {
  decodeProviderInstanceId,
  type ProviderModelId,
  type ProviderRuntimeEvent,
  type ProviderResumeCursor,
  decodeProviderSessionId,
} from "@octant/contracts";
import type {
  Event,
  PermissionRuleset,
  PermissionV2Ruleset,
  Provider,
  Session,
} from "@opencode-ai/sdk/v2/types";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Effect, Exit, Fiber, Stream } from "effect";
import { describe, expect, it, vi } from "vitest";
import {
  adaptBetaOpenCodeEvent,
  betaAgentPermissionRules,
  betaSessionPermissionRules,
  betaPermissionEffect,
  makeOpenCodeDriver,
  normalizeOpenCodeProbe,
  OpenCodeCommandNotRun,
  openCodePromptParts,
  permissionRules,
  type OpenCodeClientPort,
} from "./openCodeDriver";
import type { OpenCodeEvent } from "./openCodeEventMapper";
import { NO_OPENCODE_OWN_SETUP, type OpenCodeOwnSetup } from "./openCodeOwnSetup";
import { ProviderRuntimeRegistry } from "./providerRuntimeRegistry";
import {
  betaPermissionsForRelease,
  makeOpenCodeProcessLive,
  type OpenCodeProcessPort,
  type OpenCodeProcessStartInput,
} from "./openCodeProcess";
import { SECRET_QUESTION_REFUSAL } from "./secretQuestion";

const fakeCliPath = fileURLToPath(new URL("./fixtures/fakeOpenCodeCli.ts", import.meta.url));
const instanceId = decodeProviderInstanceId("80000000-0000-4000-8000-000000000101");
const sessionId = decodeProviderSessionId("80000000-0000-4000-8000-000000000102");
const otherSessionId = decodeProviderSessionId("80000000-0000-4000-8000-000000000104");
const modelId = "anthropic/claude-sonnet" as ProviderModelId;
const now = "2026-07-15T00:00:00.000Z";

describe("OpenCode driver", () => {
  it("does not start a provider process until the session supplies its execution policy", async () => {
    const fixture = driverFixture();
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const connection = yield* fixture.driver.acquire({
            instanceId,
            projectRoot: "/tmp/project",
            mode: "code",
          });
          expect(fixture.calls).not.toContain("process.start");
          yield* connection.start({ sessionId, modelId, executionPolicy: "plan" });
          expect(fixture.calls).toContain("process.start");
          expect(fixture.processInputs[0]).toMatchObject({
            cwd: "/tmp/project",
            mode: "code",
            executionPolicy: "plan",
          });
        }),
      ),
    );
  });

  it("runs a resumed session on the thread's current model when it changed", async () => {
    const fixture = driverFixture();
    const otherModel = "anthropic/claude-opus" as ProviderModelId;
    await Effect.runPromise(
      Effect.scoped(
        fixture.driver.acquire({ instanceId, projectRoot: "/tmp/project" }).pipe(
          Effect.flatMap((connection) =>
            connection.start({ sessionId, modelId, executionPolicy: "approval-gated" }).pipe(
              Effect.flatMap((handle) =>
                connection.resume({
                  sessionId,
                  resumeCursor: handle.resumeCursor!,
                  executionPolicy: "approval-gated",
                  modelId: otherModel,
                }),
              ),
              Effect.flatMap(() =>
                connection.send({ sessionId, prompt: "hello", attachments: [], tools: [] }),
              ),
            ),
          ),
        ),
      ),
    );
    // The resume must not refuse a model change it can honor, and the prompt
    // must name the new model rather than the one the session was opened with.
    expect(fixture.promptModels).toEqual([otherModel]);
  });

  it("does not widen the process authority when a live session resumes with another policy", async () => {
    const fixture = driverFixture();
    const exit = await Effect.runPromise(
      Effect.scoped(
        fixture.driver.acquire({ instanceId, projectRoot: "/tmp/project" }).pipe(
          Effect.flatMap((connection) =>
            connection.start({ sessionId, modelId, executionPolicy: "plan" }).pipe(
              Effect.flatMap((handle) =>
                Effect.exit(
                  connection.resume({
                    sessionId,
                    resumeCursor: handle.resumeCursor!,
                    executionPolicy: "approval-gated",
                  }),
                ),
              ),
            ),
          ),
        ),
      ),
    );
    expect(String(exit)).toContain("unauthorized");
    expect(fixture.processInputs).toHaveLength(1);
    expect(fixture.processInputs[0]?.executionPolicy).toBe("plan");
  });

  it("starts a sandboxed Full access session's server inside the sandbox, and refuses to resume it open on the same server", async () => {
    const fixture = driverFixture();
    const exit = await Effect.runPromise(
      Effect.scoped(
        fixture.driver.acquire({ instanceId, projectRoot: "/tmp/project" }).pipe(
          Effect.flatMap((connection) =>
            connection
              .start({
                sessionId,
                modelId,
                executionPolicy: "full-access",
                fullAccessSandbox: true,
              })
              .pipe(
                Effect.flatMap((handle) =>
                  Effect.exit(
                    connection.resume({
                      sessionId,
                      resumeCursor: handle.resumeCursor!,
                      executionPolicy: "full-access",
                    }),
                  ),
                ),
              ),
          ),
        ),
      ),
    );
    expect(String(exit)).toContain("unauthorized");
    expect(fixture.processInputs).toHaveLength(1);
    expect(fixture.processInputs[0]).toMatchObject({
      executionPolicy: "full-access",
      fullAccessSandbox: true,
    });
  });

  it("proves MCP declaration support through a confined loopback probe lease", async () => {
    const fixture = driverFixture();
    const probe = await Effect.runPromise(Effect.scoped(fixture.driver.probe({ instanceId })));
    // macOS and Linux reach the bridge, and both probe the Chat and Plan
    // jail, which starts the git stand-in; elsewhere turns run only in Work
    // and Code outside Plan, so the probe attests that jail.
    expect(probe.capabilities.appManagedTools).toBe("supported");
    expect(fixture.processInputs[0]).toMatchObject(
      process.platform === "darwin" || process.platform === "linux"
        ? { mode: "chat", executionPolicy: "plan", loopbackPorts: [expect.any(Number)] }
        : { mode: "code", executionPolicy: "approval-gated", loopbackPorts: [expect.any(Number)] },
    );
    expect(fixture.calls.some((call) => call.startsWith("mcp.add:"))).toBe(true);
    expect(fixture.calls.some((call) => call.startsWith("mcp.disconnect:"))).toBe(true);
  });

  it("becomes ready on a Windows host whose new threads run unconfined, and stays unready otherwise", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "octant-opencode-windows-probe-")));
    try {
      const binaryPath = join(root, "opencode-fixture");
      writeFileSync(binaryPath, `#!/bin/sh\nexec '${fakeCliPath}' "$@"\n`);
      chmodSync(binaryPath, 0o755);
      // The production process port, told it runs on Windows; the fixture's
      // client answers the readiness routes.
      const windowsProcess = (catalogUnconfined: boolean): OpenCodeProcessPort => {
        const live = makeOpenCodeProcessLive({
          platform: "win32",
          runtimeConfigResolver: async () => undefined,
          startupTimeoutMs: 10_000,
          windowsCatalogUnconfined: () => catalogUnconfined,
        });
        return { start: (input) => live.start({ ...input, binaryPath }) };
      };
      const ready = driverFixture({ process: windowsProcess(true) });
      const probe = await Effect.runPromise(Effect.scoped(ready.driver.probe({ instanceId })));
      expect(probe.readiness).toBe("ready");
      expect(probe.models.length).toBeGreaterThan(0);

      const refused = driverFixture({ process: windowsProcess(false) });
      const unready = await Effect.runPromise(
        Effect.either(Effect.scoped(refused.driver.probe({ instanceId }))),
      );
      expect(JSON.stringify(unready)).toContain("Windows does not have yet");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);

  it("keeps app tools unsupported when the provider rejects the MCP declaration", async () => {
    const fixture = driverFixture({ mcpSupported: false });
    const probe = await Effect.runPromise(Effect.scoped(fixture.driver.probe({ instanceId })));
    expect(probe.capabilities.appManagedTools).toBe("unsupported");
  });

  it("requires app-managed tools to be registered before the process lease starts", async () => {
    const fixture = driverFixture();
    const result = await Effect.runPromise(
      Effect.scoped(
        fixture.driver.acquire({ instanceId, projectRoot: "/tmp/project" }).pipe(
          Effect.flatMap((connection) =>
            connection.start({ sessionId, modelId, executionPolicy: "approval-gated" }).pipe(
              Effect.flatMap(() =>
                Effect.exit(
                  connection.send({
                    sessionId,
                    prompt: "late tool",
                    attachments: [],
                    tools: [{ name: "octant_browser", inputSchema: { type: "object" } }],
                  }),
                ),
              ),
            ),
          ),
        ),
      ),
    );
    expect(String(result)).toContain("must be registered when the session starts");
    expect(fixture.calls.some((call) => call.startsWith("mcp.add:"))).toBe(false);
    expect(fixture.calls).not.toContain("session.promptAsync");
  });

  it("holds a live turn for recovery, not as a Stop, when its dedicated provider process exits", async () => {
    const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], {
      stdio: "ignore",
    });
    const pid = child.pid;
    if (pid === undefined) throw new Error("Expected a provider fixture process.");
    const fixture = driverFixture({
      process: {
        start: () =>
          Effect.acquireRelease(
            Effect.succeed({
              authorization: "Basic redacted",
              pid,
              url: new URL("http://127.0.0.1:1/"),
            }),
            () =>
              Effect.sync(() => {
                child.kill("SIGKILL");
              }),
          ),
      },
    });
    try {
      const events = await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const connection = yield* fixture.driver.acquire({
              instanceId,
              projectRoot: "/tmp/project",
            });
            const stream = yield* connection.subscribe;
            const collector = yield* Effect.forkScoped(
              Stream.runCollect(stream.pipe(Stream.take(1))),
            );
            yield* connection.start({ sessionId, modelId, executionPolicy: "approval-gated" });
            yield* connection.send({ sessionId, prompt: "hello", attachments: [], tools: [] });
            child.kill("SIGKILL");
            const output = yield* Fiber.join(collector).pipe(Effect.timeout("2 seconds"));
            expect(fixture.registry.activeSessionCount(instanceId)).toBe(0);
            return output;
          }),
        ),
      );
      expect(Array.from(events)).toMatchObject([
        {
          kind: "waiting",
          message:
            "The OpenCode process stopped while this turn was running. Check what it did, then resume.",
        },
      ]);
      // The prompt went out once; nothing sends it again on its own.
      expect(fixture.calls.filter((call) => call === "session.promptAsync")).toHaveLength(1);
    } finally {
      child.kill("SIGKILL");
    }
  });

  it("refuses app tools when the runtime can inherit external configuration", async () => {
    const fixture = driverFixture({ isolatedConfiguration: false });
    const probe = await Effect.runPromise(Effect.scoped(fixture.driver.probe({ instanceId })));
    expect(probe.capabilities.appManagedTools).toBe("unsupported");
    const probeCallCount = fixture.calls.length;
    const result = await Effect.runPromise(
      Effect.scoped(
        fixture.driver.acquire({ instanceId, projectRoot: "/tmp/project" }).pipe(
          Effect.flatMap((connection) =>
            Effect.exit(
              connection.start({
                sessionId,
                modelId,
                executionPolicy: "approval-gated",
                tools: [{ name: "octant_browser", inputSchema: { type: "object" } }],
              }),
            ),
          ),
        ),
      ),
    );
    expect(String(result)).toContain("unsupported");
    expect(fixture.calls.slice(probeCallCount).some((call) => call.startsWith("mcp.add:"))).toBe(
      false,
    );
  });

  it("offers a Full access thread app tools on a runtime that can inherit external configuration", async () => {
    const fixture = driverFixture({ isolatedConfiguration: false });
    const result = await Effect.runPromise(
      Effect.scoped(
        fixture.driver.acquire({ instanceId, projectRoot: "/tmp/project" }).pipe(
          Effect.flatMap((connection) =>
            connection
              .start({
                sessionId,
                modelId,
                executionPolicy: "full-access",
                tools: [{ name: "octant_browser", inputSchema: { type: "object" } }],
              })
              .pipe(
                Effect.flatMap(() =>
                  Effect.exit(
                    connection.send({
                      sessionId,
                      prompt: "use the tool",
                      attachments: [],
                      tools: [{ name: "octant_browser", inputSchema: { type: "object" } }],
                    }),
                  ),
                ),
              ),
          ),
        ),
      ),
    );
    expect(Exit.isSuccess(result)).toBe(true);
    expect(fixture.calls.some((call) => call.startsWith("mcp.add:"))).toBe(true);
    expect(fixture.calls).toContain("session.promptAsync");
  });

  it("reports app tools as mixed at Full access when the runtime accepts them without proving exclusivity", () => {
    const unproved = normalizeOpenCodeProbe(
      instanceId,
      { version: "1.18.0" },
      providerList(),
      now,
      {
        accepted: true,
        exclusive: false,
      },
    );
    expect(unproved.capabilities.appManagedTools).toBe("unsupported");
    expect(unproved.capabilities.appManagedToolsAtFullAccess).toBe("mixed");
    // Full access launches this runtime outside the sandbox the proof rests on.
    const proved = normalizeOpenCodeProbe(instanceId, { version: "1.18.0" }, providerList(), now, {
      accepted: true,
      exclusive: true,
    });
    expect(proved.capabilities.appManagedTools).toBe("supported");
    expect(proved.capabilities.appManagedToolsAtFullAccess).toBe("mixed");
    const refused = normalizeOpenCodeProbe(instanceId, { version: "1.18.0" }, providerList(), now, {
      accepted: false,
      exclusive: true,
    });
    expect(refused.capabilities.appManagedTools).toBe("unsupported");
    expect(refused.capabilities.appManagedToolsAtFullAccess).toBeUndefined();
  });

  it("reports that a model reasons without offering a variant it cannot send", () => {
    expect(
      normalizeOpenCodeProbe(instanceId, { version: "1.18.0" }, providerList(), now),
    ).toMatchObject({
      instanceId,
      readiness: "ready",
      detectedVersion: "1.18.0",
      models: [
        {
          id: "anthropic/claude-sonnet",
          displayName: "Claude Sonnet",
          source: "discovered",
          verification: "verified",
          contextLimit: 200000,
          reasoning: "supported",
          // The fixture reports low/high variants, but this driver prompts with
          // provider and model ids only. Declaring the variants would put a
          // control in the composer whose choice is saved and then ignored, so
          // the honest report is that the model reasons and nothing is
          // selectable about how.
          options: [],
        },
      ],
      capabilities: {
        streaming: "supported",
        approvals: "supported",
        fileChanges: "unsupported",
        nativeChildAgents: "unsupported",
        harnessAutoReview: "unsupported",
      },
    });
  });

  it("advertises native attachments for audio-only models", () => {
    const providers = providerList();
    const source = providers.all[0]!;
    const sourceModel = source.models["claude-sonnet"]!;
    const audioOnly = {
      ...sourceModel,
      capabilities: {
        ...sourceModel.capabilities,
        input: {
          text: true,
          audio: true,
          image: false,
          video: false,
          pdf: false,
        },
      },
    };

    const result = normalizeOpenCodeProbe(
      instanceId,
      { version: "1.18.0" },
      {
        all: [{ ...source, models: { [audioOnly.id]: audioOnly } }],
        connected: providers.connected,
      },
      now,
    );

    expect(result.models[0]?.inputModalities).toEqual(["text", "audio"]);
    expect(result.models[0]?.imageInput).toBe("unsupported");
    expect(result.capabilities.nativeAttachments).toBe("supported");
  });

  it("encodes native attachment bytes as bounded OpenCode file parts", () => {
    expect(
      openCodePromptParts("compare", [
        {
          attachmentId: "attachment-1",
          displayName: "diagram.png",
          mediaType: "image/png",
          bytes: new Uint8Array([1, 2, 3]),
        },
      ]),
    ).toEqual([
      { type: "text", text: "compare" },
      {
        type: "file",
        mime: "image/png",
        filename: "diagram.png",
        url: "data:image/png;base64,AQID",
      },
    ]);
  });

  it("subscribes before prompting, preserves current-session approval, and aborts authoritatively", async () => {
    const fixture = driverFixture({
      events: [permissionEvent("provider-session", "permission-1")],
    });
    await Effect.runPromise(
      Effect.scoped(
        fixture.driver.acquire({ instanceId, projectRoot: "/tmp/project" }).pipe(
          Effect.flatMap((connection) =>
            connection.start({ sessionId, modelId, executionPolicy: "approval-gated" }).pipe(
              Effect.tap(() =>
                connection.send({ sessionId, prompt: "hello", attachments: [], tools: [] }),
              ),
              Effect.tap(() =>
                connection.answerApproval({ sessionId, requestId: "permission-1", approved: true }),
              ),
              Effect.tap(() => connection.interrupt(sessionId)),
            ),
          ),
        ),
      ),
    );
    expect(fixture.calls).toEqual([
      "process.start",
      "event.subscribe",
      "session.create:ask",
      "session.promptAsync",
      "permission.reply:once",
      "session.abort",
    ]);
  });

  it("follows a delegated session as a child run and sends its approval through the parent", async () => {
    const fixture = driverFixture({
      events: [permissionEvent("provider-session", "gate")],
      eventsOnReply: [
        {
          type: "session.created",
          properties: {
            sessionID: "child-session",
            info: { id: "child-session", parentID: "provider-session", title: "Read the logs" },
          },
        } as unknown as Event,
        textEvent("child-session", "the child's own words"),
        permissionEvent("child-session", "child-gate"),
      ],
    });
    const seen = await Effect.runPromise(
      Effect.scoped(
        fixture.driver.acquire({ instanceId, projectRoot: "/tmp/project" }).pipe(
          Effect.flatMap((connection) =>
            Effect.gen(function* () {
              const stream = yield* connection.subscribe;
              const collector = yield* Effect.fork(
                Stream.runCollect(
                  stream.pipe(
                    Stream.takeUntil(
                      (event) =>
                        event.kind === "approval-request" && event.requestId === "child-gate",
                    ),
                  ),
                ),
              );
              yield* connection.start({ sessionId, modelId, executionPolicy: "approval-gated" });
              yield* connection.send({ sessionId, prompt: "go", attachments: [], tools: [] });
              yield* connection.answerApproval({ sessionId, requestId: "gate", approved: true });
              const events = Array.from(yield* Fiber.join(collector));
              yield* connection.answerApproval({
                sessionId,
                requestId: "child-gate",
                approved: true,
              });
              return events;
            }),
          ),
        ),
      ),
    );
    expect(seen.map((event) => event.kind)).not.toContain("text-delta");
    expect(seen).toContainEqual(
      expect.objectContaining({
        kind: "child-agent-activity",
        childAgentId: "child-session",
        task: "Read the logs",
        status: "starting",
      }),
    );
    expect(fixture.permissionReplies).toEqual([
      "provider-session:gate",
      "child-session:child-gate",
    ]);
  });

  it("names the turn's last assistant message as where it ends in OpenCode's session, not a delegated session's", async () => {
    const message = (id: string, role: "user" | "assistant", session: string) =>
      ({
        type: "message.updated",
        properties: { sessionID: session, info: { id, role, sessionID: session } },
      }) as unknown as Event;
    const fixture = driverFixture({
      events: [
        message("msg_1", "user", "provider-session"),
        message("msg_2", "assistant", "provider-session"),
        message("msg_9", "assistant", "child-session"),
        idleEvent("provider-session"),
      ],
    });
    const output = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const connection = yield* fixture.driver.acquire({
            instanceId,
            projectRoot: "/tmp/project",
          });
          const stream = yield* connection.subscribe;
          const collector = yield* Effect.fork(
            Stream.runCollect(
              stream.pipe(
                Stream.filter((event) => event.sessionId === sessionId),
                Stream.takeUntil((event) => event.kind === "completed"),
              ),
            ),
          );
          yield* connection.start({ sessionId, modelId, executionPolicy: "approval-gated" });
          yield* connection.send({ sessionId, prompt: "hello", attachments: [], tools: [] });
          return yield* Fiber.join(collector);
        }),
      ),
    );
    expect(Array.from(output).at(-1)).toMatchObject({ kind: "completed", nativeAnchor: "msg_2" });
  });

  it("reports cumulative usage across every model step in one prompt", async () => {
    const fixture = driverFixture({
      events: [
        stepEndedEvent("provider-session", "message-1", {
          input: 12,
          output: 7,
          reasoning: 3,
          cache: { read: 2, write: 1 },
          cost: 0.25,
        }),
        stepEndedEvent("provider-session", "message-2", {
          input: 30,
          output: 11,
          reasoning: 5,
          cache: { read: 4, write: 2 },
          cost: 0.5,
        }),
        idleEvent("provider-session"),
      ],
    });
    const output = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const connection = yield* fixture.driver.acquire({
            instanceId,
            projectRoot: "/tmp/project",
          });
          const stream = yield* connection.subscribe;
          const collector = yield* Effect.fork(
            Stream.runCollect(
              stream.pipe(
                Stream.filter((event) => event.sessionId === sessionId),
                Stream.takeUntil((event) => event.kind === "completed"),
              ),
            ),
          );
          yield* connection.start({ sessionId, modelId, executionPolicy: "approval-gated" });
          yield* connection.send({ sessionId, prompt: "hello", attachments: [], tools: [] });
          return yield* Fiber.join(collector);
        }),
      ),
    );

    expect(
      Array.from(output).filter(
        (event): event is Extract<ProviderRuntimeEvent, { kind: "usage" }> =>
          event.kind === "usage",
      ),
    ).toMatchObject([
      {
        inputTokens: 15,
        outputTokens: 7,
        reasoningTokens: 3,
        cacheReadInputTokens: 2,
        cacheWriteInputTokens: 1,
        costUsd: 0.25,
      },
      {
        inputTokens: 51,
        outputTokens: 18,
        reasoningTokens: 8,
        cacheReadInputTokens: 6,
        cacheWriteInputTokens: 3,
        costUsd: 0.75,
      },
    ]);
  });

  it("reports one compaction however OpenCode names it, and leaves each usage report saying prompts are kept", async () => {
    const tokens = { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 }, cost: 0 };
    const fixture = driverFixture({
      events: [
        stepEndedEvent("provider-session", "message-1", tokens),
        { type: "session.compacted", properties: { sessionID: "provider-session" } } as Event,
        {
          type: "session.next.compaction.ended",
          properties: { sessionID: "provider-session" },
        } as Event,
        stepEndedEvent("provider-session", "message-2", tokens),
        { type: "session.compacted", properties: { sessionID: "provider-session" } } as Event,
        stepEndedEvent("provider-session", "message-3", tokens),
        idleEvent("provider-session"),
      ],
    });
    const output = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const connection = yield* fixture.driver.acquire({
            instanceId,
            projectRoot: "/tmp/project",
          });
          const stream = yield* connection.subscribe;
          const collector = yield* Effect.fork(
            Stream.runCollect(
              stream.pipe(
                Stream.filter((event) => event.sessionId === sessionId),
                Stream.takeUntil((event) => event.kind === "completed"),
              ),
            ),
          );
          yield* connection.start({ sessionId, modelId, executionPolicy: "approval-gated" });
          yield* connection.send({ sessionId, prompt: "hello", attachments: [], tools: [] });
          return yield* Fiber.join(collector);
        }),
      ),
    );

    expect(
      Array.from(output).flatMap((event) =>
        event.kind === "usage"
          ? [`usage ${event.promptRetention}`]
          : event.kind === "context-compacted"
            ? [`compacted ${event.trigger}`]
            : [],
      ),
    ).toEqual([
      "usage kept",
      "compacted automatic",
      "usage kept",
      "compacted automatic",
      "usage kept",
    ]);
  });

  it("rejects a second start for the same session", async () => {
    const fixture = driverFixture();
    const exit = await Effect.runPromise(
      Effect.scoped(
        fixture.driver
          .acquire({ instanceId, projectRoot: "/tmp/project" })
          .pipe(
            Effect.flatMap((connection) =>
              connection
                .start({ sessionId, modelId, executionPolicy: "approval-gated" })
                .pipe(
                  Effect.flatMap(() =>
                    Effect.exit(
                      connection.start({ sessionId, modelId, executionPolicy: "approval-gated" }),
                    ),
                  ),
                ),
            ),
          ),
      ),
    );
    expect(String(exit)).toContain("Provider session is already active");
    expect(fixture.calls.filter((call) => call === "session.create:ask")).toHaveLength(1);
  });

  it("rejects a provider session that starts in another Project root", async () => {
    const fixture = driverFixture({ sessionDirectory: "/tmp/other" });
    const exit = await Effect.runPromise(
      Effect.scoped(
        fixture.driver
          .acquire({ instanceId, projectRoot: "/tmp/project" })
          .pipe(
            Effect.flatMap((connection) =>
              Effect.exit(
                connection.start({ sessionId, modelId, executionPolicy: "approval-gated" }),
              ),
            ),
          ),
      ),
    );
    expect(String(exit)).toContain("Provider session belongs to a different Project root");
    expect(fixture.calls).toContain("session.abort");
  });

  it.each(["complete", "interrupt"] as const)(
    "keeps question answers distinct when a set must %s",
    async (outcome) => {
      const fixture = driverFixture({
        events: [
          questionV2Event("provider-session", "question-set", [
            {
              question: "How should I proceed?",
              options: [{ label: "Dequeue, push, re-queue" }, { label: "Let it merge" }],
            },
            {
              question: "Mark the threads resolved?",
              options: [{ label: "Resolve" }, { label: "Leave open" }],
            },
          ]),
        ],
      });
      const questions: Array<Extract<ProviderRuntimeEvent, { kind: "user-input-request" }>> = [];
      await Effect.runPromise(
        Effect.scoped(
          fixture.driver.acquire({ instanceId, projectRoot: "/tmp/project" }).pipe(
            Effect.flatMap((connection) =>
              Effect.gen(function* () {
                const subscriber = yield* Effect.fork(
                  (yield* connection.subscribe).pipe(
                    Stream.filter(
                      (event) =>
                        event.sessionId === sessionId && event.kind === "user-input-request",
                    ),
                    Stream.runForEach((event) =>
                      Effect.sync(() => {
                        if (event.kind === "user-input-request") questions.push(event);
                      }),
                    ),
                  ),
                );
                yield* connection.start({
                  sessionId,
                  modelId,
                  executionPolicy: "approval-gated",
                });
                yield* connection.send({ sessionId, prompt: "hello", attachments: [], tools: [] });
                yield* Effect.promise(
                  () =>
                    new Promise<void>((resolve, reject) => {
                      const started = Date.now();
                      const poll = () => {
                        if (questions.length === 2) {
                          resolve();
                          return;
                        }
                        if (Date.now() - started > 5_000) {
                          reject(new Error("Timed out waiting for the question set."));
                          return;
                        }
                        setTimeout(poll, 10);
                      };
                      poll();
                    }),
                );
                const first = questions[0];
                const second = questions[1];
                if (first === undefined || second === undefined)
                  throw new Error("Missing questions");
                expect(first.requestId).not.toBe(second.requestId);
                expect(second.sequence).toBe(first.sequence + 1);
                // Answers can arrive from different surfaces in either order.
                yield* connection.answerUserInput({
                  sessionId,
                  requestId: second.requestId,
                  answer: "Resolve",
                });
                expect(fixture.calls.filter((call) => call.startsWith("question.reply:"))).toEqual(
                  [],
                );
                const duplicate = yield* Effect.exit(
                  connection.answerUserInput({
                    sessionId,
                    requestId: second.requestId,
                    answer: "Leave open",
                  }),
                );
                expect(duplicate._tag).toBe("Failure");
                if (outcome === "interrupt") {
                  yield* connection.interrupt(sessionId);
                  const late = yield* Effect.exit(
                    connection.answerUserInput({
                      sessionId,
                      requestId: first.requestId,
                      answer: "Late",
                    }),
                  );
                  expect(late._tag).toBe("Failure");
                  yield* Fiber.interrupt(subscriber);
                  return;
                }
                yield* connection.answerUserInput({
                  sessionId,
                  requestId: first.requestId,
                  answer: "Dequeue, push, re-queue",
                });
                yield* Fiber.interrupt(subscriber);
              }),
            ),
          ),
        ),
      );
      expect(fixture.calls.filter((call) => call.startsWith("question.reply:"))).toEqual(
        outcome === "complete" ? ["question.reply:Dequeue, push, re-queue|Resolve"] : [],
      );
    },
  );

  it("gives each subscriber the same terminal stream and rejects sends after completion", async () => {
    const fixture = driverFixture({
      events: [
        textEvent("provider-session", "hello"),
        permissionEvent("provider-session", "late-approval"),
        idleEvent("provider-session"),
      ],
    });
    const result = await Effect.runPromise(
      Effect.scoped(
        fixture.driver.acquire({ instanceId, projectRoot: "/tmp/project" }).pipe(
          Effect.flatMap((connection) =>
            Effect.gen(function* () {
              const first = yield* connection.subscribe;
              const second = yield* connection.subscribe;
              const collectors = yield* Effect.all(
                [
                  Effect.fork(
                    Stream.runCollect(
                      first.pipe(
                        Stream.takeUntil((event) =>
                          ["completed", "failed", "interrupted"].includes(event.kind),
                        ),
                      ),
                    ),
                  ),
                  Effect.fork(
                    Stream.runCollect(
                      second.pipe(
                        Stream.takeUntil((event) =>
                          ["completed", "failed", "interrupted"].includes(event.kind),
                        ),
                      ),
                    ),
                  ),
                ],
                { concurrency: 2 },
              );
              yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 0)));
              yield* connection.start({
                sessionId,
                modelId,
                executionPolicy: "approval-gated",
              });
              const streams = yield* Effect.all(
                collectors.map((collector) => Fiber.join(collector)),
                { concurrency: 2 },
              );
              const send = yield* Effect.exit(
                connection.send({ sessionId, prompt: "late", attachments: [], tools: [] }),
              );
              const approval = yield* Effect.exit(
                connection.answerApproval({
                  sessionId,
                  requestId: "late-approval",
                  approved: true,
                }),
              );
              return { streams, send, approval };
            }),
          ),
        ),
      ),
    );
    expect(Array.from(result.streams[0] ?? [])).toEqual(Array.from(result.streams[1] ?? []));
    expect(String(result.send)).toContain("Provider session is already terminal");
    expect(String(result.approval)).toContain("Provider session is already terminal");
  });

  it("retires the old managed-tool bridge before resuming its session", async () => {
    const fixture = driverFixture();
    const tool = { name: "octant_browser", inputSchema: { type: "object" } } as const;
    const resumed = await Effect.runPromise(
      Effect.scoped(
        fixture.driver.acquire({ instanceId, projectRoot: "/tmp/project" }).pipe(
          Effect.flatMap((connection) =>
            connection
              .start({
                sessionId,
                modelId,
                executionPolicy: "approval-gated",
                tools: [tool],
              })
              .pipe(
                Effect.flatMap((handle) =>
                  connection.resume({
                    sessionId,
                    resumeCursor: handle.resumeCursor!,
                    executionPolicy: "approval-gated",
                  }),
                ),
              ),
          ),
        ),
      ),
    );
    expect(resumed.sessionId).toBe(sessionId);
    expect(fixture.calls.some((call) => call.startsWith("mcp.disconnect:"))).toBe(true);
  });

  it.each([
    ["full-access", "edit", "allow"],
    ["full-access", "bash", "allow"],
    ["full-access", "task", "allow"],
    ["full-access", "todowrite", "allow"],
    ["full-access", "external_directory", "allow"],
    ["approval-gated", "edit", "ask"],
    ["approval-gated", "bash", "ask"],
    ["approval-gated", "task", "allow"],
    ["auto-accept-edits", "task", "allow"],
    ["approval-gated", "todowrite", "ask"],
    ["approval-gated", "external_directory", "ask"],
    ["plan", "read", "allow"],
    ["approval-gated", "read", "allow"],
    ["approval-gated", "glob", "allow"],
    ["plan", "grep", "allow"],
    ["plan", "edit", "deny"],
    ["plan", "bash", "deny"],
    ["plan", "task", "deny"],
    ["plan", "external_directory", "deny"],
    ["plan", "todowrite", "allow"],
    ["plan", "todoread", "allow"],
    ["plan", "codesearch", "allow"],
    ["plan", "lsp", "allow"],
    ["plan", "list", "allow"],
    ["plan", "webfetch", "deny"],
    ["plan", "websearch", "deny"],
  ] as const)(
    "maps %s %s through official last-match permission semantics",
    async (policy, permission, action) => {
      const fixture = driverFixture();
      await Effect.runPromise(
        Effect.scoped(
          fixture.driver
            .acquire({ instanceId, projectRoot: "/tmp/project" })
            .pipe(
              Effect.flatMap((connection) =>
                connection.start({ sessionId, modelId, executionPolicy: policy }),
              ),
            ),
        ),
      );
      expect(evaluatePermission(fixture.createdPermissions[0]!, permission)).toBe(action);
    },
  );

  it.each(["approval-gated", "auto-accept-edits", "full-access"] as const)(
    "gives a Work session at %s the shell and task rules a Code session at that level gets",
    async (executionPolicy) => {
      const rulesFor = async (mode: "work" | "code") => {
        const fixture = driverFixture();
        await Effect.runPromise(
          Effect.scoped(
            fixture.driver
              .acquire({ instanceId, projectRoot: "/tmp/project", mode })
              .pipe(
                Effect.flatMap((connection) =>
                  connection.start({ sessionId, modelId, executionPolicy }),
                ),
              ),
          ),
        );
        return fixture.createdPermissions[0]!;
      };
      const work = await rulesFor("work");
      expect(work).toEqual(await rulesFor("code"));
      const shell = executionPolicy === "full-access" ? "allow" : "ask";
      expect(evaluatePermission(work, "bash")).toBe(shell);
      // OpenCode's subagents start unasked at every level outside Plan.
      expect(evaluatePermission(work, "task")).toBe("allow");
      expect(evaluatePermission(work, "external_directory")).toBe(
        executionPolicy === "full-access" ? "allow" : "ask",
      );
    },
  );

  it("isolates MCP tools to the session-owned bridge", async () => {
    const fixture = driverFixture();
    await Effect.runPromise(
      Effect.scoped(
        fixture.driver.acquire({ instanceId, projectRoot: "/tmp/project" }).pipe(
          Effect.flatMap((connection) =>
            connection.start({
              sessionId,
              modelId,
              executionPolicy: "approval-gated",
              tools: [{ name: "octant_browser", inputSchema: { type: "object" } }],
            }),
          ),
        ),
      ),
    );
    expect(fixture.processInputs[0]?.loopbackPorts).toHaveLength(1);
    const rules = fixture.createdPermissions[0];
    if (rules === undefined) throw new Error("Expected managed-tool permissions.");
    const allowRule = rules.find(
      (rule) =>
        rule.permission.startsWith("octant-") &&
        rule.permission.endsWith("_*") &&
        rule.action === "allow",
    );
    if (allowRule === undefined) throw new Error("Expected a session bridge allow rule.");
    const ownPrefix = allowRule.permission.slice(0, -2);
    expect(evaluatePermission(rules, `${ownPrefix}_octant_browser`)).toBe("allow");
    expect(evaluatePermission(rules, "octant-other_octant_browser")).toBe("deny");
  });

  it("rejects every plan-mode approval answer server-side", async () => {
    const fixture = driverFixture({
      events: [permissionEvent("provider-session", "future-write")],
    });
    const exit = await Effect.runPromise(
      Effect.scoped(
        fixture.driver.acquire({ instanceId, projectRoot: "/tmp/project" }).pipe(
          Effect.flatMap((connection) =>
            connection.start({ sessionId, modelId, executionPolicy: "plan" }).pipe(
              Effect.flatMap(() =>
                Effect.exit(
                  connection.answerApproval({
                    sessionId,
                    requestId: "future-write",
                    approved: true,
                  }),
                ),
              ),
            ),
          ),
        ),
      ),
    );
    expect(String(exit)).toContain("unauthorized");
    expect(fixture.calls.some((call) => call.startsWith("permission.reply"))).toBe(false);
  });

  it("preserves plan authority across a fresh-connection resume", async () => {
    const fixture = driverFixture({
      events: [permissionEvent("provider-session", "restart-write")],
    });
    let resumeCursor: ProviderResumeCursor | undefined;
    await Effect.runPromise(
      Effect.scoped(
        fixture.driver.acquire({ instanceId, projectRoot: "/tmp/project" }).pipe(
          Effect.flatMap((connection) =>
            connection.start({ sessionId, modelId, executionPolicy: "plan" }),
          ),
          Effect.tap((handle) =>
            Effect.sync(() => {
              resumeCursor = handle.resumeCursor;
            }),
          ),
        ),
      ),
    );
    for (const permission of ["edit", "bash", "task", "external_directory"]) {
      expect(evaluatePermission(fixture.createdPermissions[0]!, permission)).toBe("deny");
    }

    const exit = await Effect.runPromise(
      Effect.scoped(
        fixture.driver.acquire({ instanceId, projectRoot: "/tmp/project" }).pipe(
          Effect.flatMap((connection) =>
            connection
              .resume({ sessionId, resumeCursor: resumeCursor!, executionPolicy: "plan" })
              .pipe(
                Effect.flatMap(() =>
                  Effect.exit(
                    connection.answerApproval({
                      sessionId,
                      requestId: "restart-write",
                      approved: true,
                    }),
                  ),
                ),
              ),
          ),
        ),
      ),
    );
    expect(String(exit)).toContain("unauthorized");
    expect(fixture.calls.some((call) => call.startsWith("permission.reply"))).toBe(false);
  });

  it("answers a one-call approval once, even when the person remembers approvals for the Project", async () => {
    const fixture = driverFixture({
      permissionPersistence: "project-default",
      events: [permissionEvent("provider-session", "one")],
    });
    await Effect.runPromise(
      Effect.scoped(
        fixture.driver.acquire({ instanceId, projectRoot: "/tmp/project" }).pipe(
          Effect.flatMap((connection) =>
            connection.start({ sessionId, modelId, executionPolicy: "approval-gated" }).pipe(
              Effect.tap(() =>
                connection.answerApproval({
                  sessionId,
                  requestId: "one",
                  approved: true,
                  scope: "once",
                }),
              ),
            ),
          ),
        ),
      ),
    );
    expect(fixture.calls).toContain("permission.reply:once");
    expect(fixture.calls).not.toContain("permission.reply:always");
  });

  it("maps remembered approval to always and denial to reject", async () => {
    const fixture = driverFixture({
      permissionPersistence: "project-default",
      events: [
        permissionEvent("provider-session", "one"),
        permissionEvent("provider-session", "two"),
      ],
    });
    await Effect.runPromise(
      Effect.scoped(
        fixture.driver.acquire({ instanceId, projectRoot: "/tmp/project" }).pipe(
          Effect.flatMap((connection) =>
            connection.start({ sessionId, modelId, executionPolicy: "approval-gated" }).pipe(
              Effect.tap(() =>
                connection.answerApproval({ sessionId, requestId: "one", approved: true }),
              ),
              Effect.tap(() =>
                connection.answerApproval({ sessionId, requestId: "two", approved: false }),
              ),
            ),
          ),
        ),
      ),
    );
    expect(fixture.calls).toContain("permission.reply:always");
    expect(fixture.calls).toContain("permission.reply:reject");
  });

  it("reads permission persistence dynamically for each approval answer", async () => {
    let persistence: "current-session" | "project-default" = "current-session";
    const fixture = driverFixture({
      permissionPersistence: () => persistence,
      events: [
        permissionEvent("provider-session", "one"),
        permissionEvent("provider-session", "two"),
      ],
    });
    await Effect.runPromise(
      Effect.scoped(
        fixture.driver.acquire({ instanceId, projectRoot: "/tmp/project" }).pipe(
          Effect.flatMap((connection) =>
            connection.start({ sessionId, modelId, executionPolicy: "approval-gated" }).pipe(
              Effect.tap(() =>
                connection.answerApproval({ sessionId, requestId: "one", approved: true }),
              ),
              Effect.tap(() =>
                Effect.sync(() => {
                  persistence = "project-default";
                }),
              ),
              Effect.tap(() =>
                connection.answerApproval({ sessionId, requestId: "two", approved: true }),
              ),
            ),
          ),
        ),
      ),
    );
    expect(fixture.calls.filter((call) => call.startsWith("permission.reply"))).toEqual([
      "permission.reply:once",
      "permission.reply:always",
    ]);
  });

  it("registers current app tools when recovering a native session in a fresh driver", async () => {
    const fixture = driverFixture();
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const connection = yield* fixture.driver.acquire({
            instanceId,
            projectRoot: "/tmp/project",
          });
          yield* connection.resume({
            sessionId,
            modelId,
            resumeCursor: { driverKind: "opencode", value: "provider-session" },
            executionPolicy: "approval-gated",
            tools: [{ name: "octant_browser", inputSchema: { type: "object" } }],
          });
          yield* connection.send({
            sessionId,
            prompt: "Use the browser",
            attachments: [],
            tools: [{ name: "octant_browser", inputSchema: { type: "object" } }],
          });
        }),
      ),
    );
    expect(fixture.calls.some((call) => call.startsWith("mcp.add:"))).toBe(true);
    expect(fixture.calls.some((call) => call.startsWith("session.create:"))).toBe(false);
    expect(fixture.calls).toContain("session.promptAsync");
    // The legacy session record names no model; the prompt runs on the thread's.
    expect(fixture.promptModels).toEqual([modelId]);
  });

  it("refuses to resume a session it cannot name a model for", async () => {
    const fixture = driverFixture();
    const exit = await Effect.runPromise(
      Effect.scoped(
        fixture.driver.acquire({ instanceId, projectRoot: "/tmp/project" }).pipe(
          Effect.flatMap((connection) =>
            Effect.exit(
              connection.resume({
                sessionId,
                resumeCursor: { driverKind: "opencode", value: "provider-session" },
                executionPolicy: "approval-gated",
              }),
            ),
          ),
        ),
      ),
    );
    expect(String(exit)).toContain("stale-resume");
    expect(fixture.calls).not.toContain("session.promptAsync");
  });

  it("records the session's task, folder, and mode at start and refuses a resume that names others of those", async () => {
    const fixture = driverFixture();
    const binding = {
      instanceId,
      sessionId,
      projectRoot: "/tmp/project",
      mode: "work" as const,
      modelId,
    };
    const started = await Effect.runPromise(
      Effect.scoped(
        fixture.driver
          .acquire({ instanceId, projectRoot: "/tmp/project", mode: "work" })
          .pipe(
            Effect.flatMap((connection) =>
              connection.start({ sessionId, modelId, executionPolicy: "approval-gated" }),
            ),
          ),
      ),
    );
    expect(started.resumeCursor).toEqual({
      driverKind: "opencode",
      value: "provider-session",
      binding,
    });
    for (const mismatch of [
      { sessionId: decodeProviderSessionId("90000000-0000-4000-8000-0000000000aa") },
      { projectRoot: "/tmp/other" },
      { mode: "code" as const },
    ]) {
      const exit = await Effect.runPromise(
        Effect.scoped(
          fixture.driver.acquire({ instanceId, projectRoot: "/tmp/project", mode: "work" }).pipe(
            Effect.flatMap((connection) =>
              Effect.exit(
                connection.resume({
                  sessionId,
                  modelId,
                  resumeCursor: {
                    driverKind: "opencode",
                    value: "provider-session",
                    binding: { ...binding, ...mismatch },
                  },
                  executionPolicy: "approval-gated",
                }),
              ),
            ),
          ),
        ),
      );
      expect(String(exit)).toContain("stale-resume");
    }
    expect(fixture.calls.filter((call) => call.startsWith("mcp.add:"))).toEqual([]);
  });

  it("refuses a replacement native identity returned during resume", async () => {
    const fixture = driverFixture({ resumedSessionId: "different-session" });
    const exit = await Effect.runPromise(
      Effect.scoped(
        Effect.exit(
          fixture.driver.acquire({ instanceId, projectRoot: "/tmp/project" }).pipe(
            Effect.flatMap((connection) =>
              connection.resume({
                sessionId,
                resumeCursor: { driverKind: "opencode", value: "provider-session" },
                executionPolicy: "approval-gated",
                tools: [{ name: "octant_browser", inputSchema: { type: "object" } }],
              }),
            ),
          ),
        ),
      ),
    );
    expect(exit._tag).toBe("Failure");
    expect(String(exit)).toContain("stale-resume");
    expect(fixture.calls).not.toContain("session.promptAsync");
    expect(fixture.calls.some((call) => call.startsWith("mcp.disconnect:"))).toBe(true);
    expect(fixture.calls).not.toContain("session.abort");
  });

  it("rejects resume when the source session belongs to another project root", async () => {
    const fixture = driverFixture({ sessionDirectory: "/tmp/other" });
    const exit = await Effect.runPromise(
      Effect.scoped(
        fixture.driver.acquire({ instanceId, projectRoot: "/tmp/project" }).pipe(
          Effect.flatMap((connection) =>
            Effect.exit(
              connection.resume({
                sessionId,
                resumeCursor: { driverKind: "opencode", value: "provider-session" },
                executionPolicy: "approval-gated",
              }),
            ),
          ),
        ),
      ),
    );
    expect(exit).toMatchObject({ _tag: "Failure" });
    expect(String(exit)).toContain("stale-resume");
  });

  it("rejects an unnormalized Project root before starting a managed runtime", async () => {
    const fixture = driverFixture();
    const exit = await Effect.runPromise(
      Effect.scoped(
        Effect.exit(fixture.driver.acquire({ instanceId, projectRoot: "relative/project" })),
      ),
    );
    expect(exit).toMatchObject({ _tag: "Failure" });
    expect(String(exit)).toContain("invalid-configuration");
    expect(fixture.calls).toEqual([]);
  });

  it("preserves typed managed-process startup failures", async () => {
    const fixture = driverFixture({
      processFailure: {
        category: "invalid-configuration",
        message: "OpenCode binary path must be absolute.",
      },
    });
    const exit = await Effect.runPromise(
      Effect.scoped(
        fixture.driver.acquire({ instanceId, projectRoot: "/tmp/project" }).pipe(
          Effect.flatMap((connection) =>
            Effect.exit(
              connection.start({
                sessionId,
                modelId,
                executionPolicy: "approval-gated",
              }),
            ),
          ),
        ),
      ),
    );
    expect(String(exit)).toContain("invalid-configuration");
  });

  it("delivers assistant message parts once and never echoes user parts", async () => {
    const events: Event[] = [
      {
        id: "role-user",
        type: "message.updated",
        properties: {
          sessionID: "provider-session",
          info: { id: "user-message", sessionID: "provider-session", role: "user" },
        },
      } as Event,
      {
        id: "user-part",
        type: "message.part.updated",
        properties: {
          sessionID: "provider-session",
          time: 1,
          part: {
            id: "user-part",
            sessionID: "provider-session",
            messageID: "user-message",
            type: "text",
            text: "User prompt",
          },
        },
      },
      {
        id: "role-assistant",
        type: "message.updated",
        properties: {
          sessionID: "provider-session",
          info: { id: "answer", sessionID: "provider-session", role: "assistant" },
        },
      } as Event,
      {
        id: "part-start",
        type: "message.part.updated",
        properties: {
          sessionID: "provider-session",
          time: 2,
          part: {
            id: "text",
            sessionID: "provider-session",
            messageID: "answer",
            type: "text",
            text: "Hello",
          },
        },
      },
      {
        id: "part-delta",
        type: "message.part.delta",
        properties: {
          sessionID: "provider-session",
          messageID: "answer",
          partID: "text",
          field: "text",
          delta: " there",
        },
      },
      {
        id: "part-end",
        type: "message.part.updated",
        properties: {
          sessionID: "provider-session",
          time: 3,
          part: {
            id: "text",
            sessionID: "provider-session",
            messageID: "answer",
            type: "text",
            text: "Hello there",
          },
        },
      },
      idleEvent("provider-session"),
    ];
    const fixture = driverFixture({ events });
    const output = await Effect.runPromise(
      Effect.scoped(
        fixture.driver.acquire({ instanceId, projectRoot: "/tmp/project" }).pipe(
          Effect.flatMap((connection) =>
            Effect.gen(function* () {
              const stream = yield* connection.subscribe;
              const collector = yield* Effect.fork(
                Stream.runCollect(
                  stream.pipe(
                    Stream.takeUntil((event) =>
                      ["completed", "failed", "interrupted"].includes(event.kind),
                    ),
                  ),
                ),
              );
              yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 0)));
              yield* connection.start({ sessionId, modelId, executionPolicy: "approval-gated" });
              return yield* Fiber.join(collector);
            }),
          ),
        ),
      ),
    );
    expect(
      Array.from(output)
        .flatMap((event) => (event.kind === "text-delta" ? [event.text] : []))
        .join(""),
    ).toBe("Hello there");
  });

  it("routes only matching source sessions, suppresses duplicate terminals, and keeps todo IDs stable", async () => {
    const events = [
      textEvent("other", "ignored"),
      { type: "file.edited", properties: { file: "global.txt" } } as unknown as Event,
      textEvent("provider-session", "hello"),
      todoEvent("provider-session", ["build", "test"]),
      todoEvent("provider-session", ["test", "build"]),
      idleEvent("provider-session"),
      idleEvent("provider-session"),
    ];
    const fixture = driverFixture({ events });
    const output = await Effect.runPromise(
      Effect.scoped(
        fixture.driver.acquire({ instanceId, projectRoot: "/tmp/project" }).pipe(
          Effect.flatMap((connection) =>
            Effect.gen(function* () {
              const stream = yield* connection.subscribe;
              const collector = yield* Effect.fork(
                Stream.runCollect(
                  stream.pipe(
                    Stream.takeUntil((event) =>
                      ["completed", "failed", "interrupted"].includes(event.kind),
                    ),
                  ),
                ),
              );
              yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 0)));
              yield* connection.start({ sessionId, modelId, executionPolicy: "approval-gated" });
              return yield* Fiber.join(collector);
            }),
          ),
        ),
      ),
    );
    const values = Array.from(output);
    expect(values.filter(({ kind }) => kind === "completed")).toHaveLength(1);
    expect(values.some(({ kind }) => kind === "file-change")).toBe(false);
    expect(values.filter(({ kind }) => kind === "text-delta")).toMatchObject([{ text: "hello" }]);
    const tasks = values.filter(
      (event): event is Extract<(typeof values)[number], { kind: "task-progress" }> =>
        event.kind === "task-progress",
    );
    expect(tasks.map((event) => event.taskId)).toEqual(["task-1", "task-2", "task-2", "task-1"]);
    // Each restated list names the same stable ids, in OpenCode's order.
    expect(values.flatMap((event) => (event.kind === "task-list" ? [event.taskIds] : []))).toEqual([
      ["task-1", "task-2"],
      ["task-2", "task-1"],
    ]);
  });

  it("counts active sessions exactly once and releases them on terminal/finalization", async () => {
    const terminal = driverFixture({
      events: [idleEvent("provider-session"), idleEvent("provider-session")],
    });
    await Effect.runPromise(
      Effect.scoped(
        terminal.driver
          .acquire({ instanceId, projectRoot: "/tmp/project" })
          .pipe(
            Effect.flatMap((connection) =>
              connection
                .start({ sessionId, modelId, executionPolicy: "approval-gated" })
                .pipe(
                  Effect.tap(() =>
                    Effect.sync(() =>
                      expect(terminal.registry.activeSessionCount(instanceId)).toBe(0),
                    ),
                  ),
                ),
            ),
          ),
      ),
    );
    expect(terminal.registry.activeSessionCount(instanceId)).toBe(0);

    const resumed = driverFixture();
    await Effect.runPromise(
      Effect.scoped(
        resumed.driver.acquire({ instanceId, projectRoot: "/tmp/project" }).pipe(
          Effect.flatMap((connection) =>
            connection.start({ sessionId, modelId, executionPolicy: "approval-gated" }).pipe(
              Effect.tap(() =>
                Effect.sync(() => expect(resumed.registry.activeSessionCount(instanceId)).toBe(1)),
              ),
              Effect.flatMap((handle) =>
                connection.resume({
                  sessionId,
                  resumeCursor: handle.resumeCursor!,
                  executionPolicy: "approval-gated",
                }),
              ),
              Effect.tap(() =>
                Effect.sync(() => expect(resumed.registry.activeSessionCount(instanceId)).toBe(1)),
              ),
              Effect.tap(() => connection.stop(sessionId)),
              Effect.tap(() =>
                Effect.sync(() => expect(resumed.registry.activeSessionCount(instanceId)).toBe(0)),
              ),
            ),
          ),
        ),
      ),
    );

    const finalized = driverFixture();
    await Effect.runPromise(
      Effect.scoped(
        finalized.driver
          .acquire({ instanceId, projectRoot: "/tmp/project" })
          .pipe(
            Effect.flatMap((connection) =>
              connection
                .start({ sessionId, modelId, executionPolicy: "approval-gated" })
                .pipe(
                  Effect.tap(() =>
                    Effect.sync(() =>
                      expect(finalized.registry.activeSessionCount(instanceId)).toBe(1),
                    ),
                  ),
                ),
            ),
          ),
      ),
    );
    expect(finalized.registry.activeSessionCount(instanceId)).toBe(0);
  });

  it.each(["eof", "throw"] as const)(
    "fails closed after an unexpected event-stream %s",
    async (streamEnd) => {
      const fixture = driverFixture({ streamEnd });
      const result = await Effect.runPromise(
        Effect.scoped(
          fixture.driver.acquire({ instanceId, projectRoot: "/tmp/project" }).pipe(
            Effect.flatMap((connection) =>
              Effect.gen(function* () {
                const stream = yield* connection.subscribe;
                const collector = yield* Effect.fork(
                  Stream.runCollect(
                    stream.pipe(
                      Stream.takeUntil((event) =>
                        ["completed", "failed", "interrupted"].includes(event.kind),
                      ),
                    ),
                  ),
                );
                yield* connection.start({ sessionId, modelId, executionPolicy: "approval-gated" });
                yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 0)));
                const exit = yield* Effect.exit(
                  connection.send({ sessionId, prompt: "no", attachments: [], tools: [] }),
                );
                const collected = yield* Fiber.join(collector);
                return { exit, collected };
              }),
            ),
          ),
        ),
      );
      expect(String(result.exit)).toContain("protocol");
      expect(Array.from(result.collected)).toMatchObject([
        { kind: "failed", failure: { category: "protocol" } },
      ]);
      expect(JSON.stringify(result)).not.toContain("private stream detail");
      expect(fixture.calls).not.toContain("session.promptAsync");
    },
  );

  it("reports 2.x resume, interruption, tool activity, approvals, and questions from the first release read for its question forms", async () => {
    const fixture = driverFixture({
      healthVersion: "opencode v2.0.22",
      process: {
        start: () =>
          Effect.acquireRelease(
            Effect.succeed({
              authorization: "Basic redacted",
              pid: process.pid,
              runtime: "beta" as const,
              version: "opencode v2.0.22",
              temporaryDirectory: launchScratchDirectory(),
              url: new URL("http://127.0.0.1:1/"),
            }),
            () => Effect.void,
          ),
      },
    });
    const probe = await Effect.runPromise(Effect.scoped(fixture.driver.probe({ instanceId })));
    expect(probe.readiness).toBe("ready");
    expect(probe.models.length).toBeGreaterThan(0);
    expect(probe.message).toBeUndefined();
    expect(probe.capabilities).toMatchObject({
      resume: "supported",
      interruption: "supported",
      toolActivity: "supported",
      approvals: "supported",
      userQuestions: "supported",
      fileChanges: "unsupported",
    });
    // Where the Chat and Plan jail starts no process the launch refuses both,
    // and the report says so.
    expect(probe.capabilities.turnModes).toEqual(
      process.platform === "darwin" || process.platform === "linux"
        ? undefined
        : {
            chat: "unsupported",
            plan: "unsupported",
            work: "supported",
            code: "supported",
            unsupportedReason: "host-confinement",
          },
    );
  });

  it("lists a 2.x runtime without offering turns when its confined server cannot resolve a Git work tree", async () => {
    const fixture = betaDriver({ worktreeSessionCreate: "refused" });
    const probe = await Effect.runPromise(Effect.scoped(fixture.driver.probe({ instanceId })));
    expect(probe.readiness).toBe("incompatible");
    expect(probe.reason).toBe("runtime-incompatible");
    expect(probe.message).toContain("Git");
    expect(probe.models.length).toBeGreaterThan(0);
    const { usage, ...offered } = probe.capabilities;
    expect(Object.values(offered).every((support) => support === "unsupported")).toBe(true);
    // Usage stays unproven rather than unsupported: the instance may hold
    // turns from a runtime that reported usage, and a spend ceiling would
    // stop counting their unreported turns.
    expect(usage).toBe("unavailable");
    const marker = fixture.sessionRoots.find((root) => root.includes("octant-opencode-probe-"));
    expect(marker).toBeDefined();
    expect(existsSync(marker!)).toBe(false);
  });

  it("attests a 2.x runtime ready when session create succeeds at a Git marker the confined launch can read", async () => {
    const fixture = betaDriver();
    const probe = await Effect.runPromise(Effect.scoped(fixture.driver.probe({ instanceId })));
    expect(probe.readiness).toBe("ready");
    expect(probe.models.length).toBeGreaterThan(0);
    // The probe attested at a directory with a `.git` marker inside the
    // launch's scratch directory; the marker is cleaned up after the probe.
    const marker = fixture.sessionRoots.find((root) => root.includes("octant-opencode-probe-"));
    expect(marker?.startsWith(`${fixture.launchScratch}/`)).toBe(true);
    expect(existsSync(marker ?? "")).toBe(false);
  });

  it("deletes the session it created to attest a 2.x Git work tree", async () => {
    const fixture = betaDriver();
    const probe = await Effect.runPromise(Effect.scoped(fixture.driver.probe({ instanceId })));
    expect(probe.readiness).toBe("ready");
    expect(fixture.calls).toContain("session.delete:provider-session");
  });

  it("keeps a 2.x attestation when deleting its session fails, and deletes nothing it did not create", async () => {
    const leftBehind = betaDriver({ sessionDelete: "refused" });
    const ready = await Effect.runPromise(Effect.scoped(leftBehind.driver.probe({ instanceId })));
    expect(ready.readiness).toBe("ready");
    expect(leftBehind.calls).toContain("session.delete:provider-session");

    const refused = betaDriver({ worktreeSessionCreate: "refused" });
    const incompatible = await Effect.runPromise(
      Effect.scoped(refused.driver.probe({ instanceId })),
    );
    expect(incompatible.readiness).toBe("incompatible");
    expect(refused.calls.some((call) => call.startsWith("session.delete:"))).toBe(false);
  });

  it("lists a 2.x runtime without offering turns when its launch reports no readable scratch directory", async () => {
    const fixture = betaDriver({ launchScratch: "unreported" });
    const probe = await Effect.runPromise(Effect.scoped(fixture.driver.probe({ instanceId })));
    expect(probe.readiness).toBe("incompatible");
    expect(probe.reason).toBe("runtime-incompatible");
    expect(probe.models.length).toBeGreaterThan(0);
  });

  it("lists OpenCode 2's own commands on the probe", async () => {
    const commands = [{ name: "review", description: "review changes" }];
    const fixture = betaDriver({ commands });
    const probe = await Effect.runPromise(Effect.scoped(fixture.driver.probe({ instanceId })));
    expect(probe.readiness).toBe("ready");
    expect(probe.commands).toEqual(commands);
  });

  it("runs a chosen OpenCode 2 command through its command route in Code", async () => {
    const fixture = betaDriver({ commands: [{ name: "review" }] });
    const probe = await Effect.runPromise(Effect.scoped(fixture.driver.probe({ instanceId })));
    fixture.registry.setObservedState(probe);
    await Effect.runPromise(
      Effect.scoped(
        fixture.driver.acquire({ instanceId, projectRoot: "/tmp/project", mode: "code" }).pipe(
          Effect.flatMap((connection) =>
            connection.start({ sessionId, modelId, executionPolicy: "approval-gated" }).pipe(
              Effect.tap(() =>
                connection.send({
                  sessionId,
                  prompt: "/review main",
                  attachments: [],
                  tools: [],
                  context: [{ kind: "instructions", text: "Octant instructions" }],
                }),
              ),
              Effect.tap(() =>
                connection.send({
                  sessionId,
                  prompt: "/tmp is a path",
                  attachments: [],
                  tools: [],
                }),
              ),
            ),
          ),
        ),
      ),
    );
    expect(fixture.calls).toContain("session.command:review:main:context");
    // Text that only starts with a slash names no listed command.
    expect(fixture.calls.filter((call) => call === "session.promptAsync")).toHaveLength(1);
  });

  it("routes a command by its own Project's list, not by the list another Project's session left", async () => {
    const fixture = betaDriver({
      commands: (root) => (root === "/tmp/project" ? [{ name: "review" }] : [{ name: "deploy" }]),
    });
    const probe = await Effect.runPromise(Effect.scoped(fixture.driver.probe({ instanceId })));
    fixture.registry.setObservedState(probe);
    const sent = await Effect.runPromise(
      Effect.scoped(
        fixture.driver.acquire({ instanceId, projectRoot: "/tmp/project", mode: "code" }).pipe(
          Effect.flatMap((connection) =>
            connection.start({ sessionId, modelId, executionPolicy: "approval-gated" }).pipe(
              Effect.tap(() =>
                // Another Project's session started since and left its own list.
                fixture.registry.setObservedCommands(instanceId, [{ name: "deploy" }]),
              ),
              Effect.flatMap(() =>
                Effect.all([
                  Effect.exit(
                    connection.send({
                      sessionId,
                      prompt: "/deploy now",
                      attachments: [],
                      tools: [],
                    }),
                  ),
                  Effect.exit(
                    connection.send({
                      sessionId,
                      prompt: "/review main",
                      attachments: [],
                      tools: [],
                    }),
                  ),
                ]),
              ),
            ),
          ),
        ),
      ),
    );
    // This Project lists no /deploy: it is neither run nor sent to the model as text.
    expect(String(sent[0])).toContain("not one of OpenCode's commands in this Project");
    expect(fixture.calls).not.toContain("session.command:deploy:now:");
    expect(fixture.calls).not.toContain("session.promptAsync");
    // Its own /review runs, though the list the other Project left lacks it.
    expect(Exit.isSuccess(sent[1])).toBe(true);
    expect(fixture.calls).toContain("session.command:review:main:");
  });

  it("never resumes a session holding a turn's context that its failed command left queued", async () => {
    const fixture = betaDriver({
      commands: [{ name: "review" }],
      commandFailure: "context-queued",
    });
    const probe = await Effect.runPromise(Effect.scoped(fixture.driver.probe({ instanceId })));
    fixture.registry.setObservedState(probe);
    const first = await Effect.runPromise(
      Effect.scoped(
        fixture.driver.acquire({ instanceId, projectRoot: "/tmp/project", mode: "code" }).pipe(
          Effect.flatMap((connection) =>
            connection.start({ sessionId, modelId, executionPolicy: "approval-gated" }).pipe(
              Effect.flatMap((handle) =>
                Effect.exit(
                  connection.send({
                    sessionId,
                    prompt: "/review main",
                    attachments: [],
                    tools: [],
                    context: [{ kind: "instructions", text: "Octant instructions" }],
                  }),
                ).pipe(Effect.map((exit) => ({ exit, handle }))),
              ),
            ),
          ),
        ),
      ),
    );
    expect(Exit.isFailure(first.exit)).toBe(true);
    expect(String(first.exit)).toContain("stale-resume");
    const resumeCursor = first.handle.resumeCursor;
    expect(resumeCursor).toBeDefined();
    const resumed = await Effect.runPromise(
      Effect.scoped(
        fixture.driver.acquire({ instanceId, projectRoot: "/tmp/project", mode: "code" }).pipe(
          Effect.flatMap((connection) =>
            Effect.exit(
              connection.resume({
                sessionId,
                resumeCursor: resumeCursor!,
                executionPolicy: "approval-gated",
              }),
            ),
          ),
        ),
      ),
    );
    expect(String(resumed)).toContain("did not run its command");
  });

  it("runs a listed OpenCode command in Plan through its command route, under the session's Plan rules", async () => {
    const fixture = betaDriver({ commands: [{ name: "review" }] });
    const probe = await Effect.runPromise(Effect.scoped(fixture.driver.probe({ instanceId })));
    fixture.registry.setObservedState(probe);
    const result = await Effect.runPromise(
      Effect.scoped(
        fixture.driver
          .acquire({ instanceId, projectRoot: "/tmp/project", mode: "code" })
          .pipe(
            Effect.flatMap((connection) =>
              connection
                .start({ sessionId, modelId, executionPolicy: "plan" })
                .pipe(
                  Effect.flatMap(() =>
                    Effect.exit(
                      connection.send({ sessionId, prompt: "/review", attachments: [], tools: [] }),
                    ),
                  ),
                ),
            ),
          ),
      ),
    );
    expect(Exit.isSuccess(result)).toBe(true);
    expect(fixture.calls).toContain("session.command:review::");
    expect(fixture.calls).not.toContain("session.promptAsync");
  });

  it("offers a 2.x turn in every mode once the jail serves a Git work tree", async () => {
    for (const [mode, policy] of [
      ["chat", "approval-gated"],
      ["work", "plan"],
      ["work", "approval-gated"],
      ["code", "approval-gated"],
    ] as const) {
      const fixture = betaDriver();
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const connection = yield* fixture.driver.acquire({
              instanceId,
              projectRoot: "/tmp/project",
              mode,
            });
            yield* connection.start({ sessionId, modelId, executionPolicy: policy });
          }),
        ),
      );
      expect(fixture.calls).toContain("session.create:ask");
    }
  });

  it("registers the managed-tool bridge for a 2.x Chat start that includes tools", async () => {
    const fixture = betaDriver();
    await Effect.runPromise(
      Effect.scoped(
        fixture.driver.acquire({ instanceId, projectRoot: "/tmp/project", mode: "chat" }).pipe(
          Effect.flatMap((connection) =>
            connection.start({
              sessionId,
              modelId,
              executionPolicy: "approval-gated",
              tools: [{ name: "octant_browser", inputSchema: { type: "object" } }],
            }),
          ),
        ),
      ),
    );
    expect(fixture.calls).toContain("session.create:ask");
    expect(fixture.calls.some((call) => call.startsWith("mcp.add:"))).toBe(true);
  });

  it("starts a 2.x Chat turn twice without poisoning the connection", async () => {
    const fixture = betaDriver();
    const outcome = await Effect.runPromise(
      Effect.scoped(
        fixture.driver
          .acquire({ instanceId, projectRoot: "/tmp/project", mode: "chat" })
          .pipe(
            Effect.flatMap((connection) =>
              connection
                .start({ sessionId, modelId, executionPolicy: "approval-gated" })
                .pipe(
                  Effect.zipRight(
                    connection
                      .start({ sessionId, modelId, executionPolicy: "approval-gated" })
                      .pipe(Effect.exit),
                  ),
                ),
            ),
          ),
      ),
    );
    // The second start on the same session is refused as a protocol error,
    // not a stale-exit or aborted-stream failure masquerading as one.
    expect(outcome._tag).toBe("Failure");
    expect(String(outcome)).toContain("already active");
    expect(fixture.calls.filter((call) => call === "session.create:ask")).toHaveLength(1);
  });

  it("reads 2.0.22's permission.asked and permission.replied events as 2.x permission events", () => {
    expect(
      adaptBetaOpenCodeEvent({
        type: "permission.asked",
        data: { id: "per_1", sessionID: "ses_1", action: "edit", resources: ["a.ts"] },
      }),
    ).toEqual({
      type: "permission.v2.asked",
      properties: { id: "per_1", sessionID: "ses_1", action: "edit", resources: ["a.ts"] },
    });
    expect(
      adaptBetaOpenCodeEvent({
        type: "permission.replied",
        data: { sessionID: "ses_1", requestID: "per_1", reply: "reject" },
      }),
    ).toMatchObject({ type: "permission.v2.replied" });
  });

  it("reads 2.0.22's finished compaction as the 2.x compaction end, so the session's reports say it compacted", () => {
    expect(
      adaptBetaOpenCodeEvent({
        type: "session.compaction.ended",
        data: { sessionID: "ses_1", reason: "auto" },
      }),
    ).toEqual({
      type: "session.next.compaction.ended",
      properties: { sessionID: "ses_1", reason: "auto" },
    });
  });

  it("adapts a 2.x event from data when properties is empty", () => {
    expect(
      adaptBetaOpenCodeEvent({
        type: "session.idle",
        properties: {},
        data: { sessionID: "provider-session" },
      }),
    ).toEqual({
      type: "session.idle",
      properties: { sessionID: "provider-session" },
    });
  });

  it("keeps a 2.x approved edit when OpenCode settles it and reports the change before the reply returns", async () => {
    const fixture = betaDriver({
      events: [
        {
          type: "permission.v2.asked",
          properties: {
            id: "perm-edit",
            sessionID: "provider-session",
            action: "edit",
            resources: ["/tmp/project/a.ts"],
          },
        } as unknown as Event,
      ],
      eventsOnReply: [
        {
          type: "permission.v2.replied",
          properties: { sessionID: "provider-session", requestID: "perm-edit", reply: "once" },
        } as unknown as Event,
        {
          type: "file.edited",
          properties: { sessionID: "provider-session", file: "/tmp/project/a.ts" },
        } as unknown as Event,
        { type: "session.idle", properties: { sessionID: "provider-session" } } as unknown as Event,
      ],
    });
    const output = await Effect.runPromise(
      Effect.scoped(
        fixture.driver.acquire({ instanceId, projectRoot: "/tmp/project", mode: "code" }).pipe(
          Effect.flatMap((connection) =>
            Effect.gen(function* () {
              const stream = yield* connection.subscribe;
              const collector = yield* Effect.fork(
                Stream.runCollect(
                  stream.pipe(
                    Stream.takeUntil((event) =>
                      ["completed", "failed", "interrupted"].includes(event.kind),
                    ),
                  ),
                ),
              );
              yield* connection.start({ sessionId, modelId, executionPolicy: "approval-gated" });
              yield* Effect.sleep("20 millis");
              yield* connection.answerApproval({
                sessionId,
                requestId: "perm-edit",
                approved: true,
              });
              return yield* Fiber.join(collector);
            }),
          ),
        ),
      ),
    );
    const events = Array.from(output);
    expect(events.some((event) => event.kind === "file-change")).toBe(true);
    expect(events.some((event) => event.kind === "failed")).toBe(false);
  });

  it("fails a 2.x turn when a file the approved edit did not name changes, even while grants remain", async () => {
    const fixture = betaDriver({
      events: [
        {
          type: "permission.v2.asked",
          properties: {
            id: "perm-edit",
            sessionID: "provider-session",
            action: "edit",
            resources: ["/tmp/project/a.ts", "b.ts"],
          },
        } as unknown as Event,
      ],
      eventsOnReply: [
        {
          type: "permission.v2.replied",
          properties: { sessionID: "provider-session", requestID: "perm-edit", reply: "once" },
        } as unknown as Event,
        {
          type: "file.edited",
          properties: { sessionID: "provider-session", file: "/tmp/project/a.ts" },
        } as unknown as Event,
        {
          type: "file.edited",
          properties: { sessionID: "provider-session", file: "/tmp/project/c.ts" },
        } as unknown as Event,
        {
          type: "file.edited",
          properties: { sessionID: "provider-session", file: "/tmp/project/b.ts" },
        } as unknown as Event,
        { type: "session.idle", properties: { sessionID: "provider-session" } } as unknown as Event,
      ],
    });
    const output = await Effect.runPromise(
      Effect.scoped(
        fixture.driver.acquire({ instanceId, projectRoot: "/tmp/project", mode: "code" }).pipe(
          Effect.flatMap((connection) =>
            Effect.gen(function* () {
              const stream = yield* connection.subscribe;
              const collector = yield* Effect.fork(
                Stream.runCollect(
                  stream.pipe(
                    Stream.takeUntil((event) =>
                      ["completed", "failed", "interrupted"].includes(event.kind),
                    ),
                  ),
                ),
              );
              yield* connection.start({ sessionId, modelId, executionPolicy: "approval-gated" });
              yield* Effect.sleep("20 millis");
              yield* connection.answerApproval({
                sessionId,
                requestId: "perm-edit",
                approved: true,
              });
              return yield* Fiber.join(collector);
            }),
          ),
        ),
      ),
    );
    const events = Array.from(output);
    expect(events.flatMap((event) => (event.kind === "file-change" ? [event.path] : []))).toEqual([
      "/tmp/project/a.ts",
    ]);
    expect(events.at(-1)).toMatchObject({
      kind: "failed",
      failure: { category: "unsupported" },
    });
  });

  it("keeps a 2.x approved edit when the user rejects another edit before it is reported", async () => {
    const fixture = betaDriver({
      events: [
        {
          type: "permission.v2.asked",
          properties: {
            id: "perm-a",
            sessionID: "provider-session",
            action: "edit",
            resources: ["/tmp/project/a.ts"],
          },
        } as unknown as Event,
        {
          type: "permission.v2.asked",
          properties: {
            id: "perm-b",
            sessionID: "provider-session",
            action: "edit",
            resources: ["/tmp/project/b.ts"],
          },
        } as unknown as Event,
      ],
      eventsOnReply: (requestId) =>
        requestId === "perm-b"
          ? [
              {
                type: "permission.v2.replied",
                properties: { sessionID: "provider-session", requestID: "perm-b", reply: "reject" },
              } as unknown as Event,
              {
                type: "file.edited",
                properties: { sessionID: "provider-session", file: "/tmp/project/a.ts" },
              } as unknown as Event,
              {
                type: "session.idle",
                properties: { sessionID: "provider-session" },
              } as unknown as Event,
            ]
          : [],
    });
    const output = await Effect.runPromise(
      Effect.scoped(
        fixture.driver.acquire({ instanceId, projectRoot: "/tmp/project", mode: "code" }).pipe(
          Effect.flatMap((connection) =>
            Effect.gen(function* () {
              const stream = yield* connection.subscribe;
              const collector = yield* Effect.fork(
                Stream.runCollect(
                  stream.pipe(
                    Stream.takeUntil((event) =>
                      ["completed", "failed", "interrupted"].includes(event.kind),
                    ),
                  ),
                ),
              );
              yield* connection.start({ sessionId, modelId, executionPolicy: "approval-gated" });
              yield* Effect.sleep("20 millis");
              yield* connection.answerApproval({ sessionId, requestId: "perm-a", approved: true });
              yield* connection.answerApproval({ sessionId, requestId: "perm-b", approved: false });
              return yield* Fiber.join(collector);
            }),
          ),
        ),
      ),
    );
    const events = Array.from(output);
    expect(events.some((event) => event.kind === "file-change")).toBe(true);
    expect(events.some((event) => event.kind === "failed")).toBe(false);
  });

  it("answers a 2.x approval once even when approvals are remembered for the project", async () => {
    const fixture = betaDriver({
      permissionPersistence: "project-default",
      events: [
        {
          type: "permission.v2.asked",
          properties: {
            id: "perm-1",
            sessionID: "provider-session",
            action: "edit",
            resources: ["/tmp/project/a.ts"],
          },
        } as unknown as Event,
      ],
    });
    await Effect.runPromise(
      Effect.scoped(
        fixture.driver.acquire({ instanceId, projectRoot: "/tmp/project", mode: "code" }).pipe(
          Effect.flatMap((connection) =>
            connection.start({ sessionId, modelId, executionPolicy: "approval-gated" }).pipe(
              Effect.tap(() =>
                connection.send({ sessionId, prompt: "edit", attachments: [], tools: [] }),
              ),
              Effect.tap(() =>
                connection.answerApproval({ sessionId, requestId: "perm-1", approved: true }),
              ),
            ),
          ),
        ),
      ),
    );
    // `always` would save a grant in OpenCode's shared data directory,
    // outside Octant's revocation.
    expect(fixture.calls).toContain("permission.reply:once");
    expect(fixture.calls).not.toContain("permission.reply:always");
  });

  it("maps a 2.x permission.v2.asked event to an approval request and replies through the v2 route", async () => {
    const fixture = betaDriver({
      events: [
        {
          type: "permission.v2.asked",
          properties: {
            id: "perm-1",
            sessionID: "provider-session",
            action: "edit",
            resources: ["*"],
          },
        } as unknown as Event,
      ],
    });
    await Effect.runPromise(
      Effect.scoped(
        fixture.driver.acquire({ instanceId, projectRoot: "/tmp/project", mode: "code" }).pipe(
          Effect.flatMap((connection) =>
            connection.start({ sessionId, modelId, executionPolicy: "approval-gated" }).pipe(
              Effect.tap(() =>
                connection.send({ sessionId, prompt: "edit", attachments: [], tools: [] }),
              ),
              Effect.tap(() =>
                connection.answerApproval({ sessionId, requestId: "perm-1", approved: true }),
              ),
            ),
          ),
        ),
      ),
    );
    expect(fixture.calls).toContain("permission.reply:once");
  });

  it("answers a remembered 2.x approval always only once the person let OpenCode run as itself, and says where the grant goes", async () => {
    const answer = async (nativeSetup: boolean) => {
      const fixture = betaDriver({
        permissionPersistence: "project-default",
        events: [
          {
            type: "permission.v2.asked",
            properties: {
              id: "perm-1",
              sessionID: "provider-session",
              action: "edit",
              resources: ["*"],
            },
          } as unknown as Event,
        ],
      });
      const approvals: string[] = [];
      await Effect.runPromise(
        Effect.scoped(
          fixture.driver.acquire({ instanceId, projectRoot: "/tmp/project", mode: "code" }).pipe(
            Effect.flatMap((connection) =>
              Effect.gen(function* () {
                const stream = yield* connection.subscribe;
                yield* Effect.fork(
                  Stream.runForEach(stream, (event) =>
                    Effect.sync(() => {
                      if (event.kind === "approval-request") approvals.push(event.description);
                    }),
                  ),
                );
                yield* connection.start({
                  sessionId,
                  modelId,
                  executionPolicy: "approval-gated",
                  ...(nativeSetup
                    ? {
                        nativeSetup: {
                          subagents: true,
                          webTools: true,
                          skills: true,
                          toolServers: true,
                          hooks: true,
                          projectCode: false,
                        },
                      }
                    : {}),
                });
                yield* connection.send({ sessionId, prompt: "edit", attachments: [], tools: [] });
                yield* Effect.sleep("20 millis");
                yield* connection.answerApproval({
                  sessionId,
                  requestId: "perm-1",
                  approved: true,
                });
              }),
            ),
          ),
        ),
      );
      return { calls: fixture.calls, approvals };
    };
    const own = await answer(true);
    expect(own.calls).toContain("permission.reply:always");
    expect(own.approvals.at(-1)).toContain("OpenCode's own settings");
    const locked = await answer(false);
    expect(locked.calls).toContain("permission.reply:once");
    expect(locked.approvals.at(-1)).not.toContain("OpenCode's own settings");
  });

  it("admits the edits OpenCode makes later on a grant it remembers from an always answer, and the requests it settles by itself", async () => {
    const asked = (id: string, file: string) =>
      ({
        type: "permission.v2.asked",
        properties: { id, sessionID: "provider-session", action: "edit", resources: [file] },
      }) as unknown as Event;
    const fixture = betaDriver({
      permissionPersistence: "project-default",
      events: [asked("perm-a", "/tmp/project/a.ts"), asked("perm-b", "/tmp/project/b.ts")],
      eventsOnReply: [
        {
          type: "permission.v2.replied",
          properties: { sessionID: "provider-session", requestID: "perm-a", reply: "always" },
        } as unknown as Event,
        // OpenCode settles the other pending request by the remembered grant.
        {
          type: "permission.v2.replied",
          properties: { sessionID: "provider-session", requestID: "perm-b", reply: "always" },
        } as unknown as Event,
        {
          type: "file.edited",
          properties: { sessionID: "provider-session", file: "/tmp/project/a.ts" },
        } as unknown as Event,
        // A later edit of the same file asks nothing: OpenCode applies its grant.
        {
          type: "file.edited",
          properties: { sessionID: "provider-session", file: "/tmp/project/a.ts" },
        } as unknown as Event,
        {
          type: "file.edited",
          properties: { sessionID: "provider-session", file: "/tmp/project/b.ts" },
        } as unknown as Event,
        { type: "session.idle", properties: { sessionID: "provider-session" } } as unknown as Event,
      ],
    });
    const output = await Effect.runPromise(
      Effect.scoped(
        fixture.driver.acquire({ instanceId, projectRoot: "/tmp/project", mode: "code" }).pipe(
          Effect.flatMap((connection) =>
            Effect.gen(function* () {
              const stream = yield* connection.subscribe;
              const collector = yield* Effect.fork(
                Stream.runCollect(
                  stream.pipe(
                    Stream.takeUntil((event) =>
                      ["completed", "failed", "interrupted"].includes(event.kind),
                    ),
                  ),
                ),
              );
              yield* connection.start({
                sessionId,
                modelId,
                executionPolicy: "approval-gated",
                nativeSetup: {
                  subagents: false,
                  webTools: true,
                  skills: true,
                  toolServers: true,
                  hooks: true,
                  projectCode: false,
                },
              });
              yield* Effect.sleep("20 millis");
              yield* connection.answerApproval({ sessionId, requestId: "perm-a", approved: true });
              return yield* Fiber.join(collector);
            }),
          ),
        ),
      ),
    );
    const events = Array.from(output);
    expect(fixture.calls).toContain("permission.reply:always");
    expect(events.filter((event) => event.kind === "file-change")).toHaveLength(3);
    expect(events.some((event) => event.kind === "failed")).toBe(false);
  });

  it("does not reply to an approval-gated 2.x write until the user approves it", async () => {
    const fixture = betaDriver({
      events: [
        {
          type: "permission.v2.asked",
          properties: {
            id: "perm-held",
            sessionID: "provider-session",
            action: "edit",
            resources: ["*"],
          },
        } as unknown as Event,
      ],
    });
    await Effect.runPromise(
      Effect.scoped(
        fixture.driver
          .acquire({ instanceId, projectRoot: "/tmp/project", mode: "code" })
          .pipe(
            Effect.flatMap((connection) =>
              connection
                .start({ sessionId, modelId, executionPolicy: "approval-gated" })
                .pipe(
                  Effect.tap(() =>
                    connection.send({ sessionId, prompt: "edit", attachments: [], tools: [] }),
                  ),
                ),
            ),
          ),
      ),
    );
    expect(fixture.calls.some((call) => call.startsWith("permission.reply:"))).toBe(false);
  });

  it("rejects a 2.x request the posture denies without asking the user", async () => {
    const fixture = betaDriver({
      events: [
        {
          type: "permission.v2.asked",
          properties: {
            id: "perm-skill",
            sessionID: "provider-session",
            action: "skill",
            resources: ["review"],
          },
        } as unknown as Event,
        {
          type: "session.idle",
          properties: { sessionID: "provider-session" },
        } as unknown as Event,
      ],
    });
    const output = await Effect.runPromise(
      Effect.scoped(
        fixture.driver.acquire({ instanceId, projectRoot: "/tmp/project", mode: "code" }).pipe(
          Effect.flatMap((connection) =>
            Effect.gen(function* () {
              const stream = yield* connection.subscribe;
              const collector = yield* Effect.fork(
                Stream.runCollect(
                  stream.pipe(Stream.takeUntil((event) => event.kind === "completed")),
                ),
              );
              yield* connection.start({ sessionId, modelId, executionPolicy: "approval-gated" });
              return yield* Fiber.join(collector);
            }),
          ),
        ),
      ),
    );
    expect(fixture.calls).toContain("permission.reply:reject");
    expect(Array.from(output).some((event) => event.kind === "approval-request")).toBe(false);
  });

  it("offers a 2.x Code turn under Plan, whose jail serves Git through the stand-in", async () => {
    const fixture = betaDriver();
    await Effect.runPromise(
      Effect.scoped(
        fixture.driver
          .acquire({ instanceId, projectRoot: "/tmp/project", mode: "code" })
          .pipe(
            Effect.flatMap((connection) =>
              connection.start({ sessionId, modelId, executionPolicy: "plan" }),
            ),
          ),
      ),
    );
    expect(fixture.calls).toContain("session.create:ask");
  });

  it("forgets a 2.x approval that OpenCode settled when it rejected another request", async () => {
    const fixture = betaDriver({
      events: [
        {
          type: "permission.v2.asked",
          properties: {
            id: "perm-edit",
            sessionID: "provider-session",
            action: "edit",
            resources: ["/tmp/project/a.ts"],
          },
        } as unknown as Event,
        {
          type: "permission.v2.replied",
          properties: { sessionID: "provider-session", requestID: "perm-edit", reply: "reject" },
        } as unknown as Event,
      ],
    });
    const answer = await Effect.runPromise(
      Effect.scoped(
        fixture.driver.acquire({ instanceId, projectRoot: "/tmp/project", mode: "code" }).pipe(
          Effect.flatMap((connection) =>
            Effect.gen(function* () {
              const stream = yield* connection.subscribe;
              const collector = yield* Effect.fork(
                Stream.runCollect(
                  stream.pipe(Stream.takeUntil((event) => event.kind === "approval-request")),
                ),
              );
              yield* connection.start({ sessionId, modelId, executionPolicy: "approval-gated" });
              yield* Fiber.join(collector);
              yield* Effect.sleep("20 millis");
              return yield* Effect.exit(
                connection.answerApproval({ sessionId, requestId: "perm-edit", approved: true }),
              );
            }),
          ),
        ),
      ),
    );
    expect(String(answer)).toContain("not pending");
    expect(fixture.calls.some((call) => call.startsWith("permission.reply:"))).toBe(false);
  });

  it("allows a 2.x edit under auto-accept without asking, and reports the file change", async () => {
    const fixture = betaDriver({
      events: [
        {
          type: "permission.v2.asked",
          properties: {
            id: "perm-auto",
            sessionID: "provider-session",
            action: "edit",
            resources: ["*"],
          },
        } as unknown as Event,
        {
          type: "file.edited",
          properties: { sessionID: "provider-session", file: "/tmp/project/src/index.ts" },
        } as unknown as Event,
        {
          type: "session.idle",
          properties: { sessionID: "provider-session" },
        } as unknown as Event,
      ],
    });
    const output = await Effect.runPromise(
      Effect.scoped(
        fixture.driver.acquire({ instanceId, projectRoot: "/tmp/project", mode: "code" }).pipe(
          Effect.flatMap((connection) =>
            Effect.gen(function* () {
              const stream = yield* connection.subscribe;
              const collector = yield* Effect.fork(
                Stream.runCollect(
                  stream.pipe(
                    Stream.takeUntil((event) =>
                      ["completed", "failed", "interrupted"].includes(event.kind),
                    ),
                  ),
                ),
              );
              yield* connection.start({
                sessionId,
                modelId,
                executionPolicy: "auto-accept-edits",
              });
              return yield* Fiber.join(collector);
            }),
          ),
        ),
      ),
    );
    const events = Array.from(output);
    expect(fixture.calls).toContain("permission.reply:once");
    expect(events.some((event) => event.kind === "approval-request")).toBe(false);
    expect(events.some((event) => event.kind === "file-change")).toBe(true);
    expect(events.some((event) => event.kind === "failed")).toBe(false);
  });

  it("refuses a 2.x permission request that names no action", async () => {
    const fixture = betaDriver({
      events: [
        {
          type: "permission.v2.asked",
          properties: { id: "perm-bare", sessionID: "provider-session" },
        } as unknown as Event,
      ],
    });
    const output = await Effect.runPromise(
      Effect.scoped(
        fixture.driver.acquire({ instanceId, projectRoot: "/tmp/project", mode: "code" }).pipe(
          Effect.flatMap((connection) =>
            Effect.gen(function* () {
              const stream = yield* connection.subscribe;
              const collector = yield* Effect.fork(
                Stream.runCollect(
                  stream.pipe(
                    Stream.takeUntil((event) =>
                      ["completed", "failed", "interrupted"].includes(event.kind),
                    ),
                  ),
                ),
              );
              yield* connection.start({
                sessionId,
                modelId,
                executionPolicy: "approval-gated",
              });
              return yield* Fiber.join(collector);
            }),
          ),
        ),
      ),
    );
    const events = Array.from(output);
    expect(
      events.some(
        (event) =>
          event.kind === "failed" &&
          event.failure.category === "unsupported" &&
          event.failure.message.includes("cannot be mapped"),
      ),
    ).toBe(true);
    expect(fixture.calls.some((call) => call.startsWith("permission.reply:"))).toBe(false);
  });

  it("asks a 2.x question form through the questionnaire and answers OpenCode at the form", async () => {
    // The shape 2.0.22's question tool publishes: the session sits inside the
    // form, and each question is a field keyed by its position.
    const fixture = betaDriver({
      events: [
        {
          type: "form.created",
          properties: {
            form: {
              id: "frm_1",
              sessionID: "provider-session",
              title: "Questions",
              metadata: { kind: "question", tool: { messageID: "msg_1", id: "call_1" } },
              fields: [
                {
                  key: "q0",
                  title: "Continue",
                  description: "Continue with the migration?",
                  type: "string",
                  options: [
                    { value: "Yes", label: "Yes", description: "Run it now" },
                    { value: "No", label: "No", description: "Stop here" },
                  ],
                  custom: true,
                },
              ],
            },
          },
        } as unknown as Event,
      ],
    });
    const { events, answer } = await Effect.runPromise(
      Effect.scoped(
        fixture.driver.acquire({ instanceId, projectRoot: "/tmp/project", mode: "code" }).pipe(
          Effect.flatMap((connection) =>
            Effect.gen(function* () {
              const stream = yield* connection.subscribe;
              const collector = yield* Effect.fork(
                Stream.runCollect(
                  stream.pipe(
                    Stream.takeUntil((event) =>
                      ["user-input-request", "completed", "failed"].includes(event.kind),
                    ),
                  ),
                ),
              );
              yield* connection.start({ sessionId, modelId, executionPolicy: "plan" });
              const events = Array.from(yield* Fiber.join(collector));
              const question = events.find((event) => event.kind === "user-input-request");
              if (question?.kind !== "user-input-request") return { events, answer: undefined };
              const answer = yield* Effect.exit(
                connection.answerUserInput({
                  sessionId,
                  requestId: question.requestId,
                  answer: "Yes",
                }),
              );
              return { events, answer };
            }),
          ),
        ),
      ),
    );
    expect(events.some((event) => event.kind === "failed")).toBe(false);
    expect(events.find((event) => event.kind === "user-input-request")).toMatchObject({
      prompt: "Continue with the migration?",
      options: [
        { label: "Yes", description: "Run it now" },
        { label: "No", description: "Stop here" },
      ],
    });
    expect(answer?._tag).toBe("Success");
    expect(fixture.calls).toContain("question.reply:Yes");
  });

  it("asks a 2.x subagent's question form and answers it in the subagent's own session", async () => {
    // The root's own read is allowed and answered by the host, after which
    // OpenCode delegates; the child then asks through a form.
    const fixture = betaDriver({
      events: [
        {
          type: "permission.v2.asked",
          properties: {
            id: "perm-read",
            sessionID: "provider-session",
            action: "read",
            resources: ["/tmp/project/a.ts"],
          },
        } as unknown as Event,
      ],
      eventsOnReply: [
        {
          type: "session.created",
          properties: {
            sessionID: "child-session",
            info: { id: "child-session", parentID: "provider-session", title: "Plan it" },
          },
        } as unknown as Event,
        {
          type: "form.created",
          properties: {
            form: {
              id: "frm_child",
              sessionID: "child-session",
              title: "Questions",
              metadata: { kind: "question" },
              fields: [
                {
                  key: "q0",
                  title: "Scope",
                  description: "Include the tests?",
                  type: "string",
                  options: [{ value: "Yes", label: "Yes" }],
                },
              ],
            },
          },
        } as unknown as Event,
      ],
    });
    const { events, answer } = await Effect.runPromise(
      Effect.scoped(
        fixture.driver.acquire({ instanceId, projectRoot: "/tmp/project", mode: "code" }).pipe(
          Effect.flatMap((connection) =>
            Effect.gen(function* () {
              const stream = yield* connection.subscribe;
              const collector = yield* Effect.fork(
                Stream.runCollect(
                  stream.pipe(
                    Stream.takeUntil((event) =>
                      ["user-input-request", "completed", "failed"].includes(event.kind),
                    ),
                  ),
                ),
              );
              yield* connection.start({ sessionId, modelId, executionPolicy: "plan" });
              const events = Array.from(yield* Fiber.join(collector));
              const question = events.find((event) => event.kind === "user-input-request");
              if (question?.kind !== "user-input-request") return { events, answer: undefined };
              const answer = yield* Effect.exit(
                connection.answerUserInput({
                  sessionId,
                  requestId: question.requestId,
                  answer: "Yes",
                }),
              );
              return { events, answer };
            }),
          ),
        ),
      ),
    );
    expect(events.find((event) => event.kind === "user-input-request")).toMatchObject({
      prompt: "Include the tests?",
    });
    expect(answer?._tag).toBe("Success");
    expect(fixture.questionReplies).toEqual(["child-session:frm_child"]);
  });

  it("refuses a 2.x question form that asks for a secret and never shows or journals it", async () => {
    const fixture = betaDriver({
      events: [
        {
          type: "form.created",
          properties: {
            form: {
              id: "frm_secret",
              sessionID: "provider-session",
              title: "Questions",
              metadata: { kind: "question" },
              fields: [
                {
                  key: "q0",
                  title: "Region",
                  description: "Which region should the deploy use?",
                  type: "string",
                  options: [{ value: "eu", label: "eu", description: "Europe" }],
                },
                {
                  key: "q1",
                  title: "Credentials",
                  description: "Paste the API key for the deploy account.",
                  type: "string",
                  options: [],
                },
              ],
            },
          },
        } as unknown as Event,
        idleEvent("provider-session"),
      ],
    });
    const output = await Effect.runPromise(
      Effect.scoped(
        fixture.driver.acquire({ instanceId, projectRoot: "/tmp/project", mode: "code" }).pipe(
          Effect.flatMap((connection) =>
            Effect.gen(function* () {
              const stream = yield* connection.subscribe;
              const collector = yield* Effect.fork(
                Stream.runCollect(
                  stream.pipe(
                    Stream.takeUntil((event) =>
                      ["completed", "failed", "interrupted"].includes(event.kind),
                    ),
                  ),
                ),
              );
              yield* connection.start({ sessionId, modelId, executionPolicy: "plan" });
              return yield* Fiber.join(collector);
            }),
          ),
        ),
      ),
    );
    const events = Array.from(output);
    expect(events.some((event) => event.kind === "user-input-request")).toBe(false);
    expect(events.some((event) => event.kind === "failed")).toBe(false);
    expect(JSON.stringify(events)).not.toContain("API key");
    await vi.waitFor(() =>
      expect(fixture.calls.filter((call) => call.startsWith("question.reply:"))).toEqual([
        `question.reply:${SECRET_QUESTION_REFUSAL}|${SECRET_QUESTION_REFUSAL}`,
      ]),
    );
  });

  it("ends a 2.x turn OpenCode's shutdown cut off as held for recovery, and sends nothing again", async () => {
    const shutdown = adaptBetaOpenCodeEvent({
      type: "session.execution.interrupted",
      data: { sessionID: "provider-session", reason: "shutdown" },
    });
    if (shutdown === undefined) throw new Error("Expected the shutdown to be adapted.");
    const fixture = betaDriver({ events: [shutdown, idleEvent("provider-session")] });
    const output = await Effect.runPromise(
      Effect.scoped(
        fixture.driver.acquire({ instanceId, projectRoot: "/tmp/project", mode: "code" }).pipe(
          Effect.flatMap((connection) =>
            Effect.gen(function* () {
              const stream = yield* connection.subscribe;
              const collector = yield* Effect.fork(
                Stream.runCollect(
                  stream.pipe(
                    Stream.takeUntil((event) =>
                      ["completed", "failed", "interrupted", "waiting"].includes(event.kind),
                    ),
                  ),
                ),
              );
              yield* connection.start({ sessionId, modelId, executionPolicy: "approval-gated" });
              const events = yield* Fiber.join(collector);
              expect(fixture.registry.activeSessionCount(instanceId)).toBe(0);
              // The held session is retired, so nothing can be sent on it again.
              const late = yield* connection
                .send({
                  sessionId,
                  prompt: "again",
                  attachments: [],
                  tools: [],
                })
                .pipe(Effect.flip);
              return { events, late };
            }),
          ),
        ),
      ),
    );
    expect(Array.from(output.events).at(-1)).toMatchObject({
      kind: "waiting",
      message: "OpenCode shut down while this turn was running. Check what it did, then resume.",
    });
    expect(output.late).toMatchObject({ category: "protocol" });
    expect(fixture.calls).not.toContain("session.promptAsync");
  });

  it("registers app-managed MCP tools over the 2.x API in Code mode", async () => {
    const fixture = betaDriver();
    await Effect.runPromise(
      Effect.scoped(
        fixture.driver.acquire({ instanceId, projectRoot: "/tmp/project", mode: "code" }).pipe(
          Effect.flatMap((connection) =>
            connection.start({
              sessionId,
              modelId,
              executionPolicy: "approval-gated",
              tools: [{ name: "octant_browser", inputSchema: { type: "object" } }],
            }),
          ),
        ),
      ),
    );
    expect(fixture.calls.some((call) => call.startsWith("mcp.add:"))).toBe(true);
  });

  it("refuses a 2.x app tool call that names another OpenCode session", async () => {
    const fixture = betaDriver();
    const outcome = await Effect.runPromise(
      Effect.scoped(
        fixture.driver.acquire({ instanceId, projectRoot: "/tmp/project", mode: "code" }).pipe(
          Effect.flatMap((connection) =>
            Effect.gen(function* () {
              const stream = yield* connection.subscribe;
              const toolRequest = yield* Effect.fork(
                Stream.runHead(
                  stream.pipe(Stream.filter((event) => event.kind === "tool-request")),
                ),
              );
              yield* connection.start({
                sessionId,
                modelId,
                executionPolicy: "approval-gated",
                tools: [{ name: "octant_browser", inputSchema: { type: "object" } }],
              });
              const bridge = fixture.mcpBridges[0];
              if (bridge === undefined) throw new Error("Expected a registered bridge.");
              // 2.0.22 names the calling session in `ai.opencode/sessionID`,
              // where 1.x used `sessionID`.
              const foreign = yield* Effect.promise(() =>
                callBridgeTool(bridge, "octant_browser", { "ai.opencode/sessionID": "ses_other" }),
              );
              void callBridgeTool(bridge, "octant_browser", {
                "ai.opencode/sessionID": "provider-session",
              });
              const owned = yield* Fiber.join(toolRequest);
              return { foreign, owned };
            }),
          ),
        ),
      ),
    );
    expect(outcome.foreign).toContain("tool-unavailable");
    expect(outcome.owned._tag).toBe("Some");
  });

  it("fails a 2.x turn closed on an event it cannot map, naming the event", async () => {
    const fixture = betaDriver({
      events: [
        {
          type: "session.future.event",
          properties: { sessionID: "provider-session" },
        } as unknown as Event,
      ],
    });
    const output = await Effect.runPromise(
      Effect.scoped(
        fixture.driver.acquire({ instanceId, projectRoot: "/tmp/project", mode: "code" }).pipe(
          Effect.flatMap((connection) =>
            Effect.gen(function* () {
              const stream = yield* connection.subscribe;
              const collector = yield* Effect.fork(
                Stream.runCollect(
                  stream.pipe(
                    Stream.takeUntil((event) =>
                      ["completed", "failed", "interrupted"].includes(event.kind),
                    ),
                  ),
                ),
              );
              yield* connection.start({ sessionId, modelId, executionPolicy: "approval-gated" });
              return yield* Fiber.join(collector);
            }),
          ),
        ),
      ),
    );
    expect(Array.from(output).at(-1)).toMatchObject({
      kind: "failed",
      failure: {
        category: "unsupported",
        message: "OpenCode 2 sent an event Octant does not map: session.future.event.",
      },
    });
  });

  it("fails a 2.x file-change event closed in Code mode", async () => {
    const fixture = betaDriver({
      events: [
        {
          type: "file.edited",
          properties: { sessionID: "provider-session", file: "/tmp/project/src/index.ts" },
        } as unknown as Event,
      ],
    });
    const output = await Effect.runPromise(
      Effect.scoped(
        fixture.driver.acquire({ instanceId, projectRoot: "/tmp/project", mode: "code" }).pipe(
          Effect.flatMap((connection) =>
            Effect.gen(function* () {
              const stream = yield* connection.subscribe;
              const collector = yield* Effect.fork(
                Stream.runCollect(
                  stream.pipe(
                    Stream.takeUntil((event) =>
                      ["completed", "failed", "interrupted"].includes(event.kind),
                    ),
                  ),
                ),
              );
              yield* connection.start({
                sessionId,
                modelId,
                executionPolicy: "approval-gated",
              });
              return yield* Fiber.join(collector);
            }),
          ),
        ),
      ),
    );
    const events = Array.from(output);
    expect(events.some((event) => event.kind === "file-change")).toBe(false);
    expect(
      events.some((event) => event.kind === "failed" && event.failure.category === "unsupported"),
    ).toBe(true);
  });

  it.each([
    ["plan", "edit", "deny"],
    ["plan", "bash", "deny"],
    ["plan", "task", "deny"],
    ["plan", "shell", "deny"],
    ["plan", "subagent", "deny"],
    ["plan", "external_directory", "deny"],
    ["plan", "todowrite", "allow"],
    ["plan", "todoread", "allow"],
    ["plan", "codesearch", "allow"],
    ["plan", "lsp", "allow"],
    ["plan", "list", "allow"],
    ["plan", "webfetch", "allow"],
    ["plan", "websearch", "allow"],
    ["plan", "read", "allow"],
    ["approval-gated", "read", "allow"],
    ["approval-gated", "list", "allow"],
    ["approval-gated", "edit", "ask"],
    ["approval-gated", "bash", "ask"],
    ["approval-gated", "shell", "ask"],
    ["approval-gated", "task", "allow"],
    ["approval-gated", "subagent", "allow"],
    ["auto-accept-edits", "subagent", "allow"],
    ["approval-gated", "external_directory", "ask"],
    ["auto-accept-edits", "edit", "allow"],
    ["auto-accept-edits", "bash", "ask"],
    ["auto-accept-edits", "external_directory", "ask"],
    ["full-access", "edit", "allow"],
    ["full-access", "bash", "allow"],
    ["full-access", "external_directory", "allow"],
  ] as const)("maps 2.x agent permission rules for %s %s as %s", (policy, action, effect) => {
    const rules = betaAgentPermissionRules(policy, "code");
    expect(evaluateV2Permission(rules, action)).toBe(effect);
  });

  it("reads a Project file without asking at Guarded and in Plan and still refuses a protected file", () => {
    const projectFile = "/work/project/src/index.ts";
    const key = join(homedir(), ".ssh", "id_ed25519");
    const credentials = join(homedir(), ".aws", "credentials");
    const protectedPaths = {
      belowFullAccess: [join(homedir(), ".ssh"), credentials],
      atFullAccess: [],
    };
    for (const policy of ["approval-gated", "plan"] as const) {
      const legacy = permissionRules(
        policy,
        "code",
        undefined,
        [],
        false,
        undefined,
        protectedPaths,
      ).map((rule) => ({
        action: rule.permission,
        resource: rule.pattern,
        effect: rule.action,
      }));
      const beta = betaAgentPermissionRules(policy, "code", [], [], protectedPaths);
      for (const rules of [legacy, beta]) {
        expect(lastMatch(rules, "read", projectFile), policy).toBe("allow");
        expect(lastMatch(rules, "grep", "TODO"), policy).toBe("allow");
        expect(lastMatch(rules, "read", key), policy).toBe("deny");
        expect(lastMatch(rules, "read", credentials), policy).toBe("deny");
        expect(lastMatch(rules, "list", join(homedir(), ".ssh")), policy).toBe("deny");
        // OpenCode's own `.env` refusal is kept under the read allow.
        expect(lastMatch(rules, "read", "/work/project/.env"), policy).toBe("deny");
        expect(lastMatch(rules, "read", "/work/project/.env.example"), policy).toBe("allow");
        // Below Full access an outside folder asks; Plan cannot approve, so it refuses.
        expect(lastMatch(rules, "external_directory", "/elsewhere/a.ts"), policy).toBe(
          policy === "plan" ? "deny" : "ask",
        );
      }
    }
  });

  it("keeps a person's own read deny of an env example over OpenCode's exception and protected files last", () => {
    const own = {
      rules: [
        { action: "read", resource: "*", effect: "allow" },
        { action: "read", resource: "*.env.example", effect: "deny" },
      ],
      toolServers: false,
      webTools: true,
    } as const;
    const key = join(homedir(), ".ssh", "id_ed25519");
    const protectedPaths = { belowFullAccess: [join(homedir(), ".ssh")], atFullAccess: [] };
    for (const policy of ["approval-gated", "plan"] as const) {
      const legacy = permissionRules(policy, "code", undefined, [], false, own, protectedPaths).map(
        (rule) => ({ action: rule.permission, resource: rule.pattern, effect: rule.action }),
      );
      const beta = betaAgentPermissionRules(policy, "code", [], own.rules, protectedPaths);
      for (const rules of [legacy, beta]) {
        expect(lastMatch(rules, "read", "/work/project/.env.example"), policy).toBe("deny");
        // The person's own allow-everything never reopens a protected file.
        expect(lastMatch(rules, "read", key), policy).toBe("deny");
      }
    }
  });

  it("keeps a person's own web-fetch deny in Plan while Plan's edits stay denied over their allow", () => {
    const own = {
      rules: [
        { action: "webfetch", resource: "*", effect: "deny" },
        { action: "edit", resource: "*", effect: "allow" },
      ],
      toolServers: false,
      webTools: true,
    } as const;
    const legacy = permissionRules("plan", "code", undefined, [], false, own);
    expect(evaluatePermission(legacy, "webfetch")).toBe("deny");
    expect(evaluatePermission(legacy, "websearch")).toBe("allow");
    expect(evaluatePermission(legacy, "edit")).toBe("deny");
    const beta = betaAgentPermissionRules("plan", "code", [], own.rules);
    expect(evaluateV2Permission(beta, "webfetch")).toBe("deny");
    expect(evaluateV2Permission(beta, "edit")).toBe("deny");
  });

  it("asks in Plan for the tools of a server the person marked and keeps every other server's tools denied", () => {
    const own = {
      rules: [],
      toolServers: false,
      planServers: ["docs-search"],
      webTools: true,
    } as const;
    const legacy = permissionRules("plan", "code", undefined, [], false, own);
    expect(evaluatePermission(legacy, "docs-search_query")).toBe("ask");
    expect(evaluatePermission(legacy, "writer_save")).toBe("deny");
    const beta = betaSessionPermissionRules("plan", "code", undefined, [], false, own);
    expect(evaluateV2Permission(beta, "docs-search_query")).toBe("ask");
    expect(evaluateV2Permission(beta, "writer_save")).toBe("deny");
    // With nothing marked, every server stays withheld as before.
    const unmarked = betaSessionPermissionRules("plan", "code", undefined, [], false, {
      ...own,
      planServers: [],
    });
    expect(evaluateV2Permission(unmarked, "docs-search_query")).toBe("deny");
  });

  it("lets a session reach a Project's extra folder, asks for every other outside folder, and denies them in Plan", () => {
    for (const policy of ["plan", "approval-gated", "auto-accept-edits"] as const) {
      const outsideRule = policy === "plan" ? "deny" : "ask";
      const beta = betaAgentPermissionRules(policy, "code", ["/work/notes"]);
      const allowed = beta.filter(
        (rule) => rule.action === "external_directory" && rule.effect === "allow",
      );
      expect(allowed.map((rule) => rule.resource)).toEqual(["/work/notes", "/work/notes/*"]);
      // The rule for every other outside path comes first, so only the folder
      // is reopened; the posture's edit rule is unchanged.
      const otherIndex = beta.findIndex(
        (rule) =>
          rule.action === "external_directory" &&
          rule.resource === "*" &&
          rule.effect === outsideRule,
      );
      expect(otherIndex).toBeGreaterThanOrEqual(0);
      expect(otherIndex).toBeLessThan(beta.indexOf(allowed[0]!));
      expect(evaluateV2Permission(beta, "edit")).toBe(
        evaluateV2Permission(betaAgentPermissionRules(policy, "code"), "edit"),
      );
      const legacy = permissionRules(policy, "code", undefined, ["/work/notes"]);
      expect(
        legacy.filter((rule) => rule.permission === "external_directory").map((rule) => rule),
      ).toEqual([
        { permission: "external_directory", pattern: "*", action: outsideRule },
        { permission: "external_directory", pattern: "/work/notes", action: "allow" },
        { permission: "external_directory", pattern: "/work/notes/*", action: "allow" },
      ]);
    }
  });

  it("denies OpenCode's own web search and fetch at every level unless the setup has web tools on", () => {
    const allowedOwn = {
      rules: [
        { action: "websearch", resource: "*", effect: "allow" },
        { action: "webfetch", resource: "*", effect: "allow" },
      ],
      toolServers: false,
    } as const;
    for (const policy of ["plan", "approval-gated", "auto-accept-edits", "full-access"] as const) {
      for (const action of ["websearch", "webfetch"]) {
        // Off: denied on both runtimes, the person's own allow included.
        expect(
          evaluatePermission(
            permissionRules(policy, "code", undefined, [], false, {
              ...allowedOwn,
              webTools: false,
            }),
            action,
          ),
        ).toBe("deny");
        expect(evaluatePermission(permissionRules(policy, "code"), action)).toBe("deny");
        expect(
          evaluateV2Permission(
            betaSessionPermissionRules(policy, "code", undefined, [], false, {
              ...allowedOwn,
              webTools: false,
            }),
            action,
          ),
        ).toBe("deny");
        expect(evaluateV2Permission(betaSessionPermissionRules(policy, "code"), action)).toBe(
          "deny",
        );
      }
    }
    // On, Full access lets them run as the level allows, and Plan allows them
    // as it allows every other read.
    const on = { rules: [], toolServers: false, webTools: true } as const;
    expect(
      evaluatePermission(
        permissionRules("full-access", "code", undefined, [], false, on),
        "websearch",
      ),
    ).toBe("allow");
    expect(
      evaluateV2Permission(
        betaSessionPermissionRules("full-access", "code", undefined, [], false, on),
        "websearch",
      ),
    ).toBe("allow");
    expect(
      evaluateV2Permission(
        betaSessionPermissionRules("plan", "code", undefined, [], false, on),
        "websearch",
      ),
    ).toBe("allow");
  });

  it("asks for a folder outside the Project at Guarded, reaches it at Full access, refuses it in Plan, and still refuses a protected file there below Full access", () => {
    const outside = "/elsewhere/notes/a.ts";
    const key = join(homedir(), ".ssh", "id_ed25519");
    const signIn = join(homedir(), ".codex", "auth.json");
    const protectedPaths = {
      belowFullAccess: [join(homedir(), ".ssh"), signIn],
      atFullAccess: [signIn],
    };
    const rulesFor = (policy: "full-access" | "approval-gated" | "plan") => [
      permissionRules(
        policy,
        "code",
        undefined,
        ["/work/notes"],
        false,
        undefined,
        protectedPaths,
      ).map((rule) => ({
        action: rule.permission,
        resource: rule.pattern,
        effect: rule.action,
      })),
      betaAgentPermissionRules(policy, "code", ["/work/notes"], [], protectedPaths),
    ];
    for (const rules of rulesFor("full-access")) {
      expect(lastMatch(rules, "external_directory", outside)).toBe("allow");
      expect(lastMatch(rules, "read", signIn)).toBe("deny");
    }
    for (const rules of rulesFor("approval-gated")) {
      expect(lastMatch(rules, "external_directory", outside)).toBe("ask");
      // A protected file outside the Project is refused, not asked.
      expect(lastMatch(rules, "read", key)).toBe("deny");
      // The Project's extra folder stays reachable below Full access.
      expect(lastMatch(rules, "external_directory", "/work/notes/todo.md")).toBe("allow");
    }
    for (const rules of rulesFor("plan")) {
      expect(lastMatch(rules, "external_directory", outside)).toBe("deny");
    }
  });

  it("refuses only provider sign-ins at Full access and every protected file below it, the person's own deny still over the env exception", () => {
    const cloud = join(homedir(), ".aws", "credentials");
    const added = "/opt/vault/token";
    const codexSignIn = join(homedir(), ".codex", "auth.json");
    const claudeSignIn = join(homedir(), ".claude", ".credentials.json");
    // The host resolves both lists; the driver only chooses one by level.
    const protectedPaths = {
      belowFullAccess: [cloud, added, codexSignIn, claudeSignIn],
      atFullAccess: [codexSignIn, claudeSignIn],
    };
    const own = {
      rules: [{ action: "read", resource: "*.env.example", effect: "deny" }],
      toolServers: false,
      webTools: true,
    } as const;
    const rulesFor = (policy: "full-access" | "approval-gated" | "auto-accept-edits" | "plan") => [
      permissionRules(policy, "code", undefined, [], false, own, protectedPaths).map((rule) => ({
        action: rule.permission,
        resource: rule.pattern,
        effect: rule.action,
      })),
      betaAgentPermissionRules(policy, "code", [], own.rules, protectedPaths),
    ];
    for (const rules of rulesFor("full-access")) {
      expect(lastMatch(rules, "read", cloud)).toBe("allow");
      expect(lastMatch(rules, "list", added)).toBe("allow");
      expect(lastMatch(rules, "read", codexSignIn)).toBe("deny");
      expect(lastMatch(rules, "read", claudeSignIn)).toBe("deny");
      expect(lastMatch(rules, "read", "/work/project/.env.example")).toBe("deny");
      // Provider sign-ins stay the last rules, so no allow reopens them.
      expect(rules.at(-1)).toEqual({
        action: "list",
        resource: `${claudeSignIn}/*`,
        effect: "deny",
      });
    }
    for (const policy of ["approval-gated", "auto-accept-edits", "plan"] as const) {
      for (const rules of rulesFor(policy)) {
        expect(lastMatch(rules, "read", cloud), policy).toBe("deny");
        expect(lastMatch(rules, "list", added), policy).toBe("deny");
        expect(lastMatch(rules, "read", codexSignIn), policy).toBe("deny");
      }
    }
  });

  it.each([
    ["allows", false, "allow"],
    ["refuses", true, "deny"],
  ] as const)(
    "%s OpenCode's own read of a protected file below Full access when Strict is %s, and always refuses another provider's sign-in",
    async (_verb, strict, cloudRead) => {
      const cloud = join(homedir(), ".aws", "credentials");
      const codexSignIn = join(homedir(), ".codex", "auth.json");
      const fixture = driverFixture({
        protectedPaths: { belowFullAccess: [cloud, codexSignIn], atFullAccess: [codexSignIn] },
      });
      await Effect.runPromise(
        Effect.scoped(
          fixture.driver
            .acquire({ instanceId, projectRoot: "/tmp/project" })
            .pipe(
              Effect.flatMap((connection) =>
                connection.start({ sessionId, modelId, executionPolicy: "approval-gated", strict }),
              ),
            ),
        ),
      );
      const rules = fixture.createdPermissions[0]!.map((rule) => ({
        action: rule.permission,
        resource: rule.pattern,
        effect: rule.action,
      }));
      expect(lastMatch(rules, "read", cloud)).toBe(cloudRead);
      expect(lastMatch(rules, "read", codexSignIn)).toBe("deny");
      expect(fixture.processInputs[0]?.strict).toBe(strict ? undefined : false);
    },
  );

  it("refuses a session outside Strict on an OpenCode process that started Strict", async () => {
    const fixture = driverFixture();
    const exit = await Effect.runPromiseExit(
      Effect.scoped(
        fixture.driver.acquire({ instanceId, projectRoot: "/tmp/project" }).pipe(
          Effect.flatMap((connection) =>
            connection.start({ sessionId, modelId, executionPolicy: "approval-gated" }).pipe(
              Effect.flatMap(() => connection.stop(sessionId)),
              Effect.flatMap(() =>
                connection.start({
                  sessionId: otherSessionId,
                  modelId,
                  executionPolicy: "approval-gated",
                  strict: false,
                }),
              ),
            ),
          ),
        ),
      ),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    expect(JSON.stringify(exit)).toContain("cannot be widened");
    expect(fixture.processInputs).toHaveLength(1);
  });

  it("gives 2.x Work mode the shell and child-agent rules Code mode gets at each level", () => {
    for (const policy of ["approval-gated", "auto-accept-edits", "full-access"] as const) {
      expect(betaAgentPermissionRules(policy, "work")).toEqual(
        betaAgentPermissionRules(policy, "code"),
      );
    }
    const rules = betaAgentPermissionRules("approval-gated", "work");
    expect(evaluateV2Permission(rules, "bash")).toBe("ask");
    expect(evaluateV2Permission(rules, "subagent")).toBe("allow");
  });

  it("keeps a person's own deny of OpenCode subagents over the unasked start outside Plan", () => {
    const own = [{ action: "task", resource: "*", effect: "deny" as const }];
    expect(
      evaluateV2Permission(betaAgentPermissionRules("approval-gated", "code", [], own), "task"),
    ).toBe("deny");
    expect(evaluateV2Permission(betaAgentPermissionRules("plan", "code"), "subagent")).toBe("deny");
  });

  it("launches a 2.x Code session with its posture and only its own app tool bridge allowed", async () => {
    const fixture = betaDriver();
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const connection = yield* fixture.driver.acquire({
            instanceId,
            projectRoot: "/tmp/project",
            mode: "code",
          });
          yield* connection.start({
            sessionId,
            modelId,
            executionPolicy: "approval-gated",
            tools: [{ name: "octant_browser", inputSchema: { type: "object" } }],
          });
        }),
      ),
    );
    const launched = fixture.processInputs.at(-1)?.betaPermissions;
    expect(launched).toBeDefined();
    const rules = [...(launched ?? [])];
    const bridge = fixture.calls.find((call) => call.startsWith("mcp.add:"))?.slice(8);
    expect(bridge).toBeDefined();
    expect(evaluateV2Permission(rules, "edit")).toBe("ask");
    expect(evaluateV2Permission(rules, "shell")).toBe("ask");
    expect(evaluateV2Permission(rules, "external_directory")).toBe("ask");
    expect(evaluateV2Permission(rules, "skill")).toBe("deny");
    expect(evaluateV2Permission(rules, "question")).toBe("allow");
    expect(evaluateV2Permission(rules, "other-server_tool")).toBe("deny");
    expect(evaluateV2Permission(rules, `${bridge}_octant_browser`)).toBe("allow");
  });

  it.each([
    ["opencode v2.0.21", "deny"],
    ["opencode v2.0.22", "allow"],
    ["opencode v2.2.0", "allow"],
  ] as const)(
    "lets %s's question tool ask only from the first release whose question forms were read (%s)",
    (version, effect) => {
      for (const policy of ["plan", "approval-gated", "full-access"] as const) {
        const rules = betaPermissionsForRelease(
          betaSessionPermissionRules(policy, "code"),
          version,
        );
        expect(evaluateV2Permission([...rules], "question")).toBe(effect);
        // Nothing but the question rule follows the release.
        expect(evaluateV2Permission([...rules], "edit")).toBe(
          evaluateV2Permission([...betaSessionPermissionRules(policy, "code")], "edit"),
        );
      }
    },
  );

  it("fails a turn on a release before 2.0.22 when a question form arrives anyway, and asks nobody", async () => {
    const fixture = driverFixture({
      process: {
        start: () =>
          Effect.acquireRelease(
            Effect.succeed({
              isolatedConfiguration: true as const,
              authorization: "Basic redacted",
              pid: process.pid,
              runtime: "beta" as const,
              version: "opencode v2.0.21",
              temporaryDirectory: launchScratchDirectory(),
              url: new URL("http://127.0.0.1:1/"),
            }),
            () => Effect.void,
          ),
      },
      events: [
        {
          type: "form.created",
          properties: {
            form: {
              id: "frm_old",
              sessionID: "provider-session",
              title: "Questions",
              metadata: { kind: "question" },
              fields: [
                {
                  key: "q0",
                  title: "Continue",
                  description: "Continue?",
                  type: "string",
                  options: [{ value: "Yes", label: "Yes", description: "Continue" }],
                },
              ],
            },
          },
        } as unknown as Event,
      ],
    });
    const output = await Effect.runPromise(
      Effect.scoped(
        fixture.driver.acquire({ instanceId, projectRoot: "/tmp/project", mode: "code" }).pipe(
          Effect.flatMap((connection) =>
            Effect.gen(function* () {
              const stream = yield* connection.subscribe;
              const collector = yield* Effect.fork(
                Stream.runCollect(
                  stream.pipe(
                    Stream.takeUntil((event) =>
                      ["completed", "failed", "interrupted"].includes(event.kind),
                    ),
                  ),
                ),
              );
              yield* connection.start({ sessionId, modelId, executionPolicy: "approval-gated" });
              return yield* Fiber.join(collector);
            }),
          ),
        ),
      ),
    );
    const events = Array.from(output);
    expect(events.some((event) => event.kind === "user-input-request")).toBe(false);
    expect(
      events.some((event) => event.kind === "failed" && event.failure.category === "unsupported"),
    ).toBe(true);
  });

  it("launches with OpenCode's own skills only for a session that carries the person's setup", async () => {
    const launch = async (nativeSetup: boolean) => {
      const fixture = betaDriver();
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const connection = yield* fixture.driver.acquire({
              instanceId,
              projectRoot: "/tmp/project",
              mode: "code",
            });
            yield* connection.start({
              sessionId,
              modelId,
              executionPolicy: "approval-gated",
              ...(nativeSetup
                ? {
                    nativeSetup: {
                      subagents: true,
                      webTools: true,
                      skills: true,
                      toolServers: true,
                      hooks: true,
                      projectCode: false,
                    },
                  }
                : {}),
            });
          }),
        ),
      );
      return fixture.processInputs.at(-1);
    };
    const own = await launch(true);
    expect(own?.ownSkills).toBe(true);
    // Running as itself, 1.x also finds the person's global AGENTS.md.
    expect(own?.runsAsItself).toBe(true);
    expect(evaluateV2Permission([...(own?.betaPermissions ?? [])], "skill")).toBe("ask");
    // The person's tool servers follow the level, and shell still asks.
    expect(evaluateV2Permission([...(own?.betaPermissions ?? [])], "other-server_tool")).toBe(
      "ask",
    );
    expect(evaluateV2Permission([...(own?.betaPermissions ?? [])], "shell")).toBe("ask");

    const locked = await launch(false);
    expect(locked).not.toHaveProperty("ownSkills");
    expect(locked).not.toHaveProperty("runsAsItself");
    expect(evaluateV2Permission([...(locked?.betaPermissions ?? [])], "skill")).toBe("deny");
  });

  it("applies the person's own rules over the level and under Plan's denials, and loads their tool servers", async () => {
    const own: OpenCodeOwnSetup = {
      rules: [
        { action: "bash", resource: "git status", effect: "allow" },
        { action: "shell", resource: "*", effect: "allow" },
        { action: "edit", resource: "*", effect: "allow" },
      ],
      mcp: { docs: { type: "local", command: ["docs-server"] } },
    };
    const launch = async (executionPolicy: "approval-gated" | "plan", toolServers: boolean) => {
      const fixture = betaDriver({ readOwnSetup: () => own });
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const connection = yield* fixture.driver.acquire({
              instanceId,
              projectRoot: "/tmp/project",
              mode: "code",
            });
            yield* connection.start({
              sessionId,
              modelId,
              executionPolicy,
              nativeSetup: {
                subagents: true,
                webTools: true,
                skills: true,
                toolServers,
                hooks: false,
                projectCode: false,
              },
            });
          }),
        ),
      );
      return fixture.processInputs.at(-1);
    };
    const gated = await launch("approval-gated", true);
    const gatedRules = [...(gated?.betaPermissions ?? [])];
    expect(evaluateV2Permission(gatedRules, "shell")).toBe("allow");
    expect(evaluateV2Permission(gatedRules, "edit")).toBe("allow");
    expect(evaluateV2Permission(gatedRules, "external_directory")).toBe("ask");
    expect(gated?.ownToolServers).toEqual(own.mcp);

    const plan = await launch("plan", false);
    const planRules = [...(plan?.betaPermissions ?? [])];
    expect(evaluateV2Permission(planRules, "shell")).toBe("deny");
    expect(evaluateV2Permission(planRules, "edit")).toBe("deny");
    expect(evaluateV2Permission(planRules, "other-server_tool")).toBe("deny");
    expect(plan).not.toHaveProperty("ownToolServers");
  });

  it("lets OpenCode load a trusted Project's own configuration outside Plan, and keeps it off while untrusted or in Plan", async () => {
    const launch = async (executionPolicy: "approval-gated" | "plan", projectCode: boolean) => {
      const fixture = betaDriver({ readOwnSetup: () => NO_OPENCODE_OWN_SETUP });
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const connection = yield* fixture.driver.acquire({
              instanceId,
              projectRoot: "/tmp/project",
              mode: "code",
            });
            yield* connection.start({
              sessionId,
              modelId,
              executionPolicy,
              nativeSetup: {
                subagents: true,
                webTools: true,
                skills: true,
                toolServers: executionPolicy !== "plan",
                hooks: executionPolicy !== "plan",
                projectCode,
              },
            });
          }),
        ),
      );
      return fixture.processInputs.at(-1);
    };

    expect((await launch("approval-gated", true))?.projectConfig).toBe(true);
    expect(await launch("approval-gated", false)).not.toHaveProperty("projectConfig");
    expect(await launch("plan", false)).not.toHaveProperty("projectConfig");
  });

  it("keeps Plan's denials and the outside-folder refusal over a Project rule that allows them", () => {
    const own = {
      rules: [
        { action: "edit", resource: "*", effect: "allow" as const },
        { action: "shell", resource: "*", effect: "allow" as const },
      ],
      toolServers: false,
      webTools: true,
    };
    const plan = betaSessionPermissionRules("plan", "code", undefined, [], true, own);
    expect(evaluateV2Permission([...plan], "edit")).toBe("deny");
    expect(evaluateV2Permission([...plan], "shell")).toBe("deny");
    expect(evaluateV2Permission([...plan], "external_directory")).toBe("deny");
  });

  it("adapts a 2.x event from data when properties is not an object", () => {
    expect(
      adaptBetaOpenCodeEvent({
        type: "session.next.text.delta",
        properties: "not-an-object",
        data: {
          sessionID: "provider-session",
          messageID: "m",
          partID: "p",
          delta: "hello",
        },
      }),
    ).toEqual({
      type: "session.next.text.delta",
      properties: {
        sessionID: "provider-session",
        messageID: "m",
        partID: "p",
        delta: "hello",
      },
    });
  });
});

/** Calls one tool on a bridge's existing MCP session, as OpenCode would mid-turn. */
async function callBridgeTool(
  bridge: { readonly url: string; readonly session: string | null },
  name: string,
  meta: Readonly<Record<string, unknown>>,
): Promise<string> {
  const called = await fetch(bridge.url, {
    method: "POST",
    headers: {
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      ...(bridge.session === null ? {} : { "mcp-session-id": bridge.session }),
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name, arguments: {}, _meta: meta },
    }),
  });
  return called.text();
}

type FixtureCommands =
  | ReadonlyArray<{ readonly name: string; readonly description?: string }>
  | ((root: string) => ReadonlyArray<{ readonly name: string; readonly description?: string }>);

function commandsAt(
  commands: FixtureCommands | undefined,
  root: string,
): ReadonlyArray<{ readonly name: string; readonly description?: string }> {
  return typeof commands === "function" ? commands(root) : (commands ?? []);
}

function betaDriver(
  options: {
    readonly worktreeProviders?: "refused";
    readonly worktreeSessionCreate?: "refused";
    readonly sessionDelete?: "refused";
    readonly events?: ReadonlyArray<OpenCodeEvent>;
    readonly launchScratch?: "unreported";
    readonly permissionPersistence?: "project-default";
    readonly eventsOnReply?: ReadonlyArray<Event> | ((requestId: string) => ReadonlyArray<Event>);
    readonly readOwnSetup?: () => OpenCodeOwnSetup;
    readonly commands?: FixtureCommands;
    readonly commandFailure?: "context-queued";
  } = {},
) {
  const launchScratch = launchScratchDirectory();
  const processInputs: OpenCodeProcessStartInput[] = [];
  const fixture = driverFixture({
    ...options,
    process: {
      start: (input) =>
        Effect.acquireRelease(
          Effect.sync(() => {
            processInputs.push(input);
            return {
              isolatedConfiguration: true as const,
              authorization: "Basic redacted",
              pid: process.pid,
              runtime: "beta" as const,
              version: "opencode v2.0.22",
              ...(options.launchScratch === "unreported"
                ? {}
                : { temporaryDirectory: launchScratch }),
              url: new URL("http://127.0.0.1:1/"),
            };
          }),
          () => Effect.void,
        ),
    },
  });
  return { ...fixture, launchScratch, processInputs };
}

function launchScratchDirectory(): string {
  return realpathSync(mkdtempSync(join(tmpdir(), "octant-opencode-launch-")));
}

function driverFixture(
  options: {
    readonly isolatedConfiguration?: boolean;
    readonly process?: OpenCodeProcessPort;
    readonly events?: ReadonlyArray<OpenCodeEvent>;
    readonly permissionPersistence?:
      | "current-session"
      | "project-default"
      | (() => "current-session" | "project-default");
    readonly sessionDirectory?: string;
    readonly resumedSessionId?: string;
    readonly processFailure?: {
      readonly category: "invalid-configuration";
      readonly message: string;
    };
    readonly mcpSupported?: boolean;
    readonly streamEnd?: "hang" | "eof" | "throw";
    /** The confined server answers 500 for a directory inside a Git work tree. */
    readonly worktreeProviders?: "refused";
    /** The confined server refuses session create for a directory inside a Git work tree. */
    readonly worktreeSessionCreate?: "refused";
    /** The server refuses to delete a session. */
    readonly sessionDelete?: "refused";
    /** Streamed after an approval reply is sent and before that reply resolves. */
    readonly eventsOnReply?: ReadonlyArray<Event> | ((requestId: string) => ReadonlyArray<Event>);
    readonly readOwnSetup?: () => OpenCodeOwnSetup;
    /** The version a 2.x client reports: its process's, never a health route's. */
    readonly healthVersion?: string;
    /** OpenCode's own commands, as a runtime with the command routes lists them. */
    readonly commands?: FixtureCommands;
    /** The command route fails after the turn's context was queued. */
    readonly commandFailure?: "context-queued";
    readonly protectedPaths?: { belowFullAccess: string[]; atFullAccess: string[] };
  } = {},
) {
  const calls: string[] = [];
  const late = lateEvents();
  const catalogueRoots: string[] = [];
  const processInputs: OpenCodeProcessStartInput[] = [];
  const createdPermissions: PermissionRuleset[] = [];
  const mcpBridges: Array<{ readonly url: string; readonly session: string | null }> = [];
  const permissionReplies: string[] = [];
  const questionReplies: string[] = [];
  const registry = new ProviderRuntimeRegistry();
  const processPort = {
    start: (input: OpenCodeProcessStartInput) =>
      options.processFailure === undefined
        ? Effect.acquireRelease(
            Effect.sync(() => {
              calls.push("process.start");
              processInputs.push(input);
              return {
                ...(options.isolatedConfiguration === false
                  ? {}
                  : { isolatedConfiguration: true as const }),
                authorization: "Basic redacted",
                pid: process.pid,
                url: new URL("http://127.0.0.1:1/"),
              };
            }),
            () => Effect.void,
          )
        : Effect.fail(options.processFailure),
  };
  const session = providerSession(options.sessionDirectory ?? "/tmp/project");
  const sessionRoots: string[] = [];
  const promptModels: string[] = [];
  const client: OpenCodeClientPort = {
    health: async () => ({ healthy: true, version: options.healthVersion ?? "1.18.0" }),
    providers: async () => providerList(),
    subscribe: async (signal) => {
      calls.push("event.subscribe");
      return options.eventsOnReply === undefined
        ? asyncIterable(options.events ?? [], signal, options.streamEnd ?? "hang")
        : lateIterable(options.events ?? [], signal, late);
    },
    createSession: async ({ permission }) => {
      createdPermissions.push(permission);
      calls.push(`session.create:${permission[0]?.action}`);
      const root = sessionRoots[sessionRoots.length - 1];
      if (
        options.worktreeSessionCreate === "refused" &&
        root !== undefined &&
        existsSync(join(root, ".git"))
      ) {
        throw new Error("opencode server POST /api/session -> 500");
      }
      return session;
    },
    getSession: async () => ({ ...session, id: options.resumedSessionId ?? session.id }),
    prompt: async ({ providerId, modelId: promptModel }) => {
      calls.push("session.promptAsync");
      promptModels.push(`${providerId}/${promptModel}`);
    },
    addMcpServer: async ({ name, url }) => {
      if (options.mcpSupported === false) throw new Error("MCP transport is unavailable");
      calls.push(`mcp.add:${name}`);
      const initialize = await fetch(url, {
        method: "POST",
        headers: {
          accept: "application/json, text/event-stream",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: "probe-initialize",
          method: "initialize",
          params: {
            protocolVersion: "2025-06-18",
            capabilities: {},
            clientInfo: { name: "fixture", version: "1" },
          },
        }),
      });
      if (!initialize.ok) throw new Error("MCP initialize failed");
      const session = initialize.headers.get("mcp-session-id");
      mcpBridges.push({ url, session });
      const listed = await fetch(url, {
        method: "POST",
        headers: {
          accept: "application/json, text/event-stream",
          "content-type": "application/json",
          ...(session === null ? {} : { "mcp-session-id": session }),
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: "probe-tools",
          method: "tools/list",
          params: {},
        }),
      });
      if (!listed.ok) throw new Error("MCP tools/list failed");
    },
    disconnectMcpServer: async (name) => {
      calls.push(`mcp.disconnect:${name}`);
    },
    abort: async () => {
      calls.push("session.abort");
    },
    replyPermission: async (replySession, id, reply) => {
      calls.push(`permission.reply:${reply}`);
      permissionReplies.push(`${replySession}:${id}`);
      if (options.eventsOnReply === undefined) return;
      late.push(
        typeof options.eventsOnReply === "function"
          ? options.eventsOnReply(id)
          : options.eventsOnReply,
      );
      await new Promise<void>((resolve) => setTimeout(resolve, 20));
    },
    replyQuestion: async (replySession, id, answers) => {
      calls.push(`question.reply:${answers.join("|")}`);
      questionReplies.push(`${replySession}:${id}`);
    },
    deleteSession: async (id) => {
      calls.push(`session.delete:${id}`);
      if (options.sessionDelete === "refused") throw new Error("session delete -> 500");
    },
    ...(options.commands === undefined
      ? {}
      : {
          commands: async () => {
            calls.push("command.list");
            return commandsAt(options.commands, "/tmp/project");
          },
          command: async ({ name, arguments: text, context }) => {
            calls.push(`session.command:${name}:${text}:${context === undefined ? "" : "context"}`);
            if (options.commandFailure === "context-queued") {
              throw new OpenCodeCommandNotRun("OpenCode 2 command failed with status 500.", true);
            }
          },
        }),
  };
  return {
    calls,
    promptModels,
    catalogueRoots,
    sessionRoots,
    processInputs,
    createdPermissions,
    permissionReplies,
    questionReplies,
    mcpBridges,
    registry,
    driver: makeOpenCodeDriver({
      instanceId,
      binaryPath: "/opt/homebrew/bin/opencode",
      process: options.process ?? processPort,
      runtimeRegistry: registry,
      clientFactory: (runtime, root) => {
        sessionRoots.push(root);
        // Like the launch profile, which denies the host temporary directory
        // beneath `/private`: a 2.x server cannot read a probe marker outside
        // its own scratch directory.
        const scratch = runtime.temporaryDirectory;
        const unreadable =
          runtime.runtime === "beta" &&
          root.includes("octant-opencode-probe-") &&
          (scratch === undefined || !root.startsWith(`${scratch}/`));
        return {
          ...client,
          ...(client.commands === undefined
            ? {}
            : {
                commands: async () => {
                  calls.push(`command.list:${root}`);
                  return commandsAt(options.commands, root);
                },
              }),
          providers: async () => {
            catalogueRoots.push(root);
            if (options.worktreeProviders === "refused" && existsSync(join(root, ".git"))) {
              throw new Error("opencode server GET /api/provider -> 500");
            }
            if (unreadable) throw new Error("opencode server GET /api/provider -> 500");
            return client.providers();
          },
          createSession: unreadable
            ? async () => {
                throw new Error("opencode server POST /api/session -> 500");
              }
            : client.createSession,
        };
      },
      ...(options.readOwnSetup === undefined ? {} : { readOwnSetup: options.readOwnSetup }),
      ...(options.protectedPaths === undefined
        ? {}
        : {
            protectedPaths: () =>
              options.protectedPaths ?? { belowFullAccess: [], atFullAccess: [] },
          }),
      permissionPersistence: () =>
        typeof options.permissionPersistence === "function"
          ? options.permissionPersistence()
          : (options.permissionPersistence ?? "current-session"),
      clock: () => now,
      correlationId: () => "80000000-0000-4000-8000-000000000103",
      idleLeaseMs: 0,
    }),
  };
}

function providerList() {
  const model = {
    id: "claude-sonnet",
    providerID: "anthropic",
    name: "Claude Sonnet",
    api: { id: "x", url: "https://example.invalid", npm: "x" },
    capabilities: {
      temperature: true,
      reasoning: true,
      attachment: true,
      toolcall: true,
      input: { text: true, audio: false, image: true, video: false, pdf: true },
      output: { text: true, audio: false, image: false, video: false, pdf: false },
      interleaved: true,
    },
    cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
    limit: { context: 200000, output: 8192 },
    status: "active",
    options: {},
    headers: {},
    release_date: "2026-01-01",
    variants: { low: {}, high: {} },
  } as const;
  const provider: Provider = {
    id: "anthropic",
    name: "Anthropic",
    source: "config",
    env: [],
    options: {},
    models: { [model.id]: model },
  };
  return { all: [provider], connected: ["anthropic"] };
}

function providerSession(directory: string): Session {
  return {
    id: "provider-session",
    slug: "s",
    projectID: "p",
    directory,
    title: "t",
    version: "1",
    time: { created: 1, updated: 1 },
  };
}
function lateEvents() {
  const queued: Event[] = [];
  let wake: (() => void) | undefined;
  return {
    push: (events: ReadonlyArray<Event>) => {
      queued.push(...events);
      wake?.();
    },
    take: () => queued.splice(0),
    next: () => new Promise<void>((resolve) => (wake = resolve)),
  };
}

async function* lateIterable(
  events: ReadonlyArray<OpenCodeEvent>,
  signal: AbortSignal,
  late: ReturnType<typeof lateEvents>,
) {
  for (const event of events) yield event;
  const aborted = new Promise<void>((resolve) =>
    signal.addEventListener("abort", () => resolve(), { once: true }),
  );
  while (!signal.aborted) {
    for (const event of late.take()) yield event;
    await Promise.race([late.next(), aborted]);
  }
}

async function* asyncIterable(
  events: ReadonlyArray<OpenCodeEvent>,
  signal: AbortSignal,
  streamEnd: "hang" | "eof" | "throw",
) {
  for (const event of events) yield event;
  if (streamEnd !== "hang") {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  if (streamEnd === "throw") throw new Error("private stream detail");
  if (streamEnd === "eof") return;
  await new Promise<void>((resolve) =>
    signal.addEventListener("abort", () => resolve(), { once: true }),
  );
}

function evaluatePermission(rules: PermissionRuleset, permission: string): string | undefined {
  let action: string | undefined;
  for (const rule of rules) {
    const pattern = new RegExp(
      `^${rule.permission
        .split("*")
        .map((part) => part.replace(/[\\^$.*+?()[\]{}|]/g, "\\\\$&"))
        .join(".*")}$`,
    );
    if (pattern.test(permission) && rule.pattern === "*") {
      action = rule.action;
    }
  }
  return action;
}

/** OpenCode's last-match rule over action and resource, `*` matching anything. */
function lastMatch(
  rules: ReadonlyArray<{
    readonly action: string;
    readonly resource: string;
    readonly effect: string;
  }>,
  action: string,
  resource: string,
): string | undefined {
  const matches = (pattern: string, value: string) =>
    new RegExp(
      `^${pattern
        .split("*")
        .map((part) => part.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&"))
        .join(".*")}$`,
    ).test(value);
  let effect: string | undefined;
  for (const rule of rules) {
    if (matches(rule.action, action) && matches(rule.resource, resource)) effect = rule.effect;
  }
  return effect;
}

function evaluateV2Permission(
  rules: PermissionV2Ruleset,
  action: string,
): "allow" | "deny" | "ask" | undefined {
  return betaPermissionEffect(rules, action);
}
function textEvent(id: string, delta: string): Event {
  return {
    type: "session.next.text.delta",
    properties: { id: "e", sessionID: id, messageID: "m", partID: "p", delta },
  } as unknown as Event;
}
function todoEvent(id: string, contents: ReadonlyArray<string>): Event {
  return {
    type: "todo.updated",
    properties: {
      sessionID: id,
      todos: contents.map((content) => ({ content, status: "pending", priority: "medium" })),
    },
  } as Event;
}
function idleEvent(id: string): Event {
  return { type: "session.idle", properties: { sessionID: id } } as Event;
}
function stepEndedEvent(
  sessionID: string,
  assistantMessageID: string,
  usage: {
    readonly input: number;
    readonly output: number;
    readonly reasoning: number;
    readonly cache: { readonly read: number; readonly write: number };
    readonly cost: number;
  },
): Event {
  return {
    id: `step-ended-${assistantMessageID}`,
    type: "session.next.step.ended",
    properties: {
      timestamp: 1,
      sessionID,
      assistantMessageID,
      finish: "stop",
      cost: usage.cost,
      tokens: {
        input: usage.input,
        output: usage.output,
        reasoning: usage.reasoning,
        cache: usage.cache,
      },
    },
  };
}
function permissionEvent(id: string, requestId: string): Event {
  return {
    type: "permission.asked",
    properties: {
      id: requestId,
      sessionID: id,
      permission: "edit",
      patterns: ["*"],
      metadata: {},
      always: [],
    },
  } as unknown as Event;
}
function questionV2Event(
  id: string,
  requestId: string,
  questions: ReadonlyArray<{
    readonly question: string;
    readonly options: ReadonlyArray<{ readonly label: string; readonly description?: string }>;
  }>,
): Event {
  return {
    type: "question.v2.asked",
    properties: { id: requestId, sessionID: id, questions },
  } as unknown as Event;
}
