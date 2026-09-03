import type { ProviderFailure } from "@octant/contracts";
import { Chunk, Effect, Stream } from "effect";
import { describe, expect, test, vi } from "vitest";

import {
  makeClaudeAgentSdkPort,
  type ClaudeAgentSdkBridge,
  type ClaudeAgentSdkQueryInvocation,
  type ClaudeAgentSdkQueryLike,
} from "./claudeAgentSdkPort";

const initialization = {
  commands: [],
  agents: [],
  output_style: "default",
  available_output_styles: ["default"],
  models: [
    {
      value: "claude-sonnet",
      resolvedModel: "claude-sonnet-4-5",
      displayName: "Sonnet",
      description: "Balanced",
      supportsEffort: true,
      supportedEffortLevels: ["low", "high"],
    },
  ],
  account: {
    email: "secret@example.com",
    organization: "private-org",
    subscriptionType: "pro",
    tokenSource: "oauth",
    apiProvider: "firstParty",
  },
} as const;

class FakeQuery implements ClaudeAgentSdkQueryLike {
  readonly interrupt = vi.fn(
    async (): Promise<{ still_queued: string[] } | undefined> => ({ still_queued: [] }),
  );
  readonly setPermissionMode = vi.fn(async () => undefined);
  readonly initializationResult = vi.fn(async () => initialization);
  readonly supportedModels = vi.fn(async () => initialization.models);
  readonly accountInfo = vi.fn(async () => initialization.account);
  readonly close = vi.fn(() => undefined);

  constructor(private readonly output: readonly unknown[]) {}

  async *[Symbol.asyncIterator](): AsyncIterator<unknown> {
    yield* this.output;
  }
}

const safeRuntimeInitialization = {
  type: "system",
  subtype: "init",
  agents: [],
  apiKeySource: "temporary",
  claude_code_version: "2.1.211",
  cwd: "/repo",
  tools: ["Read", "Grep", "Glob"],
  mcp_servers: [],
  model: "claude-sonnet",
  permissionMode: "default",
  slash_commands: [],
  output_style: "default",
  skills: [],
  plugins: [],
  capabilities: ["interrupt_receipt_v1"],
  uuid: "message-1",
  session_id: "session-1",
} as const;

function makeHarness(output: readonly unknown[] = [safeRuntimeInitialization]) {
  const query = new FakeQuery(output);
  let invocation: ClaudeAgentSdkQueryInvocation | undefined;
  const listSessions = vi.fn(async () => [
    {
      sessionId: "session-1",
      summary: "private prompt summary",
      lastModified: 123,
      cwd: "/repo",
      createdAt: 100,
    },
  ]);
  const sdk: ClaudeAgentSdkBridge = {
    query: (input) => {
      invocation = input;
      return query;
    },
    listSessions,
  };
  const spawnClaudeCodeProcess = vi.fn(() => {
    throw new Error("not called by fake SDK");
  });
  const port = makeClaudeAgentSdkPort({ sdk, spawnClaudeCodeProcess });
  return {
    get invocation() {
      return invocation;
    },
    listSessions,
    port,
    query,
    spawnClaudeCodeProcess,
  };
}

const openInput = {
  binaryPath: "/opt/homebrew/bin/claude",
  projectRoot: "/repo",
  authEnvironment: {
    PATH: "/usr/bin",
    ANTHROPIC_API_KEY: "never-serialize-me",
  },
  model: "claude-sonnet",
  executionPolicy: "approval-gated",
  resumeSessionId: "session-1",
  tools: ["Read", "Grep", "Glob"],
  sandbox: {
    enabled: true,
    failIfUnavailable: true,
    allowUnsandboxedCommands: false,
    autoAllowBashIfSandboxed: false,
    filesystem: {
      denyRead: ["/"],
      allowRead: ["/repo"],
      allowWrite: ["/repo"],
    },
  },
  canUseTool: async () => ({ behavior: "deny" as const, message: "Approval required." }),
  preToolUse: async () => ({ behavior: "allow" as const }),
} as const;

async function failureOf(effect: Effect.Effect<unknown, ProviderFailure>) {
  return Effect.runPromise(Effect.flip(effect));
}

async function collectMessages(output: readonly unknown[]) {
  const harness = makeHarness(output);
  const messages = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const query = yield* harness.port.openQuery(openInput);
        return yield* Stream.runCollect(query.messages);
      }),
    ),
  );
  return Chunk.toReadonlyArray(messages);
}

