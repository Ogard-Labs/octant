import {
  decodeProviderInstanceId,
  type ProviderModelId,
  type ProviderResumeCursor,
  decodeProviderSessionId,
} from "@octant/contracts";
import type { Event, PermissionRuleset, Provider, Session } from "@opencode-ai/sdk/v2/types";
import { spawn } from "node:child_process";
import { Effect, Fiber, Stream } from "effect";
import { describe, expect, it } from "vitest";
import {
  makeOpenCodeDriver,
  normalizeOpenCodeProbe,
  openCodePromptParts,
  type OpenCodeClientPort,
} from "./openCodeDriver";
import { ProviderRuntimeRegistry } from "./providerRuntimeRegistry";
import type { OpenCodeProcessPort, OpenCodeProcessStartInput } from "./openCodeProcess";

const instanceId = decodeProviderInstanceId("80000000-0000-4000-8000-000000000101");
const sessionId = decodeProviderSessionId("80000000-0000-4000-8000-000000000102");
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

  it("proves MCP declaration support through a confined loopback probe lease", async () => {
    const fixture = driverFixture();
    const probe = await Effect.runPromise(Effect.scoped(fixture.driver.probe({ instanceId })));
    if (process.platform === "darwin") {
      expect(probe.capabilities.appManagedTools).toBe("supported");
      expect(fixture.processInputs[0]).toMatchObject({
        mode: "chat",
        executionPolicy: "plan",
        loopbackPorts: [expect.any(Number)],
      });
      expect(fixture.calls.some((call) => call.startsWith("mcp.add:"))).toBe(true);
      expect(fixture.calls.some((call) => call.startsWith("mcp.disconnect:"))).toBe(true);
    } else {
      expect(probe.capabilities.appManagedTools).toBe("unsupported");
      expect(fixture.processInputs[0]).toMatchObject({
        mode: "chat",
        executionPolicy: "plan",
      });
      expect(fixture.processInputs[0]?.loopbackPorts).toBeUndefined();
      expect(fixture.calls.some((call) => call.startsWith("mcp.add:"))).toBe(false);
    }
  });

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

  it("interrupts a live session when its dedicated provider process exits", async () => {
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
            child.kill("SIGKILL");
            const output = yield* Fiber.join(collector).pipe(Effect.timeout("2 seconds"));
            expect(fixture.registry.activeSessionCount(instanceId)).toBe(0);
            return output;
          }),
        ),
      );
      expect(Array.from(events)).toMatchObject([
        { kind: "interrupted", message: "Provider runtime exited unexpectedly." },
      ]);
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
    ["full-access", "external_directory", "deny"],
    ["approval-gated", "edit", "ask"],
    ["approval-gated", "bash", "ask"],
    ["approval-gated", "task", "ask"],
    ["approval-gated", "todowrite", "ask"],
    ["approval-gated", "external_directory", "deny"],
    ["plan", "read", "ask"],
    ["plan", "edit", "deny"],
    ["plan", "bash", "deny"],
    ["plan", "task", "deny"],
    ["plan", "external_directory", "deny"],
    ["plan", "todowrite", "deny"],
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
    for (const permission of ["edit", "bash", "task", "external_directory", "todowrite"]) {
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
});

function driverFixture(
  options: {
    readonly isolatedConfiguration?: boolean;
    readonly process?: OpenCodeProcessPort;
    readonly events?: ReadonlyArray<Event>;
    readonly permissionPersistence?:
      | "current-session"
      | "project-default"
      | (() => "current-session" | "project-default");
    readonly sessionDirectory?: string;
    readonly processFailure?: {
      readonly category: "invalid-configuration";
      readonly message: string;
    };
    readonly mcpSupported?: boolean;
    readonly streamEnd?: "hang" | "eof" | "throw";
  } = {},
) {
  const calls: string[] = [];
  const processInputs: OpenCodeProcessStartInput[] = [];
  const createdPermissions: PermissionRuleset[] = [];
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
  const client: OpenCodeClientPort = {
    health: async () => ({ healthy: true, version: "1.18.0" }),
    providers: async () => providerList(),
    subscribe: async (signal) => {
      calls.push("event.subscribe");
      return asyncIterable(options.events ?? [], signal, options.streamEnd ?? "hang");
    },
    createSession: async ({ permission }) => {
      createdPermissions.push(permission);
      calls.push(`session.create:${permission[0]?.action}`);
      return session;
    },
    getSession: async () => session,
    prompt: async () => {
      calls.push("session.promptAsync");
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
    replyPermission: async (_id, reply) => {
      calls.push(`permission.reply:${reply}`);
    },
    replyQuestion: async () => undefined,
  };
  return {
    calls,
    processInputs,
    createdPermissions,
    registry,
    driver: makeOpenCodeDriver({
      instanceId,
      binaryPath: "/opt/homebrew/bin/opencode",
      process: options.process ?? processPort,
      runtimeRegistry: registry,
      clientFactory: () => client,
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
async function* asyncIterable(
  events: ReadonlyArray<Event>,
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