describe("Claude Agent SDK port", () => {
  test("constructs an isolated streaming query with exact root, executable, resume, policy, and tools", async () => {
    const harness = makeHarness();

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const query = yield* harness.port.openQuery(openInput);
          expect(query.initialization).toEqual({
            models: [
              {
                id: "claude-sonnet",
                resolvedId: "claude-sonnet-4-5",
                displayName: "Sonnet",
                description: "Balanced",
                supportsEffort: true,
                supportedEffortLevels: ["low", "high"],
              },
            ],
            account: { ready: true, apiProvider: "firstParty" },
          });

          expect(harness.invocation?.options).toMatchObject({
            cwd: "/repo",
            env: openInput.authEnvironment,
            model: "claude-sonnet",
            pathToClaudeCodeExecutable: "/opt/homebrew/bin/claude",
            resume: "session-1",
            permissionMode: "default",
            settingSources: [],
            skills: [],
            mcpServers: {},
            strictMcpConfig: true,
            additionalDirectories: [],
            tools: ["Read", "Grep", "Glob"],
            agents: {},
            plugins: [],
            includePartialMessages: true,
            sandbox: openInput.sandbox,
            spawnClaudeCodeProcess: harness.spawnClaudeCodeProcess,
          });
          expect(harness.invocation?.options).not.toHaveProperty("continue");
          expect(harness.invocation?.options).not.toHaveProperty("allowedTools");
          expect(harness.invocation?.options.allowDangerouslySkipPermissions).toBeUndefined();
          expect(harness.invocation?.options.canUseTool).toBeTypeOf("function");
          expect(harness.invocation?.options.hooks?.PreToolUse).toHaveLength(1);
        }),
      ),
    );

    expect(harness.query.initializationResult).toHaveBeenCalledOnce();
    expect(harness.query.close).toHaveBeenCalledOnce();
  });

  test("tolerates the runtime's built-in commands and agents and its chosen output style", async () => {
    const harness = makeHarness();
    harness.query.initializationResult.mockResolvedValueOnce({
      ...initialization,
      commands: [{ name: "compact", description: "Compact the conversation" }],
      agents: [{ name: "Explore", description: "Read-only search" }],
      output_style: "Explanatory",
      available_output_styles: ["default", "Explanatory"],
    } as never);

    await expect(
      Effect.runPromise(Effect.scoped(harness.port.openQuery(openInput))),
    ).resolves.toBeDefined();
    expect(harness.query.initializationResult).toHaveBeenCalledOnce();
  });

  test.each([
    [
      "a malformed commands field",
      { ...initialization, commands: "secret-command" },
      "Claude returned an invalid SDK response.",
      "secret-command",
    ],
    [
      "malformed available output styles",
      { ...initialization, available_output_styles: ["default", 7, "secret-style"] },
      "Claude returned an invalid SDK response.",
      "secret-style",
    ],
  ])(
    "rejects %s from the SDK initialization control",
    async (_name, candidate, message, secret) => {
      const harness = makeHarness();
      harness.query.initializationResult.mockResolvedValueOnce(candidate as never);

      const failed = await failureOf(Effect.scoped(harness.port.openQuery(openInput)));

      expect(failed).toEqual({ category: "protocol", message });
      expect(JSON.stringify(failed)).not.toContain(secret);
      expect(harness.query.close).toHaveBeenCalledOnce();
    },
  );

  test("accepts a structurally valid available output-style catalog without activating it", async () => {
    const harness = makeHarness();
    harness.query.initializationResult.mockResolvedValueOnce({
      ...initialization,
      available_output_styles: ["default", "concise"],
    } as never);

    await expect(
      Effect.runPromise(Effect.scoped(harness.port.openQuery(openInput))),
    ).resolves.toBeDefined();
    expect(harness.query.close).toHaveBeenCalledOnce();
  });

  test.each([
    ["a missing approval-gated sandbox", { ...openInput, sandbox: undefined }],
    [
      "a sandbox on Full access",
      { ...openInput, executionPolicy: "full-access", sandbox: openInput.sandbox },
    ],
    ["a sandbox on Plan", { ...openInput, executionPolicy: "plan", sandbox: openInput.sandbox }],
    [
      "a sandbox rooted elsewhere",
      {
        ...openInput,
        sandbox: {
          ...openInput.sandbox,
          filesystem: { ...openInput.sandbox.filesystem, allowRead: ["/other"] },
        },
      },
    ],
    [
      "an unsandboxed-command escape",
      { ...openInput, sandbox: { ...openInput.sandbox, allowUnsandboxedCommands: true } },
    ],
    [
      "an unsupported sandbox surface",
      { ...openInput, sandbox: { ...openInput.sandbox, network: { allowedDomains: ["*"] } } },
    ],
  ] as const)("rejects %s before allocating the SDK query", async (_name, candidate) => {
    const harness = makeHarness();

    const failed = await failureOf(
      Effect.scoped(harness.port.openQuery(candidate as unknown as typeof openInput)),
    );

    expect(failed).toEqual({
      category: "invalid-configuration",
      message: "Claude sandbox configuration is invalid.",
    });
    expect(harness.invocation).toBeUndefined();
  });

  test("uses the pinned permission mapping and allows controlled mode changes", async () => {
    const fullAccess = makeHarness([
      { ...safeRuntimeInitialization, permissionMode: "bypassPermissions" },
    ]);
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const {
            resumeSessionId: _resumeSessionId,
            sandbox: _sandbox,
            ...newSessionInput
          } = openInput;
          const query = yield* fullAccess.port.openQuery({
            ...newSessionInput,
            executionPolicy: "full-access",
          });
          expect(fullAccess.invocation?.options).toMatchObject({
            permissionMode: "bypassPermissions",
            allowDangerouslySkipPermissions: true,
          });
          expect(fullAccess.invocation?.options).not.toHaveProperty("resume");
          yield* query.setPermissionMode("plan");
        }),
      ),
    );
    expect(fullAccess.query.setPermissionMode).toHaveBeenCalledWith("plan");

    const plan = makeHarness([{ ...safeRuntimeInitialization, permissionMode: "plan" }]);
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const { sandbox: _sandbox, ...planInput } = openInput;
          yield* plan.port.openQuery({ ...planInput, executionPolicy: "plan" });
          expect(plan.invocation?.options).toMatchObject({ permissionMode: "plan" });
          expect(plan.invocation?.options.allowDangerouslySkipPermissions).toBeUndefined();
        }),
      ),
    );
  });

  test("bounds streaming input and preserves human origin without leaking SDK input types", async () => {
    const harness = makeHarness();

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const query = yield* harness.port.openQuery(openInput);
          const prompt = harness.invocation?.prompt;
          expect(prompt).toBeDefined();
          const iterator = prompt![Symbol.asyncIterator]();

          yield* query.send({ text: "first" });
          let secondSettled = false;
          const second = Effect.runPromise(query.send({ text: "second" })).then(() => {
            secondSettled = true;
          });
          yield* Effect.promise(() => Promise.resolve());
          expect(secondSettled).toBe(false);

          const first = yield* Effect.promise(() => iterator.next());
          expect(first).toMatchObject({
            done: false,
            value: {
              type: "user",
              message: { role: "user", content: "first" },
              parent_tool_use_id: null,
              origin: { kind: "human" },
              session_id: "session-1",
            },
          });
          if (first.done) throw new Error("Expected a delivered prompt.");
          expect(first.value.uuid).toMatch(
            /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
          );
          yield* Effect.promise(() => second);
          const next = yield* Effect.promise(() => iterator.next());
          expect(next).toMatchObject({
            done: false,
            value: { message: { content: "second" } },
          });
        }),
      ),
    );
  });

  test("interrupt clears locally queued input and prevents later prompt execution", async () => {
    const harness = makeHarness();

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const query = yield* harness.port.openQuery(openInput);
          const iterator = harness.invocation!.prompt[Symbol.asyncIterator]();
          yield* query.send({ text: "queued" });
          const blocked = failureOf(query.send({ text: "blocked" }));
          yield* Effect.promise(() => Promise.resolve());

          yield* query.interrupt();
          yield* Effect.promise(() =>
            expect(blocked).resolves.toEqual({
              category: "provider-failed",
              message: "Claude input delivery failed.",
            }),
          );
          yield* query.close();
          yield* Effect.promise(() =>
            expect(iterator.next()).resolves.toEqual({ done: true, value: undefined }),
          );
        }),
      ),
    );
    expect(harness.query.interrupt).toHaveBeenCalledOnce();
  });

  test("stamps prompts and closes when an interrupt receipt says owned input will still run", async () => {
    const harness = makeHarness();

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const query = yield* harness.port.openQuery(openInput);
          const iterator = harness.invocation!.prompt[Symbol.asyncIterator]();
          yield* query.send({ text: "delivered" });
          const delivered = yield* Effect.promise(() => iterator.next());
          if (delivered.done) throw new Error("Expected a delivered prompt.");
          expect(delivered.value.uuid).toMatch(
            /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
          );
          expect(delivered.value.session_id).toBe("session-1");
          harness.query.interrupt.mockResolvedValueOnce({ still_queued: [delivered.value.uuid] });

          expect(yield* query.interrupt()).toBeUndefined();
          expect(harness.query.close).toHaveBeenCalledOnce();
        }),
      ),
    );
  });

  test("fails closed when an advertised interrupt receipt is missing", async () => {
    const harness = makeHarness();
    harness.query.interrupt.mockResolvedValueOnce(undefined);

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const query = yield* harness.port.openQuery(openInput);
          yield* query.interrupt();
          expect(harness.query.close).toHaveBeenCalledOnce();
        }),
      ),
    );
  });

  test("allows exactly one consumer of the decoded message stream", async () => {
    const harness = makeHarness();

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const query = yield* harness.port.openQuery(openInput);
          const first = yield* Stream.runCollect(query.messages);
          expect(Chunk.toReadonlyArray(first)[0]?.kind).toBe("initialized");
          const failed = yield* Effect.flip(Stream.runDrain(query.messages));
          expect(failed).toEqual({
            category: "protocol",
            message: "Claude message stream already has a consumer.",
          });
        }),
      ),
    );
  });

  test("normalizes controls, redacts account identity, and closes idempotently", async () => {
    const harness = makeHarness();
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const query = yield* harness.port.openQuery(openInput);
          expect(yield* query.supportedModels()).toEqual(query.initialization.models);
          expect(yield* query.accountInfo()).toEqual({ ready: true, apiProvider: "firstParty" });
          yield* query.interrupt();
          yield* query.close();
          yield* query.close();
        }),
      ),
    );

    expect(harness.query.supportedModels).toHaveBeenCalledOnce();
    expect(harness.query.accountInfo).toHaveBeenCalledOnce();
    expect(harness.query.interrupt).toHaveBeenCalledOnce();
    expect(harness.query.close).toHaveBeenCalledOnce();
    expect(JSON.stringify(initialization.account)).toContain("secret@example.com");
    expect(
      JSON.stringify({
        session: await Effect.runPromise(
          harness.port.findSession({ sessionId: "missing", projectRoot: "/repo" }),
        ),
      }),
    ).not.toContain("private prompt summary");
  });

  test("contains close exceptions and retries cleanup from the scope finalizer", async () => {
    const harness = makeHarness();
    harness.query.close
      .mockImplementationOnce(() => {
        throw new Error("private close failure");
      })
      .mockImplementation(() => undefined);

    await expect(
      Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const query = yield* harness.port.openQuery(openInput);
            yield* query.close();
          }),
        ),
      ),
    ).resolves.toBeUndefined();
    expect(harness.query.close).toHaveBeenCalledTimes(2);
  });

  test("bounds and contains cleanup retries when finalization performs the first close", async () => {
    const harness = makeHarness();
    harness.query.close.mockImplementation(() => {
      throw new Error("private finalizer close failure");
    });

    await expect(
      Effect.runPromise(Effect.scoped(harness.port.openQuery(openInput))),
    ).resolves.toBeDefined();
    expect(harness.query.close).toHaveBeenCalledTimes(2);
  });

  test("bounds and contains cleanup retries when acquisition fails before scope ownership", async () => {
    const harness = makeHarness();
    harness.query.initializationResult.mockRejectedValueOnce(
      new Error("private initialization failure"),
    );
    harness.query.close.mockImplementation(() => {
      throw new Error("private acquisition close failure");
    });

    const failed = await failureOf(Effect.scoped(harness.port.openQuery(openInput)));
    expect(failed).toEqual({
      category: "provider-failed",
      message: "Claude initialization failed.",
    });
    expect(JSON.stringify(failed)).not.toContain("private");
    expect(harness.query.close).toHaveBeenCalledTimes(2);
  });

  test("surfaces a mismatched project root when the runtime initializes with the first turn", async () => {
    const harness = makeHarness([{ ...safeRuntimeInitialization, cwd: "/wrong-root" }]);

    const failed = await failureOf(
      Effect.scoped(
        Effect.gen(function* () {
          const query = yield* harness.port.openQuery(openInput);
          return yield* Stream.runDrain(query.messages);
        }),
      ),
    );
    expect(failed).toEqual({
      category: "protocol",
      message: "Claude initialized an unexpected runtime surface.",
    });
    expect(JSON.stringify(failed)).not.toContain("wrong-root");
    expect(harness.query.close).toHaveBeenCalledOnce();
  });

  test("coalesces overlapping close calls into one SDK close", async () => {
    const harness = makeHarness();
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const query = yield* harness.port.openQuery(openInput);
          yield* Effect.all([query.close(), query.close()], { concurrency: "unbounded" });
        }),
      ),
    );
    expect(harness.query.close).toHaveBeenCalledOnce();
  });

  test("finds only an exact-root explicit session through listSessions({ dir })", async () => {
    const harness = makeHarness();
    await expect(
      Effect.runPromise(harness.port.findSession({ sessionId: "session-1", projectRoot: "/repo" })),
    ).resolves.toEqual({
      sessionId: "session-1",
      projectRoot: "/repo",
      lastModified: 123,
      createdAt: 100,
    });
    expect(harness.listSessions).toHaveBeenCalledWith({ dir: "/repo" });

    await expect(
      Effect.runPromise(
        harness.port.findSession({ sessionId: "session-1", projectRoot: "/other" }),
      ),
    ).resolves.toBeUndefined();
  });

  test("rejects a resumed runtime whose initialized session identity does not match", async () => {
    const harness = makeHarness([
      { ...safeRuntimeInitialization, session_id: "different-session" },
    ]);
    const failed = await failureOf(
      Effect.scoped(
        Effect.gen(function* () {
          const query = yield* harness.port.openQuery(openInput);
          return yield* Stream.runDrain(query.messages);
        }),
      ),
    );
    expect(failed).toEqual({
      category: "protocol",
      message: "Claude initialized an unexpected runtime surface.",
    });
  });

  test("executes injected callbacks only for the initialized exact session", async () => {
    const canUseTool = vi.fn(async () => ({ behavior: "deny" as const, message: "denied" }));
    const preToolUse = vi.fn(async () => ({ behavior: "allow" as const }));
    const harness = makeHarness();

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const query = yield* harness.port.openQuery({ ...openInput, canUseTool, preToolUse });
          yield* Stream.runHead(query.messages);
          const permission = harness.invocation?.options.canUseTool;
          const preTool = harness.invocation?.options.hooks.PreToolUse[0]?.hooks[0];
          if (permission === undefined || preTool === undefined) {
            throw new Error("Expected injected callbacks.");
          }
          const signal = new AbortController().signal;
          expect(
            yield* Effect.promise(() =>
              permission(
                "Read",
                { path: "/repo/file.ts" },
                {
                  signal,
                  toolUseID: "tool-1",
                  requestId: "request-1",
                },
              ),
            ),
          ).toEqual({ behavior: "deny", message: "denied" });
          expect(canUseTool).toHaveBeenCalledWith(
            expect.objectContaining({
              toolName: "Read",
              toolUseId: "tool-1",
              requestId: "request-1",
              signal,
            }),
          );

          expect(
            yield* Effect.promise(() =>
              preTool(
                {
                  hook_event_name: "PreToolUse",
                  session_id: "different-session",
                  cwd: "/repo",
                  tool_name: "Read",
                  tool_input: { path: "/repo/file.ts" },
                  tool_use_id: "tool-1",
                },
                "tool-1",
                { signal },
              ),
            ),
          ).toMatchObject({
            hookSpecificOutput: { permissionDecision: "deny" },
          });
          expect(preToolUse).not.toHaveBeenCalled();

          expect(
            yield* Effect.promise(() =>
              preTool(
                {
                  hook_event_name: "PreToolUse",
                  session_id: "session-1",
                  cwd: "/repo",
                  tool_name: "Read",
                  tool_input: { path: "/repo/file.ts" },
                  tool_use_id: "tool-1",
                },
                "tool-1",
                { signal },
              ),
            ),
          ).toMatchObject({
            hookSpecificOutput: { permissionDecision: "allow" },
          });
          expect(preToolUse).toHaveBeenCalledWith(
            expect.objectContaining({ sessionId: "session-1", toolUseId: "tool-1" }),
          );
        }),
      ),
    );
  });

  test("denies subagent-marked permission and pre-tool callbacks before delegation", async () => {
    const canUseTool = vi.fn(async () => ({ behavior: "allow" as const }));
    const preToolUse = vi.fn(async () => ({ behavior: "allow" as const }));
    const harness = makeHarness();

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const query = yield* harness.port.openQuery({ ...openInput, canUseTool, preToolUse });
          yield* Stream.runHead(query.messages);
          const permission = harness.invocation?.options.canUseTool;
          const preTool = harness.invocation?.options.hooks.PreToolUse[0]?.hooks[0];
          if (permission === undefined || preTool === undefined) {
            throw new Error("Expected injected callbacks.");
          }
          const signal = new AbortController().signal;

          expect(
            yield* Effect.promise(() =>
              permission(
                "Read",
                { path: "/repo/file.ts" },
                {
                  signal,
                  toolUseID: "tool-subagent",
                  requestId: "request-subagent",
                  agentID: "secret-agent",
                },
              ),
            ),
          ).toEqual({
            behavior: "deny",
            message: "Claude subagent tool use is unavailable.",
          });

          for (const marker of [
            { agent_id: "secret-agent" },
            { agent_type: "secret-agent-type" },
          ]) {
            expect(
              yield* Effect.promise(() =>
                preTool(
                  {
                    hook_event_name: "PreToolUse",
                    session_id: "session-1",
                    cwd: "/repo",
                    tool_name: "Read",
                    tool_input: { path: "/repo/file.ts" },
                    tool_use_id: "tool-subagent",
                    ...marker,
                  },
                  "tool-subagent",
                  { signal },
                ),
              ),
            ).toEqual({
              hookSpecificOutput: {
                hookEventName: "PreToolUse",
                permissionDecision: "deny",
                permissionDecisionReason: "Claude subagent tool use is unavailable.",
              },
            });
          }
          expect(canUseTool).not.toHaveBeenCalled();
          expect(preToolUse).not.toHaveBeenCalled();
        }),
      ),
    );
  });

  test("denies background Bash requests before either authority callback executes", async () => {
    const canUseTool = vi.fn(async () => ({ behavior: "allow" as const }));
    const preToolUse = vi.fn(async () => ({ behavior: "allow" as const }));
    const tools = ["Read", "Grep", "Glob", "Bash"] as const;
    const harness = makeHarness([{ ...safeRuntimeInitialization, tools }]);

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const query = yield* harness.port.openQuery({
            ...openInput,
            tools,
            canUseTool,
            preToolUse,
          });
          yield* Stream.runHead(query.messages);
          const permission = harness.invocation?.options.canUseTool;
          const preTool = harness.invocation?.options.hooks.PreToolUse[0]?.hooks[0];
          if (permission === undefined || preTool === undefined) {
            throw new Error("Expected injected callbacks.");
          }
          const signal = new AbortController().signal;

          for (const [index, runInBackground] of ([true, "invalid"] as const).entries()) {
            const toolUseId = `tool-background-${index}`;
            expect(
              yield* Effect.promise(() =>
                permission(
                  "Bash",
                  { command: "pwd", run_in_background: runInBackground },
                  { signal, toolUseID: toolUseId, requestId: `request-background-${index}` },
                ),
              ),
            ).toEqual({
              behavior: "deny",
              message: "Claude background tool use is unavailable.",
            });
            expect(
              yield* Effect.promise(() =>
                preTool(
                  {
                    hook_event_name: "PreToolUse",
                    session_id: "session-1",
                    cwd: "/repo",
                    tool_name: "Bash",
                    tool_input: { command: "pwd", run_in_background: runInBackground },
                    tool_use_id: toolUseId,
                  },
                  toolUseId,
                  { signal },
                ),
              ),
            ).toEqual({
              hookSpecificOutput: {
                hookEventName: "PreToolUse",
                permissionDecision: "deny",
                permissionDecisionReason: "Claude background tool use is unavailable.",
              },
            });
          }
          expect(canUseTool).not.toHaveBeenCalled();
          expect(preToolUse).not.toHaveBeenCalled();
        }),
      ),
    );
  });

  test("denies unlisted tools before either authority callback executes", async () => {
    const canUseTool = vi.fn(async () => ({ behavior: "allow" as const }));
    const preToolUse = vi.fn(async () => ({ behavior: "allow" as const }));
    const harness = makeHarness();

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const query = yield* harness.port.openQuery({ ...openInput, canUseTool, preToolUse });
          yield* Stream.runHead(query.messages);
          const permission = harness.invocation?.options.canUseTool;
          const preTool = harness.invocation?.options.hooks.PreToolUse[0]?.hooks[0];
          if (permission === undefined || preTool === undefined) {
            throw new Error("Expected injected callbacks.");
          }
          const signal = new AbortController().signal;
          expect(
            yield* Effect.promise(() =>
              permission(
                "Bash",
                { command: "pwd" },
                {
                  signal,
                  toolUseID: "tool-unlisted",
                  requestId: "request-unlisted",
                },
              ),
            ),
          ).toEqual({
            behavior: "deny",
            message: "Claude requested a tool outside the configured allowlist.",
          });
          expect(
            yield* Effect.promise(() =>
              preTool(
                {
                  hook_event_name: "PreToolUse",
                  session_id: "session-1",
                  cwd: "/repo",
                  tool_name: "Bash",
                  tool_input: { command: "pwd" },
                  tool_use_id: "tool-unlisted",
                },
                "tool-unlisted",
                { signal },
              ),
            ),
          ).toEqual({
            hookSpecificOutput: {
              hookEventName: "PreToolUse",
              permissionDecision: "deny",
              permissionDecisionReason: "Claude requested a tool outside the configured allowlist.",
            },
          });
          expect(canUseTool).not.toHaveBeenCalled();
          expect(preToolUse).not.toHaveBeenCalled();
        }),
      ),
    );
  });

  test("protocol-fails tool progress for an unlisted tool", async () => {
    const failed = await failureOf(
      Effect.scoped(
        Effect.gen(function* () {
          const harness = makeHarness([
            safeRuntimeInitialization,
            {
              type: "tool_progress",
              session_id: "session-1",
              parent_tool_use_id: null,
              tool_use_id: "tool-unlisted",
              tool_name: "Bash",
              elapsed_time_seconds: 1,
              uuid: "tool-progress-unlisted",
            },
          ]);
          const query = yield* harness.port.openQuery(openInput);
          return yield* Stream.runDrain(query.messages);
        }),
      ),
    );
    expect(failed).toEqual({
      category: "protocol",
      message: "Claude returned an unsupported runtime message.",
    });
  });

  test("ignores only schema-validated harmless informational messages", async () => {
    const harness = makeHarness([
      safeRuntimeInitialization,
      {
        type: "system",
        subtype: "notification",
        key: "notice",
        text: "harmless",
        priority: "low",
        uuid: "2",
        session_id: "session-1",
      },
      {
        type: "system",
        subtype: "informational",
        content: "display only",
        level: "notice",
        tool_use_id: "tool-1",
        uuid: "3",
        session_id: "session-1",
      },
      { type: "prompt_suggestion", suggestion: "next", uuid: "4", session_id: "session-1" },
      // Captured from Claude Code 2.1.234 retrying a 401 during a turn.
      {
        type: "system",
        subtype: "api_retry",
        attempt: 1,
        max_retries: 10,
        retry_delay_ms: 581,
        error_status: 401,
        error: "authentication_failed",
        session_id: "session-1",
        uuid: "b441de81-ec9d-4c62-9be9-9a0b09954fbd",
      },
      { type: "keep_alive" },
    ]);

    const messages = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const query = yield* harness.port.openQuery(openInput);
          return yield* Stream.runCollect(query.messages);
        }),
      ),
    );

    expect(Chunk.toReadonlyArray(messages)).toEqual([
      {
        kind: "initialized",
        sessionId: "session-1",
        projectRoot: "/repo",
        model: "claude-sonnet",
        requestedModel: "claude-sonnet",
        permissionMode: "default",
        tools: ["Read", "Grep", "Glob"],
        capabilities: ["interrupt_receipt_v1"],
        runtimeVersion: "2.1.211",
      },
      { kind: "ignored" },
      { kind: "ignored" },
      { kind: "ignored" },
      { kind: "ignored" },
      { kind: "ignored" },
    ]);
  });

  test.each([
    { type: "future_information", detail: "not allowlisted" },
    {
      type: "system",
      subtype: "permission_denied",
      tool_name: "Read",
      tool_use_id: "tool-1",
      message: "denied",
      uuid: "5",
      session_id: "session-1",
    },
    {
      type: "system",
      subtype: "worker_shutting_down",
      reason: "host_exit",
      uuid: "6",
      session_id: "session-1",
    },
    {
      type: "system",
      subtype: "informational",
      content: "blocking",
      level: "warning",
      prevent_continuation: true,
      uuid: "7",
      session_id: "session-1",
    },
  ])("protocol-fails every non-allowlisted message after initialization", async (message) => {
    const failed = await failureOf(
      Effect.scoped(
        Effect.gen(function* () {
          const harness = makeHarness([safeRuntimeInitialization, message]);
          const query = yield* harness.port.openQuery(openInput);
          return yield* Stream.runDrain(query.messages);
        }),
      ),
    );
    expect(failed).toEqual({
      category: "protocol",
      message: "Claude returned an unsupported runtime message.",
    });
  });

  test("decodes supported assistant and stream variants without forwarding SDK payload objects", async () => {
    const rawToolInput = { path: "/repo/file.ts", nested: { line: 7 } };
    const rawStreamEvent = {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: "delta" },
    };
    const messages = await collectMessages([
      safeRuntimeInitialization,
      {
        type: "assistant",
        session_id: "session-1",
        parent_tool_use_id: null,
        message: {
          id: "assistant-1",
          type: "message",
          role: "assistant",
          model: "claude-sonnet",
          container: null,
          context_management: null,
          diagnostics: null,
          stop_details: null,
          stop_reason: "end_turn",
          stop_sequence: null,
          content: [
            { type: "text", text: "hello", citations: null },
            { type: "thinking", thinking: "summary", signature: "private-signature" },
            { type: "redacted_thinking", data: "private-redacted-data" },
            { type: "tool_use", id: "tool-1", name: "Read", input: rawToolInput },
          ],
          usage: {
            input_tokens: 3,
            output_tokens: 4,
            cache_creation_input_tokens: 1,
            cache_read_input_tokens: 2,
          },
        },
      },
      {
        type: "stream_event",
        session_id: "session-1",
        parent_tool_use_id: null,
        event: rawStreamEvent,
      },
    ]);

    expect(messages.slice(1)).toEqual([
      {
        kind: "assistant",
        sessionId: "session-1",
        messageId: "assistant-1",
        content: [
          { kind: "text", text: "hello" },
          { kind: "reasoning", text: "summary" },
          { kind: "redacted-reasoning" },
          {
            kind: "tool-use",
            toolUseId: "tool-1",
            toolName: "Read",
            input: { path: "/repo/file.ts", nested: { line: 7 } },
          },
        ],
        usage: {
          inputTokens: 3,
          outputTokens: 4,
          cacheCreationInputTokens: 1,
          cacheReadInputTokens: 2,
        },
      },
      {
        kind: "stream-event",
        sessionId: "session-1",
        event: { kind: "text-delta", index: 0, text: "delta" },
      },
    ]);
    const assistant = messages[1];
    const stream = messages[2];
    if (assistant?.kind !== "assistant" || stream?.kind !== "stream-event") {
      throw new Error("Expected decoded assistant and stream messages.");
    }
    expect(messages[1]).not.toHaveProperty("message");
    expect(messages[2]).not.toHaveProperty("event.type");
    expect(assistant.content).not.toBe(rawToolInput);
    expect(stream.event).not.toBe(rawStreamEvent);
    expect(JSON.stringify(messages)).not.toContain("private-signature");
    expect(JSON.stringify(messages)).not.toContain("private-redacted-data");
  });

  test("normalizes nullable cumulative input usage in a valid message delta", async () => {
    const messages = await collectMessages([
      safeRuntimeInitialization,
      {
        type: "stream_event",
        session_id: "session-1",
        parent_tool_use_id: null,
        event: {
          type: "message_delta",
          delta: {
            container: null,
            stop_details: null,
            stop_reason: "end_turn",
            stop_sequence: null,
          },
          context_management: null,
          usage: {
            input_tokens: null,
            output_tokens: 4,
            cache_creation_input_tokens: null,
            cache_read_input_tokens: null,
          },
        },
      },
    ]);

    expect(messages[1]).toEqual({
      kind: "stream-event",
      sessionId: "session-1",
      event: {
        kind: "message-delta",
        stopReason: "end_turn",
        usage: {
          inputTokens: 0,
          outputTokens: 4,
          cacheCreationInputTokens: 0,
          cacheReadInputTokens: 0,
        },
      },
    });
  });

  test("rejects an assistant envelope with a non-assistant role", async () => {
    const failed = await failureOf(
      Effect.scoped(
        Effect.gen(function* () {
          const harness = makeHarness([
            safeRuntimeInitialization,
            {
              type: "assistant",
              session_id: "session-1",
              parent_tool_use_id: null,
              message: {
                id: "assistant-1",
                type: "message",
                role: "user",
                model: "claude-sonnet",
                content: [],
                container: null,
                context_management: null,
                diagnostics: null,
                stop_details: null,
                stop_reason: "end_turn",
                stop_sequence: null,
                usage: {
                  input_tokens: 1,
                  output_tokens: 1,
                  cache_creation_input_tokens: null,
                  cache_read_input_tokens: null,
                },
              },
            },
          ]);
          const query = yield* harness.port.openQuery(openInput);
          return yield* Stream.runDrain(query.messages);
        }),
      ),
    );
    expect(failed).toEqual({
      category: "protocol",
      message: "Claude returned an unsupported runtime message.",
    });
  });

  test("does not emit replayed prompts or raw tool-result payloads", async () => {
    const messages = await collectMessages([
      safeRuntimeInitialization,
      {
        type: "user",
        isReplay: true,
        session_id: "session-1",
        parent_tool_use_id: null,
        message: { role: "user", content: "private replayed prompt" },
      },
      {
        type: "user",
        session_id: "session-1",
        parent_tool_use_id: null,
        tool_use_result: { commandOutput: "private command output" },
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "tool-1",
              is_error: false,
              content: "private command output",
            },
          ],
        },
      },
    ]);

    expect(messages.slice(1)).toEqual([
      { kind: "ignored" },
      {
        kind: "tool-results",
        sessionId: "session-1",
        results: [{ toolUseId: "tool-1", isError: false }],
      },
    ]);
    expect(JSON.stringify(messages)).not.toContain("private replayed prompt");
    expect(JSON.stringify(messages)).not.toContain("private command output");
  });

  test("protocol-fails unsupported assistant payload variants without reflecting payload content", async () => {
    const failed = await failureOf(
      Effect.scoped(
        Effect.gen(function* () {
          const harness = makeHarness([
            safeRuntimeInitialization,
            {
              type: "assistant",
              session_id: "session-1",
              parent_tool_use_id: null,
              message: {
                id: "assistant-1",
                type: "message",
                role: "assistant",
                model: "claude-sonnet",
                container: null,
                context_management: null,
                diagnostics: null,
                stop_details: null,
                stop_reason: "end_turn",
                stop_sequence: null,
                content: [{ type: "future_payload", secret: "private-payload" }],
                usage: {
                  input_tokens: 1,
                  output_tokens: 1,
                  cache_creation_input_tokens: 0,
                  cache_read_input_tokens: 0,
                },
              },
            },
          ]);
          const query = yield* harness.port.openQuery(openInput);
          return yield* Stream.runDrain(query.messages);
        }),
      ),
    );

    expect(failed).toEqual({
      category: "protocol",
      message: "Claude returned an unsupported runtime message.",
    });
    expect(JSON.stringify(failed)).not.toContain("private-payload");
  });

  const validResult = {
    type: "result",
    subtype: "success",
    session_id: "session-1",
    duration_ms: 10,
    duration_api_ms: 8,
    is_error: false,
    num_turns: 1,
    result: "private raw result",
    stop_reason: null,
    terminal_reason: "completed",
    total_cost_usd: 0.01,
    usage: {
      input_tokens: 3,
      output_tokens: 4,
      cache_creation_input_tokens: 1,
      cache_read_input_tokens: 2,
    },
    modelUsage: {},
    permission_denials: [],
    uuid: "result-1",
  } as const;

  const validAssistant = {
    type: "assistant",
    session_id: "session-1",
    parent_tool_use_id: null,
    message: {
      id: "assistant-1",
      type: "message",
      role: "assistant",
      model: "claude-sonnet",
      container: null,
      context_management: null,
      diagnostics: null,
      stop_details: null,
      stop_reason: "end_turn",
      stop_sequence: null,
      content: [{ type: "text", text: "hello", citations: null }],
      usage: {
        input_tokens: 1,
        output_tokens: 1,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
    },
  } as const;

  test.each([
    ["assistant parent", { ...validAssistant, parent_tool_use_id: "secret-subagent" }],
    ["assistant type", { ...validAssistant, subagent_type: "secret-subagent" }],
    ["assistant task", { ...validAssistant, task_description: "secret-subagent" }],
    [
      "partial-stream parent",
      {
        type: "stream_event",
        session_id: "session-1",
        parent_tool_use_id: "secret-subagent",
        event: {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: "secret-subagent" },
        },
      },
    ],
    [
      "tool-progress parent",
      {
        type: "tool_progress",
        session_id: "session-1",
        parent_tool_use_id: "secret-subagent",
        tool_use_id: "tool-1",
        tool_name: "Read",
        elapsed_time_seconds: 1,
        uuid: "tool-progress-subagent",
      },
    ],
    [
      "tool-result parent",
      {
        type: "user",
        session_id: "session-1",
        parent_tool_use_id: "secret-subagent",
        message: {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "tool-1", is_error: false }],
        },
      },
    ],
    [
      "tool-result subagent type",
      {
        type: "user",
        session_id: "session-1",
        parent_tool_use_id: null,
        subagent_type: "secret-subagent",
        message: {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "tool-1", is_error: false }],
        },
      },
    ],
    [
      "tool-result task description",
      {
        type: "user",
        session_id: "session-1",
        parent_tool_use_id: null,
        task_description: "secret-subagent",
        message: {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "tool-1", is_error: false }],
        },
      },
    ],
    [
      "task-start subagent",
      {
        type: "system",
        subtype: "task_started",
        task_id: "task-1",
        description: "secret-subagent",
        subagent_type: "secret-subagent",
        uuid: "task-start-subagent",
        session_id: "session-1",
      },
    ],
    [
      "task-progress subagent",
      {
        type: "system",
        subtype: "task_progress",
        task_id: "task-1",
        description: "secret-subagent",
        subagent_type: "secret-subagent",
        usage: { total_tokens: 1, tool_uses: 0, duration_ms: 1 },
        uuid: "task-progress-subagent",
        session_id: "session-1",
      },
    ],
    [
      "local-workflow type",
      {
        type: "system",
        subtype: "task_started",
        task_id: "task-1",
        description: "secret-subagent",
        task_type: "local_workflow",
        uuid: "task-start-workflow",
        session_id: "session-1",
      },
    ],
    [
      "local-workflow name",
      {
        type: "system",
        subtype: "task_started",
        task_id: "task-1",
        description: "secret-subagent",
        workflow_name: "secret-subagent",
        uuid: "task-start-workflow-name",
        session_id: "session-1",
      },
    ],
    [
      "local-workflow prompt",
      {
        type: "system",
        subtype: "task_started",
        task_id: "task-1",
        description: "secret-subagent",
        prompt: "secret-subagent",
        uuid: "task-start-workflow-prompt",
        session_id: "session-1",
      },
    ],
  ])("protocol-fails %s provenance without reflecting it", async (_label, message) => {
    const harness = makeHarness([safeRuntimeInitialization, message]);

    const failed = await failureOf(
      Effect.scoped(
        Effect.gen(function* () {
          const query = yield* harness.port.openQuery(openInput);
          return yield* Stream.runDrain(query.messages);
        }),
      ),
    );

    expect(failed).toEqual({
      category: "protocol",
      message: "Claude returned an unsupported runtime message.",
    });
    expect(JSON.stringify(failed)).not.toContain("secret-subagent");
    expect(harness.query.close).toHaveBeenCalledOnce();
  });

  test.each([
    ["a background terminal", { ...validResult, terminal_reason: "background_requested" }],
    [
      "a hidden task start",
      {
        type: "system",
        subtype: "task_started",
        task_id: "task-background",
        description: "secret-background",
        skip_transcript: true,
        uuid: "task-start-background",
        session_id: "session-1",
      },
    ],
    [
      "a hidden task notification",
      {
        type: "system",
        subtype: "task_notification",
        task_id: "task-background",
        status: "completed",
        output_file: "/private/background",
        summary: "secret-background",
        skip_transcript: true,
        uuid: "task-notification-background",
        session_id: "session-1",
      },
    ],
    [
      "a backgrounded task update",
      {
        type: "system",
        subtype: "task_updated",
        task_id: "task-background",
        patch: { status: "running", is_backgrounded: true },
        uuid: "task-update-background",
        session_id: "session-1",
      },
    ],
    [
      "an open-ended task type",
      {
        type: "system",
        subtype: "task_started",
        task_id: "task-background",
        description: "secret-background",
        task_type: "shell",
        uuid: "task-start-open-ended",
        session_id: "session-1",
      },
    ],
  ])("protocol-fails %s without reflecting background payloads", async (_label, message) => {
    const harness = makeHarness([safeRuntimeInitialization, message]);

    const failed = await failureOf(
      Effect.scoped(
        Effect.gen(function* () {
          const query = yield* harness.port.openQuery(openInput);
          return yield* Stream.runDrain(query.messages);
        }),
      ),
    );

    expect(failed).toEqual({
      category: "protocol",
      message: "Claude returned an unsupported runtime message.",
    });
    expect(JSON.stringify(failed)).not.toContain("secret-background");
    expect(harness.query.close).toHaveBeenCalledOnce();
  });

  test.each([
    ["assistant", { ...validAssistant, session_id: "other-session" }],
    ["result", { ...validResult, session_id: "other-session" }],
    [
      "tool progress",
      {
        type: "tool_progress",
        session_id: "other-session",
        parent_tool_use_id: null,
        tool_use_id: "tool-1",
        tool_name: "Read",
        elapsed_time_seconds: 1,
        uuid: "tool-progress-1",
      },
    ],
    [
      "status",
      {
        type: "system",
        subtype: "status",
        status: "requesting",
        permissionMode: "default",
        uuid: "status-1",
        session_id: "other-session",
      },
    ],
    [
      "informational",
      {
        type: "system",
        subtype: "informational",
        content: "harmless",
        level: "info",
        uuid: "info-1",
        session_id: "other-session",
      },
    ],
  ])("protocol-fails a post-init %s frame from another session", async (_label, message) => {
    const failed = await failureOf(
      Effect.scoped(
        Effect.gen(function* () {
          const harness = makeHarness([safeRuntimeInitialization, message]);
          const query = yield* harness.port.openQuery(openInput);
          return yield* Stream.runDrain(query.messages);
        }),
      ),
    );
    expect(failed).toEqual({
      category: "protocol",
      message: "Claude returned an unsupported runtime message.",
    });
  });

  test.each([
    ["plan", "plan", "bypassPermissions"],
    ["approval-gated", "default", "plan"],
    ["approval-gated", "default", "bypassPermissions"],
    ["full-access", "bypassPermissions", "default"],
  ] as const)(
    "rejects a %s session status that drifts from %s to %s",
    async (executionPolicy, initializedMode, statusMode) => {
      const { sandbox: _sandbox, ...withoutSandbox } = openInput;
      const input =
        executionPolicy === "approval-gated"
          ? openInput
          : ({ ...withoutSandbox, executionPolicy } as const);
      const failed = await failureOf(
        Effect.scoped(
          Effect.gen(function* () {
            const harness = makeHarness([
              { ...safeRuntimeInitialization, permissionMode: initializedMode },
              {
                type: "system",
                subtype: "status",
                status: "requesting",
                permissionMode: statusMode,
                uuid: "status-drift",
                session_id: "session-1",
              },
            ]);
            const query = yield* harness.port.openQuery(input);
            return yield* Stream.runDrain(query.messages);
          }),
        ),
      );

      expect(failed).toEqual({
        category: "protocol",
        message: "Claude returned an unsupported runtime message.",
      });
    },
  );

  test.each([
    ["approval-gated", "default", "default"],
    ["approval-gated", "default", undefined],
    ["plan", "plan", "plan"],
    ["full-access", "bypassPermissions", "bypassPermissions"],
  ] as const)(
    "accepts a %s session status that preserves %s with reported mode %s",
    async (executionPolicy, initializedMode, statusMode) => {
      const { sandbox: _sandbox, ...withoutSandbox } = openInput;
      const input =
        executionPolicy === "approval-gated"
          ? openInput
          : ({ ...withoutSandbox, executionPolicy } as const);
      const messages = await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const harness = makeHarness([
              { ...safeRuntimeInitialization, permissionMode: initializedMode },
              {
                type: "system",
                subtype: "status",
                status: "requesting",
                ...(statusMode === undefined ? {} : { permissionMode: statusMode }),
                uuid: "status-stable",
                session_id: "session-1",
              },
            ]);
            const query = yield* harness.port.openQuery(input);
            return yield* Stream.runCollect(query.messages);
          }),
        ),
      );

      expect(Chunk.toReadonlyArray(messages).at(-1)).toEqual({
        kind: "status",
        sessionId: "session-1",
        status: "requesting",
        ...(statusMode === undefined ? {} : { permissionMode: statusMode }),
      });
    },
  );

  test("protocol-fails a duplicate system/init after initialization", async () => {
    const failed = await failureOf(
      Effect.scoped(
        Effect.gen(function* () {
          const harness = makeHarness([safeRuntimeInitialization, safeRuntimeInitialization]);
          const query = yield* harness.port.openQuery(openInput);
          return yield* Stream.runDrain(query.messages);
        }),
      ),
    );
    expect(failed).toEqual({
      category: "protocol",
      message: "Claude returned an unsupported runtime message.",
    });
  });

  test.each([
    { ...validResult, subtype: "future_result" },
    { ...validResult, terminal_reason: "future_terminal" },
    { ...validResult, usage: { ...validResult.usage, output_tokens: Number.NaN } },
    {
      ...validResult,
      permission_denials: [
        { tool_name: "Bash", tool_use_id: "tool-unlisted", tool_input: { command: "pwd" } },
      ],
    },
    {
      type: "system",
      subtype: "status",
      status: "requesting",
      permissionMode: "acceptEdits",
      uuid: "status-1",
      session_id: "session-1",
    },
    {
      type: "system",
      subtype: "task_started",
      task_id: "task-1",
      uuid: "task-1",
      session_id: "session-1",
    },
    {
      type: "system",
      subtype: "task_progress",
      task_id: "task-1",
      description: "running",
      usage: { total_tokens: "invalid", tool_uses: 1, duration_ms: 5 },
      uuid: "task-2",
      session_id: "session-1",
    },
    {
      type: "system",
      subtype: "task_notification",
      task_id: "task-1",
      status: "future_status",
      output_file: "/private/output",
      summary: "done",
      uuid: "task-3",
      session_id: "session-1",
    },
  ])("strictly rejects malformed active message fields", async (message) => {
    const failed = await failureOf(
      Effect.scoped(
        Effect.gen(function* () {
          const harness = makeHarness([safeRuntimeInitialization, message]);
          const query = yield* harness.port.openQuery(openInput);
          return yield* Stream.runDrain(query.messages);
        }),
      ),
    );
    expect(failed).toEqual({
      category: "protocol",
      message: "Claude returned an unsupported runtime message.",
    });
  });

  test.each([
    [{ type: "tool_future", payload: "secret" }, "tool"],
    [{ type: "request_future", payload: "secret" }, "request"],
    [{ type: "usage_future", payload: "secret" }, "usage"],
    [{ type: "input_future", payload: "secret" }, "input"],
    [{ type: "terminal_future", payload: "secret" }, "terminal"],
  ])(
    "fails unknown active message %s after initialization without reflecting payloads",
    async (message, _label) => {
      const harness = makeHarness([safeRuntimeInitialization, message]);
      const failed = await failureOf(
        Effect.scoped(
          Effect.gen(function* () {
            const query = yield* harness.port.openQuery(openInput);
            return yield* Stream.runDrain(query.messages);
          }),
        ),
      );

      expect(failed).toEqual({
        category: "protocol",
        message: "Claude returned an unsupported runtime message.",
      });
      expect(JSON.stringify(failed)).not.toContain("secret");
    },
  );

  test.each([
    [
      "a malformed slash-command field",
      { ...safeRuntimeInitialization, slash_commands: "secret-command" },
      "Claude returned an unsupported runtime message.",
      "secret-command",
    ],
    [
      "a malformed active output style",
      { ...safeRuntimeInitialization, output_style: null },
      "Claude returned an unsupported runtime message.",
      "secret-style",
    ],
  ])(
    "rejects %s from the runtime initialization stream",
    async (_name, message, failureMessage, secret) => {
      const harness = makeHarness([message]);

      const failed = await failureOf(
        Effect.scoped(
          Effect.gen(function* () {
            const query = yield* harness.port.openQuery(openInput);
            return yield* Stream.runDrain(query.messages);
          }),
        ),
      );

      expect(failed).toEqual({ category: "protocol", message: failureMessage });
      expect(JSON.stringify(failed)).not.toContain(secret);
      expect(harness.query.close).toHaveBeenCalledOnce();
    },
  );

  test("accepts the runtime's built-in agents, skills, commands, and a sorted tool list", async () => {
    const harness = makeHarness([
      {
        ...safeRuntimeInitialization,
        agents: ["Explore", "Plan", "general-purpose"],
        skills: ["user-skill"],
        plugins: [{ name: "inert-plugin", path: "/plugins/inert" }],
        slash_commands: ["clear", "compact", "config"],
        tools: ["Glob", "Grep", "Read"],
        output_style: "Explanatory",
      },
    ]);

    const first = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const query = yield* harness.port.openQuery(openInput);
          return yield* Stream.runHead(query.messages);
        }),
      ),
    );

    expect(first._tag === "Some" ? first.value.kind : undefined).toBe("initialized");
  });

  test("accepts a runtime that holds fewer tools than were requested", async () => {
    const harness = makeHarness([{ ...safeRuntimeInitialization, tools: ["Read", "Grep"] }]);

    const first = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const query = yield* harness.port.openQuery(openInput);
          return yield* Stream.runHead(query.messages);
        }),
      ),
    );

    expect(
      first._tag === "Some" && first.value.kind === "initialized" ? first.value.tools : undefined,
    ).toEqual(["Read", "Grep"]);
  });

  test("skips the runtime's goal, compaction, and command notes that precede initialization", async () => {
    const harness = makeHarness([
      { type: "active_goal", value: null, uuid: "note-1", session_id: "session-1" },
      {
        type: "autocompact_state",
        value: { enabled: true, threshold: 1 },
        uuid: "note-2",
        session_id: "session-1",
      },
      {
        type: "command_lifecycle",
        command_uuid: "message-1",
        state: "queued",
        uuid: "note-3",
        session_id: "session-1",
      },
      safeRuntimeInitialization,
    ]);

    const kinds = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const query = yield* harness.port.openQuery(openInput);
          const messages = yield* Stream.runCollect(Stream.take(query.messages, 1));
          return Chunk.toReadonlyArray(messages).map((message) => message.kind);
        }),
      ),
    );

    expect(kinds).toEqual(["initialized"]);
  });

  test("opens a new session under the assigned id and holds the runtime to it", async () => {
    const { resumeSessionId: _resume, ...fresh } = openInput;
    const harness = makeHarness([{ ...safeRuntimeInitialization, session_id: "assigned-1" }]);

    const sessionId = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const query = yield* harness.port.openQuery({ ...fresh, sessionId: "assigned-1" });
          const announced = yield* query.sessionId;
          yield* Stream.runHead(query.messages);
          return announced;
        }),
      ),
    );

    expect(sessionId).toBe("assigned-1");
    expect(harness.invocation?.options.sessionId).toBe("assigned-1");
    expect(harness.invocation?.options).not.toHaveProperty("resume");

    const drifted = makeHarness([{ ...safeRuntimeInitialization, session_id: "other-session" }]);
    const failed = await failureOf(
      Effect.scoped(
        Effect.gen(function* () {
          const query = yield* drifted.port.openQuery({ ...fresh, sessionId: "assigned-1" });
          return yield* Stream.runDrain(query.messages);
        }),
      ),
    );
    expect(failed).toEqual({
      category: "protocol",
      message: "Claude initialized an unexpected runtime surface.",
    });
    expect(JSON.stringify(failed)).not.toContain("other-session");
  });

  test("accepts the model id the runtime resolved the requested alias to", async () => {
    const harness = makeHarness([{ ...safeRuntimeInitialization, model: "claude-sonnet-4-5" }]);

    const first = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const query = yield* harness.port.openQuery(openInput);
          return yield* Stream.runHead(query.messages);
        }),
      ),
    );

    expect(
      first._tag === "Some" && first.value.kind === "initialized" ? first.value.model : undefined,
    ).toBe("claude-sonnet-4-5");
  });

  test.each([
    ["a widened tool list", { tools: ["Read", "Grep", "Glob", "WebFetch"] }],
    ["an attached MCP server", { mcp_servers: [{ name: "hidden", status: "connected" }] }],
    ["a model outside the requested alias", { model: "hidden-model" }],
  ])("refuses %s as an unexpected runtime surface", async (_name, override) => {
    const harness = makeHarness([{ ...safeRuntimeInitialization, ...override }]);

    const failed = await failureOf(
      Effect.scoped(
        Effect.gen(function* () {
          const query = yield* harness.port.openQuery(openInput);
          return yield* Stream.runDrain(query.messages);
        }),
      ),
    );

    expect(failed).toEqual({
      category: "protocol",
      message: "Claude initialized an unexpected runtime surface.",
    });
    expect(JSON.stringify(failed)).not.toContain("hidden");
  });
});
