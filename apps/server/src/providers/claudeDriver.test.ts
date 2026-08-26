import {
  decodeProviderInstanceId,
  decodeProviderSessionId,
  type ClaudeAuthentication,
  type PermissionPersistence,
  type ProviderFailure,
  type ProviderModelId,
  type ProviderRuntimeEvent,
} from "@octant/contracts";
import { Effect, Exit, Fiber, PubSub, Scope, Stream } from "effect";
import { describe, expect, it, vi } from "vitest";

import type { ProviderCredentialResolver } from "./credentialBrokerClient";
import type {
  ClaudeAgentSdkPort,
  ClaudeDecodedMessage,
  ClaudeOpenQueryInput,
  ClaudeQueryPort,
  ClaudeSessionMetadata,
} from "./claudeAgentSdkPort";
import { claudeExecutionOptions, makeClaudeDriver } from "./claudeDriver";
import type { ClaudeResumeIdentity, ClaudeResumeIdentityPort } from "./claudeDriver";
import type { ClaudeEnvironmentScope } from "./claudeEnvironment";
import type { ClaudeProcessPort } from "./claudeProcess";
import { ProviderRuntimeRegistry } from "./providerRuntimeRegistry";

const instanceId = decodeProviderInstanceId("80000000-0000-4000-8000-000000000701");
const otherInstanceId = decodeProviderInstanceId("80000000-0000-4000-8000-000000000702");
const sessionId = decodeProviderSessionId("80000000-0000-4000-8000-000000000703");
const otherSessionId = decodeProviderSessionId("80000000-0000-4000-8000-000000000704");
const modelId = "claude-sonnet" as ProviderModelId;
const projectRoot = "/tmp/octant-claude-project";
const observedAt = "2026-07-16T12:00:00.000Z";
const readyCapabilities = {
  streaming: "supported",
  resume: "supported",
  interruption: "supported",
  approvals: "supported",
  userQuestions: "supported",
  reasoning: "supported",
  usage: "supported",
  toolActivity: "supported",
  fileChanges: "supported",
  diffs: "supported",
  taskProgress: "supported",
  nativeChildAgents: "unsupported",
  nativeAttachments: "unsupported",
  nativeWebResearch: "unsupported",
  appManagedTools: "unsupported",
  citations: "unsupported",
} as const;

const initialized = (
  sdkSessionId: string,
  root = projectRoot,
  model: string = modelId,
): ClaudeDecodedMessage => ({
  kind: "initialized",
  sessionId: sdkSessionId,
  projectRoot: root,
  model,
  permissionMode: "default",
  tools: ["Read", "Grep", "Glob", "Edit", "Write", "Bash", "AskUserQuestion"],
  capabilities: ["interrupt_receipt_v1"],
  runtimeVersion: "2.1.211",
});

const completed = (sdkSessionId: string): ClaudeDecodedMessage => ({
  kind: "result",
  sessionId: sdkSessionId,
  outcome: "success",
  subtype: "success",
  stopReason: "end_turn",
  terminalReason: "completed",
  usage: {
    inputTokens: 3,
    outputTokens: 5,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
  },
  permissionDenials: [],
});

const interrupted = (sdkSessionId: string): ClaudeDecodedMessage => ({
  kind: "result",
  sessionId: sdkSessionId,
  outcome: "error",
  subtype: "error_during_execution",
  stopReason: null,
  terminalReason: "aborted_streaming",
  usage: {
    inputTokens: 3,
    outputTokens: 1,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
  },
  permissionDenials: [],
});

class FakeQuery implements ClaudeQueryPort {
  readonly initialization: ClaudeQueryPort["initialization"] = {
    models: [
      {
        id: modelId,
        resolvedId: "claude-sonnet-4-5",
        displayName: "Claude Sonnet",
        description: "Balanced",
        supportsEffort: true,
        supportedEffortLevels: ["low", "high"],
      },
    ],
    account: { ready: true, apiProvider: "firstParty" },
  };
  readonly sent: string[] = [];
  readonly interrupt = vi.fn(() => Effect.void);
  readonly setPermissionMode = vi.fn(() => Effect.void);
  readonly supportedModels = vi.fn(() => Effect.succeed(this.initialization.models));
  readonly accountInfo = vi.fn<ClaudeQueryPort["accountInfo"]>(() =>
    Effect.succeed(this.initialization.account),
  );
  readonly close = vi.fn(() => Effect.void);
  readonly send = vi.fn(({ text }: { readonly text: string }) =>
    Effect.sync(() => {
      this.sent.push(text);
    }),
  );
  readonly messages: Stream.Stream<ClaudeDecodedMessage, ProviderFailure>;

  private readonly pubsub = Effect.runSync(PubSub.unbounded<ClaudeDecodedMessage>());

  constructor(
    readonly sdkSessionId: string,
    stream?: Stream.Stream<ClaudeDecodedMessage, ProviderFailure>,
    model: string = modelId,
    account: ClaudeQueryPort["initialization"]["account"] = {
      ready: true,
      apiProvider: "firstParty",
    },
  ) {
    this.initialization = { ...this.initialization, account };
    this.messages =
      stream ??
      Stream.concat(
        Stream.make(initialized(sdkSessionId, projectRoot, model)),
        Stream.fromPubSub(this.pubsub),
      );
  }

  emit(message: ClaudeDecodedMessage): Promise<boolean> {
    return Effect.runPromise(PubSub.publish(this.pubsub, message));
  }

  end(): Promise<void> {
    return Effect.runPromise(PubSub.shutdown(this.pubsub));
  }
}

function harness(
  authentication: ClaudeAuthentication = "subscription",
  permissionPersistence: PermissionPersistence = "current-session",
) {
  const queries: FakeQuery[] = [];
  const opens: ClaudeOpenQueryInput[] = [];
  const sessions = new Map<string, ClaudeSessionMetadata>();
  let queryNumber = 0;
  let requestNumber = 0;
  let openQueryImpl: ClaudeAgentSdkPort["openQuery"] = (input) =>
    Effect.acquireRelease(
      Effect.sync(() => {
        opens.push({ ...input, authEnvironment: { ...input.authEnvironment } });
        const query = new FakeQuery(
          input.resumeSessionId ?? `sdk-session-${++queryNumber}`,
          undefined,
          input.model,
        );
        queries.push(query);
        sessions.set(query.sdkSessionId, {
          sessionId: query.sdkSessionId,
          projectRoot: input.projectRoot,
          lastModified: 10,
        });
        return query;
      }),
      (query) => query.close(),
    );
  const sdk: ClaudeAgentSdkPort = {
    openQuery: (input) => openQueryImpl(input),
    findSession: vi.fn(({ sessionId: sdkSessionId, projectRoot: root }) =>
      Effect.succeed(
        sessions.get(sdkSessionId)?.projectRoot === root ? sessions.get(sdkSessionId) : undefined,
      ),
    ),
  };
  const process: ClaudeProcessPort = {
    probeVersion: vi.fn(() => Effect.succeed("2.1.211")),
    probeSubscription: vi.fn(() => Effect.succeed("authenticated" as const)),
    spawn: vi.fn() as ClaudeProcessPort["spawn"],
  };
  const credentialResolver: ProviderCredentialResolver = {
    has: vi.fn(async () => true),
    resolve: vi.fn(async () => "api-key-secret-sentinel"),
  };
  const releasedEnvironments: NodeJS.ProcessEnv[] = [];
  const makeEnvironmentScope = (
    mode: ClaudeAuthentication,
    options?: { readonly apiKey?: string },
  ): Effect.Effect<ClaudeEnvironmentScope, ProviderFailure, Scope.Scope> =>
    Effect.acquireRelease(
      Effect.sync(() => ({
        environment:
          mode === "api-key"
            ? { PATH: "/usr/bin", ANTHROPIC_API_KEY: options?.apiKey }
            : { PATH: "/usr/bin", CLAUDE_CONFIG_DIR: "/provider-native" },
      })),
      ({ environment }) =>
        Effect.sync(() => {
          delete environment.ANTHROPIC_API_KEY;
          releasedEnvironments.push(environment);
        }),
    );
  const runtimeRegistry = new ProviderRuntimeRegistry();
  runtimeRegistry.setObservedState({
    instanceId,
    readiness: "ready",
    processState: "stopped",
    detectedVersion: "2.1.211",
    models: [
      {
        id: modelId,
        displayName: "Claude Sonnet",
        source: "discovered",
        verification: "verified",
        reasoning: "supported",
        inputModalities: ["text"],
        options: [
          { id: "effort", displayName: "Effort", kind: "selection", values: ["low", "high"] },
        ],
      },
    ],
    capabilities: readyCapabilities,
    lastSuccessfulProbeAt: observedAt,
    observedAt,
  });
  const resumeIdentities = new Map<string, ClaudeResumeIdentity>();
  const resumeIdentityPort: ClaudeResumeIdentityPort = {
    lookup: vi.fn(async ({ sdkSessionId }, signal) => {
      if (signal.aborted) throw new Error("cancelled");
      return resumeIdentities.get(sdkSessionId);
    }),
    put: vi.fn(async (identity, signal) => {
      if (signal.aborted) throw new Error("cancelled");
      resumeIdentities.set(identity.sdkSessionId, identity);
    }),
    remove: vi.fn(async ({ sdkSessionId }, signal) => {
      if (signal.aborted) throw new Error("cancelled");
      resumeIdentities.delete(sdkSessionId);
    }),
  };
  const makeDriver = (selectedAuthentication = authentication) =>
    makeClaudeDriver({
      instanceId,
      binaryPath: "/opt/homebrew/bin/claude",
      authentication: selectedAuthentication,
      process,
      sdk,
      credentialResolver,
      runtimeRegistry,
      resumeIdentityPort,
      permissionPersistence: () => permissionPersistence,
      makeEnvironmentScope,
      isProjectConfinedPath: (root, absolutePath) => absolutePath.startsWith(`${root}/`),
      clock: () => observedAt,
      correlationId: () => "80000000-0000-4000-8000-000000000710",
      requestId: () => `request-${++requestNumber}`,
      taskId: () => "task-1",
      toolCallId: () => "tool-1",
      startupTimeoutMs: 100,
      interruptTimeoutMs: 100,
    });
  const driver = makeDriver();
  return {
    credentialResolver,
    driver,
    makeEnvironmentScope,
    makeDriver,
    opens,
    process,
    queries,
    releasedEnvironments,
    runtimeRegistry,
    resumeIdentities,
    resumeIdentityPort,
    sdk,
    setOpenQuery: (implementation: ClaudeAgentSdkPort["openQuery"]) => {
      openQueryImpl = implementation;
    },
    sessions,
  };
}

async function acquire(driver: ReturnType<typeof makeClaudeDriver>) {
  const scope = await Effect.runPromise(Scope.make());
  const connection = await Effect.runPromise(
    driver.acquire({ instanceId, projectRoot }).pipe(Effect.provideService(Scope.Scope, scope)),
  );
  return { connection, close: () => Effect.runPromise(Scope.close(scope, Exit.void)) };
}

describe("Claude execution policy", () => {
  it("maps every Octant policy to the exact Claude permission options", () => {
    expect(claudeExecutionOptions("full-access")).toEqual({
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      tools: ["Read", "Grep", "Glob", "Edit", "Write", "Bash", "AskUserQuestion"],
    });
    expect(claudeExecutionOptions("approval-gated")).toEqual({
      permissionMode: "default",
      allowDangerouslySkipPermissions: false,
      tools: ["Read", "Grep", "Glob", "Edit", "Write", "Bash", "AskUserQuestion"],
    });
    expect(claudeExecutionOptions("plan")).toEqual({
      permissionMode: "plan",
      allowDangerouslySkipPermissions: false,
      tools: ["Read", "Glob", "Grep"],
    });
  });

  it("configures the strict exact-root sandbox only for approval-gated sessions", async () => {
    for (const executionPolicy of ["full-access", "approval-gated", "plan"] as const) {
      const f = harness();
      const acquired = await acquire(f.driver);
      await Effect.runPromise(acquired.connection.start({ sessionId, modelId, executionPolicy }));

      expect(f.opens[0]?.sandbox).toEqual(
        executionPolicy === "approval-gated"
          ? {
              enabled: true,
              failIfUnavailable: true,
              allowUnsandboxedCommands: false,
              autoAllowBashIfSandboxed: false,
              filesystem: {
                denyRead: ["/"],
                allowRead: [projectRoot],
                allowWrite: [projectRoot],
              },
            }
          : undefined,
      );

      await acquired.close();
    }
  });

  it("runs the pre-tool gate before Full-access callbacks without fabricating approvals", async () => {
    const f = harness();
    const acquired = await acquire(f.driver);
    await Effect.runPromise(
      acquired.connection.start({ sessionId, modelId, executionPolicy: "full-access" }),
    );
    const open = f.opens[0]!;
    const request = {
      toolName: "Bash",
      input: { command: "printf hidden" },
      toolUseId: "tool-use-early",
      signal: new AbortController().signal,
    } as const;

    await expect(open.canUseTool(request)).resolves.toMatchObject({ behavior: "deny" });
    await expect(
      open.preToolUse({
        sessionId: "sdk-session-1",
        projectRoot,
        toolName: request.toolName,
        input: request.input,
        toolUseId: request.toolUseId,
        signal: request.signal,
      }),
    ).resolves.toMatchObject({ behavior: "deny" });
    const authorizedRequest = { ...request, toolUseId: "tool-use-full" };
    await expect(
      open.preToolUse({
        sessionId: "sdk-session-1",
        projectRoot,
        toolName: authorizedRequest.toolName,
        input: authorizedRequest.input,
        toolUseId: authorizedRequest.toolUseId,
        signal: authorizedRequest.signal,
      }),
    ).resolves.toEqual({ behavior: "allow" });
    await expect(open.canUseTool(authorizedRequest)).resolves.toEqual({ behavior: "allow" });
    await expect(
      open.preToolUse({
        sessionId: "sdk-session-1",
        projectRoot,
        toolName: "Agent",
        input: {},
        toolUseId: "native-agent",
        signal: request.signal,
      }),
    ).resolves.toMatchObject({ behavior: "deny" });
    const unknown = await Effect.runPromise(
      Effect.exit(
        acquired.connection.answerApproval({
          sessionId,
          requestId: "fabricated",
          approved: true,
        }),
      ),
    );
    expect(String(unknown)).toContain("protocol");

    await acquired.close();
  });

  it("expires an unmatched pre-tool grant and never reopens its tool-use ID", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000);
    const f = harness();
    const acquired = await acquire(f.driver);
    await Effect.runPromise(
      acquired.connection.start({ sessionId, modelId, executionPolicy: "approval-gated" }),
    );
    const open = f.opens[0]!;
    const signal = new AbortController().signal;
    const firstInput = { file_path: `${projectRoot}/README.md` };
    await expect(
      open.preToolUse({
        sessionId: "sdk-session-1",
        projectRoot,
        toolName: "Read",
        input: firstInput,
        toolUseId: "missing-callback",
        signal,
      }),
    ).resolves.toEqual({ behavior: "allow" });

    now.mockReturnValue(31_001);
    const nextInput = { file_path: `${projectRoot}/NEXT.md` };
    await expect(
      open.preToolUse({
        sessionId: "sdk-session-1",
        projectRoot,
        toolName: "Read",
        input: nextInput,
        toolUseId: "next-tool",
        signal,
      }),
    ).resolves.toEqual({ behavior: "allow" });
    await expect(
      open.canUseTool({
        toolName: "Read",
        input: firstInput,
        toolUseId: "missing-callback",
        signal,
      }),
    ).resolves.toMatchObject({ behavior: "deny" });
    await expect(
      open.preToolUse({
        sessionId: "sdk-session-1",
        projectRoot,
        toolName: "Read",
        input: firstInput,
        toolUseId: "missing-callback",
        signal,
      }),
    ).resolves.toMatchObject({ behavior: "deny" });

    await acquired.close();
    now.mockRestore();
  });

  it("tombstones an unmatched pre-tool grant when its turn completes", async () => {
    const f = harness();
    const acquired = await acquire(f.driver);
    await Effect.runPromise(
      acquired.connection.start({ sessionId, modelId, executionPolicy: "approval-gated" }),
    );
    const open = f.opens[0]!;
    const signal = new AbortController().signal;
    const input = { file_path: `${projectRoot}/README.md` };
    const terminalEvent = Effect.runPromise(collectTerminal(acquired.connection.events));
    await Effect.runPromise(
      acquired.connection.send({ sessionId, prompt: "first", attachments: [], tools: [] }),
    );
    await expect(
      open.preToolUse({
        sessionId: "sdk-session-1",
        projectRoot,
        toolName: "Read",
        input,
        toolUseId: "missing-at-terminal",
        signal,
      }),
    ).resolves.toEqual({ behavior: "allow" });
    await f.queries[0]!.emit(completed("sdk-session-1"));
    await expect(terminalEvent).resolves.toMatchObject({ value: { kind: "completed" } });

    await Effect.runPromise(
      acquired.connection.send({ sessionId, prompt: "second", attachments: [], tools: [] }),
    );
    await expect(
      open.preToolUse({
        sessionId: "sdk-session-1",
        projectRoot,
        toolName: "Read",
        input,
        toolUseId: "missing-at-terminal",
        signal,
      }),
    ).resolves.toMatchObject({ behavior: "deny" });
    await acquired.close();
  });

  it("terminal-fails once when unmatched pre-tool grants exhaust their hard cap", async () => {
    const f = harness();
    const acquired = await acquire(f.driver);
    await Effect.runPromise(
      acquired.connection.start({ sessionId, modelId, executionPolicy: "approval-gated" }),
    );
    const open = f.opens[0]!;
    const signal = new AbortController().signal;
    const observed: ProviderRuntimeEvent[] = [];
    const subscriber = Effect.runFork(
      Stream.runForEach(acquired.connection.events, (event) =>
        Effect.sync(() => {
          observed.push(event);
        }),
      ),
    );
    await Promise.resolve();
    for (let index = 0; index < 16; index += 1) {
      await expect(
        open.preToolUse({
          sessionId: "sdk-session-1",
          projectRoot,
          toolName: "Read",
          input: { file_path: `${projectRoot}/${index}.txt` },
          toolUseId: `missing-${index}`,
          signal,
        }),
      ).resolves.toEqual({ behavior: "allow" });
    }
    await expect(
      open.preToolUse({
        sessionId: "sdk-session-1",
        projectRoot,
        toolName: "Read",
        input: { file_path: `${projectRoot}/overflow.txt` },
        toolUseId: "missing-overflow",
        signal,
      }),
    ).resolves.toMatchObject({ behavior: "deny" });

    await vi.waitFor(() => expect(observed.some((event) => event.kind === "failed")).toBe(true));
    await vi.waitFor(() => expect(f.queries[0]?.close).toHaveBeenCalledOnce());
    await expect(
      open.preToolUse({
        sessionId: "sdk-session-1",
        projectRoot,
        toolName: "Read",
        input: { file_path: `${projectRoot}/late.txt` },
        toolUseId: "late-after-overflow",
        signal,
      }),
    ).resolves.toMatchObject({ behavior: "deny" });
    await acquired.close();
    await Effect.runPromise(Fiber.join(subscriber));
    expect(observed.filter((event) => event.kind === "failed")).toHaveLength(1);
    expect(f.runtimeRegistry.activeSessionCount(instanceId)).toBe(0);
  });

  it("terminal-fails before a turn can exceed its hard unique tool-use budget", async () => {
    const f = harness();
    const acquired = await acquire(f.driver);
    await Effect.runPromise(
      acquired.connection.start({ sessionId, modelId, executionPolicy: "approval-gated" }),
    );
    const open = f.opens[0]!;
    const signal = new AbortController().signal;
    for (let index = 0; index < 64; index += 1) {
      const input = { file_path: `${projectRoot}/${index}.txt` };
      await expect(
        open.preToolUse({
          sessionId: "sdk-session-1",
          projectRoot,
          toolName: "Read",
          input,
          toolUseId: `budget-${index}`,
          signal,
        }),
      ).resolves.toEqual({ behavior: "allow" });
      await expect(
        open.canUseTool({ toolName: "Read", input, toolUseId: `budget-${index}`, signal }),
      ).resolves.toEqual({ behavior: "allow" });
    }
    await expect(
      open.preToolUse({
        sessionId: "sdk-session-1",
        projectRoot,
        toolName: "Read",
        input: { file_path: `${projectRoot}/overflow.txt` },
        toolUseId: "budget-overflow",
        signal,
      }),
    ).resolves.toMatchObject({ behavior: "deny" });

    await vi.waitFor(() => expect(f.queries[0]?.close).toHaveBeenCalledOnce());
    expect(f.runtimeRegistry.activeSessionCount(instanceId)).toBe(0);
    await acquired.close();
  });

  it("preserves tombstones across turns and terminal-fails at the session tool-use budget", async () => {
    const f = harness();
    const acquired = await acquire(f.driver);
    await Effect.runPromise(
      acquired.connection.start({ sessionId, modelId, executionPolicy: "approval-gated" }),
    );
    const open = f.opens[0]!;
    const signal = new AbortController().signal;
    for (let turn = 0; turn < 4; turn += 1) {
      const terminalEvent = Effect.runPromise(collectTerminal(acquired.connection.events));
      await Effect.runPromise(
        acquired.connection.send({ sessionId, prompt: `turn-${turn}`, attachments: [], tools: [] }),
      );
      for (let index = 0; index < 64; index += 1) {
        const toolUseId = `session-${turn}-${index}`;
        const input = { file_path: `${projectRoot}/${turn}-${index}.txt` };
        await open.preToolUse({
          sessionId: "sdk-session-1",
          projectRoot,
          toolName: "Read",
          input,
          toolUseId,
          signal,
        });
        await open.canUseTool({ toolName: "Read", input, toolUseId, signal });
      }
      await f.queries[0]!.emit(completed("sdk-session-1"));
      await expect(terminalEvent).resolves.toMatchObject({ value: { kind: "completed" } });
    }
    await Effect.runPromise(
      acquired.connection.send({ sessionId, prompt: "overflow", attachments: [], tools: [] }),
    );
    await expect(
      open.preToolUse({
        sessionId: "sdk-session-1",
        projectRoot,
        toolName: "Read",
        input: { file_path: `${projectRoot}/overflow.txt` },
        toolUseId: "session-overflow",
        signal,
      }),
    ).resolves.toMatchObject({ behavior: "deny" });

    await vi.waitFor(() => expect(f.queries[0]?.close).toHaveBeenCalledOnce());
    expect(f.runtimeRegistry.activeSessionCount(instanceId)).toBe(0);
    await acquired.close();
  });

  it("terminal-fails and settles every callback when pending approvals exceed their cap", async () => {
    const f = harness();
    const acquired = await acquire(f.driver);
    await Effect.runPromise(
      acquired.connection.start({ sessionId, modelId, executionPolicy: "approval-gated" }),
    );
    const open = f.opens[0]!;
    const signal = new AbortController().signal;
    const pending: Promise<unknown>[] = [];
    for (let index = 0; index < 4; index += 1) {
      const input = {
        file_path: `${projectRoot}/${index}.ts`,
        old_string: "before",
        new_string: "after",
      };
      await open.preToolUse({
        sessionId: "sdk-session-1",
        projectRoot,
        toolName: "Edit",
        input,
        toolUseId: `approval-${index}`,
        signal,
      });
      pending.push(
        open.canUseTool({ toolName: "Edit", input, toolUseId: `approval-${index}`, signal }),
      );
    }
    const overflowInput = {
      file_path: `${projectRoot}/overflow.ts`,
      old_string: "before",
      new_string: "after",
    };
    await open.preToolUse({
      sessionId: "sdk-session-1",
      projectRoot,
      toolName: "Edit",
      input: overflowInput,
      toolUseId: "approval-overflow",
      signal,
    });
    const overflow = open.canUseTool({
      toolName: "Edit",
      input: overflowInput,
      toolUseId: "approval-overflow",
      signal,
    });
    const immediate = await Promise.race([
      overflow,
      new Promise<"pending">((resolve) => setTimeout(() => resolve("pending"), 0)),
    ]);

    expect(immediate).toMatchObject({ behavior: "deny" });
    await expect(Promise.all(pending)).resolves.toEqual(
      Array.from({ length: 4 }, () => expect.objectContaining({ behavior: "deny" })),
    );
    await vi.waitFor(() => expect(f.queries[0]?.close).toHaveBeenCalledOnce());
    const late = await Effect.runPromise(
      Effect.exit(
        acquired.connection.answerApproval({
          sessionId,
          requestId: "request-1",
          approved: true,
        }),
      ),
    );
    expect(String(late)).toContain("protocol");
    await acquired.close();
    expect(f.runtimeRegistry.activeSessionCount(instanceId)).toBe(0);
  });

  it("confines approval-gated and Plan tools while Plan stays strictly read-only", async () => {
    const plan = harness();
    const planConnection = await acquire(plan.driver);
    await Effect.runPromise(
      planConnection.connection.start({ sessionId, modelId, executionPolicy: "plan" }),
    );
    const planOpen = plan.opens[0]!;
    expect(planOpen.tools).toEqual(["Read", "Glob", "Grep"]);
    const signal = new AbortController().signal;
    const prePlan = (toolName: string, input: unknown, toolUseId: string) =>
      planOpen.preToolUse({
        sessionId: "sdk-session-1",
        projectRoot,
        toolName,
        input,
        toolUseId,
        signal,
      });
    await expect(
      prePlan("Write", { file_path: `${projectRoot}/blocked.txt`, content: "hidden" }, "write"),
    ).resolves.toMatchObject({ behavior: "deny" });
    await expect(
      prePlan("WebFetch", { url: "https://example.invalid" }, "web"),
    ).resolves.toMatchObject({
      behavior: "deny",
    });
    await expect(
      prePlan("Read", { file_path: "/tmp/outside-project.txt" }, "outside"),
    ).resolves.toMatchObject({ behavior: "deny" });
    const readInput = { file_path: `${projectRoot}/README.md` };
    await expect(prePlan("Read", readInput, "read")).resolves.toEqual({ behavior: "allow" });
    await expect(
      planOpen.canUseTool({
        toolName: "Read",
        input: readInput,
        toolUseId: "read",
        signal,
      }),
    ).resolves.toEqual({ behavior: "allow" });
    await planConnection.close();

    const gated = harness();
    const gatedConnection = await acquire(gated.driver);
    await Effect.runPromise(
      gatedConnection.connection.start({
        sessionId,
        modelId,
        executionPolicy: "approval-gated",
      }),
    );
    const gatedOpen = gated.opens[0]!;
    await expect(
      gatedOpen.preToolUse({
        sessionId: "sdk-session-1",
        projectRoot,
        toolName: "Edit",
        input: { file_path: `${projectRoot}/src/app.ts`, old_string: "a", new_string: "b" },
        toolUseId: "edit-inside",
        signal,
      }),
    ).resolves.toEqual({ behavior: "allow" });
    await expect(
      gatedOpen.preToolUse({
        sessionId: "sdk-session-1",
        projectRoot,
        toolName: "Edit",
        input: { file_path: "/tmp/outside.ts", old_string: "a", new_string: "b" },
        toolUseId: "edit-outside",
        signal,
      }),
    ).resolves.toMatchObject({ behavior: "deny" });
    await gatedConnection.close();
  });

  it.each([
    "cd /tmp && /bin/cat /etc/passwd",
    "$(/bin/cat /etc/passwd)",
    "env -i HOME=/tmp sh -c 'cat /etc/passwd'",
  ])("never treats pre-tool cwd validation as authorization for Bash: %s", async (command) => {
    const f = harness();
    const acquired = await acquire(f.driver);
    await Effect.runPromise(
      acquired.connection.start({ sessionId, modelId, executionPolicy: "approval-gated" }),
    );
    const open = f.opens[0]!;
    const signal = new AbortController().signal;
    const input = { command, cwd: projectRoot };
    const approvalEvent = Effect.runPromise(
      Stream.runHead(
        acquired.connection.events.pipe(
          Stream.filter((event) => event.kind === "approval-request"),
        ),
      ),
    );
    await expect(
      open.preToolUse({
        sessionId: "sdk-session-1",
        projectRoot,
        toolName: "Bash",
        input,
        toolUseId: "bash-escape",
        signal,
      }),
    ).resolves.toEqual({ behavior: "allow" });
    const callback = open.canUseTool({
      toolName: "Bash",
      input,
      toolUseId: "bash-escape",
      signal,
    });
    const first = await Promise.race([
      approvalEvent.then((event) => ({ kind: "approval" as const, event })),
      callback.then((decision) => ({ kind: "decision" as const, decision })),
    ]);

    expect(first.kind).toBe("approval");
    expect(open.sandbox).toMatchObject({
      enabled: true,
      failIfUnavailable: true,
      allowUnsandboxedCommands: false,
      autoAllowBashIfSandboxed: false,
    });
    await Effect.runPromise(
      acquired.connection.answerApproval({ sessionId, requestId: "request-1", approved: false }),
    );
    await expect(callback).resolves.toMatchObject({ behavior: "deny" });
    await acquired.close();
  });

  it.each(["current-session", "project-default"] as const)(
    "correlates approval answers atomically and degrades %s reuse to the active session",
    async (persistence) => {
      const f = harness("subscription", persistence);
      const acquired = await acquire(f.driver);
      await Effect.runPromise(
        acquired.connection.start({
          sessionId,
          modelId,
          executionPolicy: "approval-gated",
        }),
      );
      const open = f.opens[0]!;
      const signal = new AbortController().signal;
      const input = {
        file_path: `${projectRoot}/src/app.ts`,
        old_string: "private-old-content",
        new_string: "private-new-content",
      };
      const collectApproval = Effect.runPromise(
        Stream.runHead(
          acquired.connection.events.pipe(
            Stream.filter(
              (event) => event.sessionId === sessionId && event.kind === "approval-request",
            ),
          ),
        ),
      );
      await open.preToolUse({
        sessionId: "sdk-session-1",
        projectRoot,
        toolName: "Edit",
        input,
        toolUseId: "edit-approval",
        signal,
      });
      const callback = open.canUseTool({
        toolName: "Edit",
        input,
        toolUseId: "edit-approval",
        requestId: "provider-request-private",
        title: "provider-rule-private",
        signal,
      });
      const first = await Promise.race([
        collectApproval.then((result) => ({ kind: "event" as const, result })),
        callback.then((decision) => ({ kind: "decision" as const, decision })),
      ]);
      expect(first.kind).toBe("event");
      const event =
        first.kind === "event" && first.result._tag === "Some" ? first.result.value : undefined;
      expect(event).toMatchObject({
        kind: "approval-request",
        requestId: "request-1",
        action: "Edit",
      });
      expect(JSON.stringify(event)).not.toMatch(/private|provider-request/);

      await Effect.runPromise(
        acquired.connection.answerApproval({
          sessionId,
          requestId: "request-1",
          approved: true,
        }),
      );
      await expect(callback).resolves.toEqual({ behavior: "allow" });
      const duplicate = await Effect.runPromise(
        Effect.exit(
          acquired.connection.answerApproval({
            sessionId,
            requestId: "request-1",
            approved: true,
          }),
        ),
      );
      expect(String(duplicate)).toContain("protocol");
      await expect(
        open.preToolUse({
          sessionId: "sdk-session-1",
          projectRoot,
          toolName: "Edit",
          input,
          toolUseId: "edit-approval",
          signal,
        }),
      ).resolves.toMatchObject({ behavior: "deny" });

      await open.preToolUse({
        sessionId: "sdk-session-1",
        projectRoot,
        toolName: "Edit",
        input,
        toolUseId: "edit-reuse",
        signal,
      });
      const collectRepeatedApproval =
        persistence === "project-default"
          ? Effect.runPromise(
              Stream.runHead(
                acquired.connection.events.pipe(
                  Stream.filter(
                    (candidate) =>
                      candidate.sessionId === sessionId && candidate.kind === "approval-request",
                  ),
                ),
              ),
            )
          : undefined;
      if (collectRepeatedApproval !== undefined) await Promise.resolve();
      const repeated = open.canUseTool({
        toolName: "Edit",
        input,
        toolUseId: "edit-reuse",
        signal,
      });
      if (persistence === "current-session") {
        await expect(repeated).resolves.toEqual({ behavior: "allow" });
        const nextInput = { ...input, new_string: "different-approved-input" };
        const collectNextApproval = Effect.runPromise(
          Stream.runHead(
            acquired.connection.events.pipe(
              Stream.filter(
                (candidate) =>
                  candidate.sessionId === sessionId && candidate.kind === "approval-request",
              ),
            ),
          ),
        );
        await Promise.resolve();
        await open.preToolUse({
          sessionId: "sdk-session-1",
          projectRoot,
          toolName: "Edit",
          input: nextInput,
          toolUseId: "edit-next",
          signal,
        });
        const nextCallback = open.canUseTool({
          toolName: "Edit",
          input: nextInput,
          toolUseId: "edit-next",
          signal,
        });
        const nextApproval = await collectNextApproval;
        expect(nextApproval._tag).toBe("Some");
        if (event?.kind === "approval-request" && nextApproval._tag === "Some") {
          expect(nextApproval.value).toMatchObject({
            requestId: "request-2",
            sequence: event.sequence + 1,
          });
        }
        await Effect.runPromise(
          acquired.connection.answerApproval({
            sessionId,
            requestId: "request-2",
            approved: false,
          }),
        );
        await expect(nextCallback).resolves.toMatchObject({ behavior: "deny" });
      } else {
        const outcome = await Promise.race([
          collectRepeatedApproval!.then((result) => ({ kind: "event" as const, result })),
          repeated.then((decision) => ({ kind: "decision" as const, decision })),
        ]);
        expect(outcome.kind).toBe("event");
        const nextApproval = outcome.kind === "event" ? outcome.result : undefined;
        expect(nextApproval?._tag).toBe("Some");
        if (nextApproval?._tag === "Some") {
          expect(nextApproval.value).toMatchObject({ requestId: "request-2" });
        }
        await Effect.runPromise(
          acquired.connection.answerApproval({
            sessionId,
            requestId: "request-2",
            approved: true,
          }),
        );
        await expect(repeated).resolves.toEqual({ behavior: "allow" });
      }

      await acquired.close();
    },
  );

  it("fails closed and cancels the original approval when provider input changes", async () => {
    const f = harness();
    const acquired = await acquire(f.driver);
    await Effect.runPromise(
      acquired.connection.start({
        sessionId,
        modelId,
        executionPolicy: "approval-gated",
      }),
    );
    const open = f.opens[0]!;
    const controller = new AbortController();
    const original = {
      file_path: `${projectRoot}/src/app.ts`,
      old_string: "one",
      new_string: "two",
    };
    await open.preToolUse({
      sessionId: "sdk-session-1",
      projectRoot,
      toolName: "Edit",
      input: original,
      toolUseId: "changed-input",
      signal: controller.signal,
    });
    const callback = open.canUseTool({
      toolName: "Edit",
      input: original,
      toolUseId: "changed-input",
      signal: controller.signal,
    });
    await vi.waitFor(() => expect(callback).not.toHaveProperty("behavior"));

    const changed = { ...original, new_string: "three" };
    await open.preToolUse({
      sessionId: "sdk-session-1",
      projectRoot,
      toolName: "Edit",
      input: changed,
      toolUseId: "changed-input",
      signal: new AbortController().signal,
    });
    await expect(
      open.canUseTool({
        toolName: "Edit",
        input: changed,
        toolUseId: "changed-input",
        signal: new AbortController().signal,
      }),
    ).resolves.toMatchObject({ behavior: "deny" });
    const answer = await Effect.runPromise(
      Effect.exit(
        acquired.connection.answerApproval({
          sessionId,
          requestId: "request-1",
          approved: true,
        }),
      ),
    );
    expect(String(answer)).toContain("protocol");
    await expect(callback).resolves.toMatchObject({ behavior: "deny" });

    await acquired.close();
  });

  it("bounds and exactly correlates one outstanding user question per session", async () => {
    const f = harness();
    const acquired = await acquire(f.driver);
    await Effect.runPromise(
      acquired.connection.start({
        sessionId,
        modelId,
        executionPolicy: "approval-gated",
      }),
    );
    const open = f.opens[0]!;
    const signal = new AbortController().signal;
    const input = {
      questions: [
        {
          question: "  Choose a safe option  ",
          options: [
            { label: "One", description: "private-description-one" },
            { label: "Two", description: "private-description-two" },
          ],
          multiSelect: false,
        },
      ],
    };
    const collectQuestion = Effect.runPromise(
      Stream.runHead(
        acquired.connection.events.pipe(
          Stream.filter(
            (event) => event.sessionId === sessionId && event.kind === "user-input-request",
          ),
        ),
      ),
    );
    await open.preToolUse({
      sessionId: "sdk-session-1",
      projectRoot,
      toolName: "AskUserQuestion",
      input,
      toolUseId: "question-one",
      signal,
    });
    const callback = open.canUseTool({
      toolName: "AskUserQuestion",
      input,
      toolUseId: "question-one",
      signal,
    });
    const first = await Promise.race([
      collectQuestion.then((result) => ({ kind: "event" as const, result })),
      callback.then((decision) => ({ kind: "decision" as const, decision })),
    ]);
    expect(first.kind).toBe("event");
    const eventResult = first.kind === "event" ? first.result : undefined;
    expect(eventResult?._tag).toBe("Some");
    const event = eventResult?._tag === "Some" ? eventResult.value : undefined;
    expect(event).toMatchObject({
      kind: "user-input-request",
      requestId: "request-1",
      prompt: "Choose a safe option",
      options: ["One", "Two"],
    });
    expect(JSON.stringify(event)).not.toContain("private-description");

    const crossSession = await Effect.runPromise(
      Effect.exit(
        acquired.connection.answerUserInput({
          sessionId: otherSessionId,
          requestId: "request-1",
          answer: "One",
        }),
      ),
    );
    expect(String(crossSession)).toContain("protocol");
    const oversized = await Effect.runPromise(
      Effect.exit(
        acquired.connection.answerUserInput({
          sessionId,
          requestId: "request-1",
          answer: "x".repeat(4_097),
        }),
      ),
    );
    expect(String(oversized)).toContain("invalid-configuration");
    await Effect.runPromise(
      acquired.connection.answerUserInput({
        sessionId,
        requestId: "request-1",
        answer: "  One  ",
      }),
    );
    await expect(callback).resolves.toEqual({
      behavior: "allow",
      updatedInput: {
        ...input,
        answers: { "  Choose a safe option  ": "One" },
      },
    });
    const secondInput = {
      questions: [
        {
          question: "Second question",
          options: [{ label: "Only" }],
          multiSelect: false,
        },
      ],
    };
    const collectRetriedQuestion = Effect.runPromise(
      Stream.runHead(
        acquired.connection.events.pipe(
          Stream.filter(
            (candidate) =>
              candidate.sessionId === sessionId && candidate.kind === "user-input-request",
          ),
        ),
      ),
    );
    await open.preToolUse({
      sessionId: "sdk-session-1",
      projectRoot,
      toolName: "AskUserQuestion",
      input: secondInput,
      toolUseId: "question-two",
      signal,
    });
    const retriedCallback = open.canUseTool({
      toolName: "AskUserQuestion",
      input: secondInput,
      toolUseId: "question-two",
      signal,
    });
    const retriedEvent = await collectRetriedQuestion;
    expect(retriedEvent._tag).toBe("Some");
    if (event?.kind === "user-input-request" && retriedEvent._tag === "Some") {
      expect(retriedEvent.value).toMatchObject({
        requestId: "request-2",
        sequence: event.sequence + 1,
      });
    }
    await Effect.runPromise(
      acquired.connection.answerUserInput({
        sessionId,
        requestId: "request-2",
        answer: "Only",
      }),
    );
    await expect(retriedCallback).resolves.toMatchObject({ behavior: "allow" });
    const duplicate = await Effect.runPromise(
      Effect.exit(
        acquired.connection.answerUserInput({
          sessionId,
          requestId: "request-1",
          answer: "Two",
        }),
      ),
    );
    expect(String(duplicate)).toContain("protocol");

    await acquired.close();
  });

  it("terminal-fails and settles the active question when a second becomes pending", async () => {
    const f = harness();
    const acquired = await acquire(f.driver);
    await Effect.runPromise(
      acquired.connection.start({ sessionId, modelId, executionPolicy: "approval-gated" }),
    );
    const open = f.opens[0]!;
    const signal = new AbortController().signal;
    const questionInput = (question: string) => ({
      questions: [{ question, options: [{ label: "Yes" }], multiSelect: false }],
    });
    const firstInput = questionInput("First?");
    await open.preToolUse({
      sessionId: "sdk-session-1",
      projectRoot,
      toolName: "AskUserQuestion",
      input: firstInput,
      toolUseId: "question-cap-1",
      signal,
    });
    const first = open.canUseTool({
      toolName: "AskUserQuestion",
      input: firstInput,
      toolUseId: "question-cap-1",
      signal,
    });
    const secondInput = questionInput("Second?");
    await open.preToolUse({
      sessionId: "sdk-session-1",
      projectRoot,
      toolName: "AskUserQuestion",
      input: secondInput,
      toolUseId: "question-cap-2",
      signal,
    });
    await expect(
      open.canUseTool({
        toolName: "AskUserQuestion",
        input: secondInput,
        toolUseId: "question-cap-2",
        signal,
      }),
    ).resolves.toMatchObject({ behavior: "deny" });
    const firstOutcome = await Promise.race([
      first,
      new Promise<"pending">((resolve) => setTimeout(() => resolve("pending"), 0)),
    ]);

    expect(firstOutcome).toMatchObject({ behavior: "deny" });
    await vi.waitFor(() => expect(f.queries[0]?.close).toHaveBeenCalledOnce());
    const late = await Effect.runPromise(
      Effect.exit(
        acquired.connection.answerUserInput({
          sessionId,
          requestId: "request-1",
          answer: "Yes",
        }),
      ),
    );
    expect(String(late)).toContain("protocol");
    await acquired.close();
  });

  it("keeps user questions interactive in Full access without creating an approval", async () => {
    const f = harness();
    const acquired = await acquire(f.driver);
    await Effect.runPromise(
      acquired.connection.start({ sessionId, modelId, executionPolicy: "full-access" }),
    );
    const open = f.opens[0]!;
    const signal = new AbortController().signal;
    const input = {
      questions: [
        {
          question: "Continue?",
          options: [{ label: "Yes" }, { label: "No" }],
          multiSelect: false,
        },
      ],
    };
    const collect = Effect.runPromise(
      Stream.runHead(
        acquired.connection.events.pipe(
          Stream.filter((event) => event.kind === "user-input-request"),
        ),
      ),
    );
    await open.preToolUse({
      sessionId: "sdk-session-1",
      projectRoot,
      toolName: "AskUserQuestion",
      input,
      toolUseId: "full-question",
      signal,
    });
    const callback = open.canUseTool({
      toolName: "AskUserQuestion",
      input,
      toolUseId: "full-question",
      signal,
    });
    const first = await Promise.race([
      collect.then((result) => ({ kind: "event" as const, result })),
      callback.then((decision) => ({ kind: "decision" as const, decision })),
    ]);
    expect(first.kind).toBe("event");
    await Effect.runPromise(
      acquired.connection.answerUserInput({
        sessionId,
        requestId: "request-1",
        answer: "Yes",
      }),
    );
    await expect(callback).resolves.toMatchObject({ behavior: "allow" });
    const fabricatedApproval = await Effect.runPromise(
      Effect.exit(
        acquired.connection.answerApproval({
          sessionId,
          requestId: "request-1",
          approved: true,
        }),
      ),
    );
    expect(String(fabricatedApproval)).toContain("protocol");
    await acquired.close();
  });

  it("rejects invalid questions at the pre-tool gate and tombstones their tool-use ID", async () => {
    const f = harness();
    const acquired = await acquire(f.driver);
    await Effect.runPromise(
      acquired.connection.start({
        sessionId,
        modelId,
        executionPolicy: "approval-gated",
      }),
    );
    const open = f.opens[0]!;
    const signal = new AbortController().signal;
    const invalidInput = {
      questions: [
        {
          question: "Injected?",
          options: [{ label: "No" }],
          multiSelect: false,
        },
      ],
      answers: { "Injected?": "provider-supplied-answer" },
    };
    await expect(
      open.preToolUse({
        sessionId: "sdk-session-1",
        projectRoot,
        toolName: "AskUserQuestion",
        input: invalidInput,
        toolUseId: "invalid-question",
        signal,
      }),
    ).resolves.toEqual({
      behavior: "deny",
      message: "Claude user question input was invalid.",
    });
    await expect(
      open.canUseTool({
        toolName: "AskUserQuestion",
        input: invalidInput,
        toolUseId: "invalid-question",
        signal,
      }),
    ).resolves.toMatchObject({ behavior: "deny" });
    const validInput = {
      questions: [
        {
          question: "Valid?",
          options: [{ label: "Yes" }],
          multiSelect: false,
        },
      ],
    };
    await expect(
      open.preToolUse({
        sessionId: "sdk-session-1",
        projectRoot,
        toolName: "AskUserQuestion",
        input: validInput,
        toolUseId: "invalid-question",
        signal,
      }),
    ).resolves.toMatchObject({ behavior: "deny" });
    const collect = Effect.runPromise(
      Stream.runHead(
        acquired.connection.events.pipe(
          Stream.filter((event) => event.kind === "user-input-request"),
        ),
      ),
    );
    await Promise.resolve();
    await open.preToolUse({
      sessionId: "sdk-session-1",
      projectRoot,
      toolName: "AskUserQuestion",
      input: validInput,
      toolUseId: "valid-question",
      signal,
    });
    const callback = open.canUseTool({
      toolName: "AskUserQuestion",
      input: validInput,
      toolUseId: "valid-question",
      signal,
    });
    const event = await collect;
    expect(event._tag).toBe("Some");
    if (event._tag === "Some") {
      expect(event.value).toMatchObject({ requestId: "request-1", sequence: 1 });
    }
    await Effect.runPromise(
      acquired.connection.answerUserInput({
        sessionId,
        requestId: "request-1",
        answer: "Yes",
      }),
    );
    await expect(callback).resolves.toMatchObject({ behavior: "allow" });
    await acquired.close();
  });

  it("rejects an over-limit raw question before mapping any public request state", async () => {
    const f = harness();
    const acquired = await acquire(f.driver);
    await Effect.runPromise(
      acquired.connection.start({ sessionId, modelId, executionPolicy: "approval-gated" }),
    );
    const open = f.opens[0]!;
    const signal = new AbortController().signal;
    const input = {
      questions: [{ question: "q".repeat(1_025), options: [{ label: "Yes" }], multiSelect: false }],
    };
    await expect(
      open.preToolUse({
        sessionId: "sdk-session-1",
        projectRoot,
        toolName: "AskUserQuestion",
        input,
        toolUseId: "oversized-question",
        signal,
      }),
    ).resolves.toEqual({
      behavior: "deny",
      message: "Claude user question input was invalid.",
    });
    await expect(
      open.canUseTool({
        toolName: "AskUserQuestion",
        input,
        toolUseId: "oversized-question",
        signal,
      }),
    ).resolves.toMatchObject({ behavior: "deny" });
    const unknown = await Effect.runPromise(
      Effect.exit(
        acquired.connection.answerUserInput({
          sessionId,
          requestId: "request-1",
          answer: "Yes",
        }),
      ),
    );
    expect(String(unknown)).toContain("protocol");
    await acquired.close();
  });

  it("rejects a huge raw question without materializing it or traversing later input", async () => {
    const f = harness();
    const acquired = await acquire(f.driver);
    await Effect.runPromise(
      acquired.connection.start({ sessionId, modelId, executionPolicy: "approval-gated" }),
    );
    const open = f.opens[0]!;
    const signal = new AbortController().signal;
    const hugePrompt = "😀".repeat(1_000_000);
    let laterGetterReads = 0;
    const question: Record<string, unknown> = { question: hugePrompt };
    Object.defineProperty(question, "later", {
      enumerable: true,
      get: () => {
        laterGetterReads += 1;
        throw new Error("later provider input must not be traversed");
      },
    });
    const input = { questions: [question] };
    const arrayFrom = vi.spyOn(Array, "from");
    let materializedHugePrompt = false;

    try {
      await expect(
        open.preToolUse({
          sessionId: "sdk-session-1",
          projectRoot,
          toolName: "AskUserQuestion",
          input,
          toolUseId: "hostile-huge-question",
          signal,
        }),
      ).resolves.toEqual({
        behavior: "deny",
        message: "Claude user question input was invalid.",
      });
      materializedHugePrompt = arrayFrom.mock.calls.some(([value]) => value === hugePrompt);
    } finally {
      arrayFrom.mockRestore();
      await acquired.close();
    }

    expect(materializedHugePrompt).toBe(false);
    expect(laterGetterReads).toBe(0);
  });

  it("counts raw question limits by Unicode code point without collecting them", async () => {
    const f = harness();
    const acquired = await acquire(f.driver);
    await Effect.runPromise(
      acquired.connection.start({ sessionId, modelId, executionPolicy: "approval-gated" }),
    );
    const open = f.opens[0]!;
    const signal = new AbortController().signal;
    const exactPrompt = "😀".repeat(1_024);
    const overPrompt = `${exactPrompt}😀`;
    const input = (question: string) => ({
      questions: [{ question, options: [{ label: "Yes" }], multiSelect: false }],
    });
    const arrayFrom = vi.spyOn(Array, "from");
    let materializedBoundaryPrompt = false;

    try {
      await expect(
        open.preToolUse({
          sessionId: "sdk-session-1",
          projectRoot,
          toolName: "AskUserQuestion",
          input: input(exactPrompt),
          toolUseId: "exact-question-boundary",
          signal,
        }),
      ).resolves.toEqual({ behavior: "allow" });
      await expect(
        open.preToolUse({
          sessionId: "sdk-session-1",
          projectRoot,
          toolName: "AskUserQuestion",
          input: input(overPrompt),
          toolUseId: "over-question-boundary",
          signal,
        }),
      ).resolves.toEqual({
        behavior: "deny",
        message: "Claude user question input was invalid.",
      });
      materializedBoundaryPrompt = arrayFrom.mock.calls.some(
        ([value]) => value === exactPrompt || value === overPrompt,
      );
    } finally {
      arrayFrom.mockRestore();
      await acquired.close();
    }

    expect(materializedBoundaryPrompt).toBe(false);
  });

  it("counts user answer limits by Unicode code point without collecting them", async () => {
    const f = harness();
    const acquired = await acquire(f.driver);
    await Effect.runPromise(
      acquired.connection.start({ sessionId, modelId, executionPolicy: "approval-gated" }),
    );
    const open = f.opens[0]!;
    const signal = new AbortController().signal;
    const input = {
      questions: [
        { question: "  Preserve this exact provider key  ", options: [{ label: "Yes" }] },
      ],
    };
    await open.preToolUse({
      sessionId: "sdk-session-1",
      projectRoot,
      toolName: "AskUserQuestion",
      input,
      toolUseId: "answer-boundary",
      signal,
    });
    const callback = open.canUseTool({
      toolName: "AskUserQuestion",
      input,
      toolUseId: "answer-boundary",
      signal,
    });
    await Promise.resolve();
    const exactAnswer = "😀".repeat(4_096);
    const overAnswer = `${exactAnswer}😀`;
    const arrayFrom = vi.spyOn(Array, "from");
    let materializedBoundaryAnswer = false;

    try {
      const oversized = await Effect.runPromise(
        Effect.exit(
          acquired.connection.answerUserInput({
            sessionId,
            requestId: "request-1",
            answer: overAnswer,
          }),
        ),
      );
      expect(String(oversized)).toContain("invalid-configuration");
      await Effect.runPromise(
        acquired.connection.answerUserInput({
          sessionId,
          requestId: "request-1",
          answer: exactAnswer,
        }),
      );
      materializedBoundaryAnswer = arrayFrom.mock.calls.some(
        ([value]) => value === exactAnswer || value === overAnswer,
      );
      await expect(callback).resolves.toEqual({
        behavior: "allow",
        updatedInput: {
          ...input,
          answers: { "  Preserve this exact provider key  ": exactAnswer },
        },
      });
    } finally {
      arrayFrom.mockRestore();
      await acquired.close();
    }

    expect(materializedBoundaryAnswer).toBe(false);
  });

  it("rejects a huge whitespace-heavy user answer before trimming it", async () => {
    const f = harness();
    const acquired = await acquire(f.driver);
    await Effect.runPromise(
      acquired.connection.start({ sessionId, modelId, executionPolicy: "approval-gated" }),
    );
    const open = f.opens[0]!;
    const signal = new AbortController().signal;
    const input = {
      questions: [{ question: "Continue?", options: [{ label: "Yes" }] }],
    };
    await open.preToolUse({
      sessionId: "sdk-session-1",
      projectRoot,
      toolName: "AskUserQuestion",
      input,
      toolUseId: "huge-whitespace-answer",
      signal,
    });
    const callback = open.canUseTool({
      toolName: "AskUserQuestion",
      input,
      toolUseId: "huge-whitespace-answer",
      signal,
    });
    await Promise.resolve();
    const hugeAnswer = `${" ".repeat(500_000)}answer${" ".repeat(500_000)}`;
    const trim = vi.spyOn(String.prototype, "trim");

    try {
      const rejected = await Effect.runPromise(
        Effect.exit(
          acquired.connection.answerUserInput({
            sessionId,
            requestId: "request-1",
            answer: hugeAnswer,
          }),
        ),
      );
      expect(String(rejected)).toContain("invalid-configuration");
      expect(trim).not.toHaveBeenCalled();
    } finally {
      trim.mockRestore();
    }

    await Effect.runPromise(
      acquired.connection.answerUserInput({
        sessionId,
        requestId: "request-1",
        answer: "Yes",
      }),
    );
    await expect(callback).resolves.toMatchObject({ behavior: "allow" });
    await acquired.close();
  });

  it("denies callback races after a turn terminal until the next turn is accepted", async () => {
    const f = harness();
    const acquired = await acquire(f.driver);
    await Effect.runPromise(
      acquired.connection.start({
        sessionId,
        modelId,
        executionPolicy: "approval-gated",
      }),
    );
    const terminalEvent = Effect.runPromise(collectTerminal(acquired.connection.events));
    await Effect.runPromise(
      acquired.connection.send({ sessionId, prompt: "first", attachments: [], tools: [] }),
    );
    await f.queries[0]!.emit(completed("sdk-session-1"));
    expect((await terminalEvent)._tag).toBe("Some");

    const open = f.opens[0]!;
    const signal = new AbortController().signal;
    const request = {
      sessionId: "sdk-session-1",
      projectRoot,
      toolName: "Edit",
      input: { file_path: `${projectRoot}/src/app.ts`, old_string: "a", new_string: "b" },
      toolUseId: "post-terminal",
      signal,
    } as const;
    await expect(open.preToolUse(request)).resolves.toMatchObject({ behavior: "deny" });
    await expect(
      open.canUseTool({
        toolName: request.toolName,
        input: request.input,
        toolUseId: request.toolUseId,
        signal,
      }),
    ).resolves.toMatchObject({ behavior: "deny" });
    const postTerminalAnswer = await Effect.runPromise(
      Effect.exit(
        acquired.connection.answerUserInput({
          sessionId,
          requestId: "late-question",
          answer: "x".repeat(4_097),
        }),
      ),
    );
    expect(String(postTerminalAnswer)).toContain("protocol");

    await Effect.runPromise(
      acquired.connection.send({ sessionId, prompt: "second", attachments: [], tools: [] }),
    );
    await expect(open.preToolUse({ ...request, toolUseId: "next-turn" })).resolves.toEqual({
      behavior: "allow",
    });
    await acquired.close();
    expect(f.queries[0]?.close).toHaveBeenCalledOnce();
  });

  it("cancels pending callbacks and joins cleanup before connection release", async () => {
    const f = harness();
    const acquired = await acquire(f.driver);
    await Effect.runPromise(
      acquired.connection.start({
        sessionId,
        modelId,
        executionPolicy: "approval-gated",
      }),
    );
    const open = f.opens[0]!;
    const questionController = new AbortController();
    const questionInput = {
      questions: [
        {
          question: "Continue?",
          options: [{ label: "Yes" }, { label: "No" }],
          multiSelect: false,
        },
      ],
    };
    await open.preToolUse({
      sessionId: "sdk-session-1",
      projectRoot,
      toolName: "AskUserQuestion",
      input: questionInput,
      toolUseId: "cancelled-question",
      signal: questionController.signal,
    });
    const question = open.canUseTool({
      toolName: "AskUserQuestion",
      input: questionInput,
      toolUseId: "cancelled-question",
      signal: questionController.signal,
    });
    questionController.abort();
    await expect(question).resolves.toMatchObject({ behavior: "deny" });
    const lateQuestion = await Effect.runPromise(
      Effect.exit(
        acquired.connection.answerUserInput({
          sessionId,
          requestId: "request-1",
          answer: "Yes",
        }),
      ),
    );
    expect(String(lateQuestion)).toContain("protocol");

    const cancelledApprovalController = new AbortController();
    const cancelledApprovalInput = {
      file_path: `${projectRoot}/src/cancelled.ts`,
      old_string: "a",
      new_string: "b",
    };
    await open.preToolUse({
      sessionId: "sdk-session-1",
      projectRoot,
      toolName: "Edit",
      input: cancelledApprovalInput,
      toolUseId: "cancelled-approval",
      signal: cancelledApprovalController.signal,
    });
    const cancelledApproval = open.canUseTool({
      toolName: "Edit",
      input: cancelledApprovalInput,
      toolUseId: "cancelled-approval",
      signal: cancelledApprovalController.signal,
    });
    cancelledApprovalController.abort();
    await expect(cancelledApproval).resolves.toMatchObject({ behavior: "deny" });
    const lateCancelledApproval = await Effect.runPromise(
      Effect.exit(
        acquired.connection.answerApproval({
          sessionId,
          requestId: "request-2",
          approved: true,
        }),
      ),
    );
    expect(String(lateCancelledApproval)).toContain("protocol");

    const approvalInput = {
      file_path: `${projectRoot}/src/app.ts`,
      old_string: "a",
      new_string: "b",
    };
    const signal = new AbortController().signal;
    await open.preToolUse({
      sessionId: "sdk-session-1",
      projectRoot,
      toolName: "Edit",
      input: approvalInput,
      toolUseId: "release-approval",
      signal,
    });
    const approval = open.canUseTool({
      toolName: "Edit",
      input: approvalInput,
      toolUseId: "release-approval",
      signal,
    });
    await acquired.close();
    await expect(approval).resolves.toMatchObject({ behavior: "deny" });
    expect(f.queries[0]?.close).toHaveBeenCalledOnce();
    expect(f.runtimeRegistry.activeSessionCount(instanceId)).toBe(0);
    const lateApproval = await Effect.runPromise(
      Effect.exit(
        acquired.connection.answerApproval({
          sessionId,
          requestId: "request-3",
          approved: true,
        }),
      ),
    );
    expect(String(lateApproval)).toContain("protocol");
  });

  it("settles pending questions on interrupt and pending approvals on stop", async () => {
    const interruptedHarness = harness();
    const interruptedConnection = await acquire(interruptedHarness.driver);
    await Effect.runPromise(
      interruptedConnection.connection.start({
        sessionId,
        modelId,
        executionPolicy: "approval-gated",
      }),
    );
    await Effect.runPromise(
      interruptedConnection.connection.send({
        sessionId,
        prompt: "interrupt pending question",
        attachments: [],
        tools: [],
      }),
    );
    const open = interruptedHarness.opens[0]!;
    const signal = new AbortController().signal;
    const questionInput = {
      questions: [
        {
          question: "Continue?",
          options: [{ label: "Yes" }, { label: "No" }],
          multiSelect: false,
        },
      ],
    };
    await open.preToolUse({
      sessionId: "sdk-session-1",
      projectRoot,
      toolName: "AskUserQuestion",
      input: questionInput,
      toolUseId: "interrupt-question",
      signal,
    });
    const question = open.canUseTool({
      toolName: "AskUserQuestion",
      input: questionInput,
      toolUseId: "interrupt-question",
      signal,
    });
    const terminalEvent = Effect.runPromise(
      collectTerminal(interruptedConnection.connection.events),
    );
    const interruptExit = Effect.runPromise(
      Effect.exit(interruptedConnection.connection.interrupt(sessionId)),
    );
    await vi.waitFor(() => expect(interruptedHarness.queries[0]?.interrupt).toHaveBeenCalledOnce());
    await interruptedHarness.queries[0]!.emit(interrupted("sdk-session-1"));
    expect(Exit.isSuccess(await interruptExit)).toBe(true);
    await expect(question).resolves.toMatchObject({ behavior: "deny" });
    const terminalResult = await terminalEvent;
    expect(terminalResult._tag).toBe("Some");
    if (terminalResult._tag === "Some") expect(terminalResult.value.kind).toBe("interrupted");
    const lateQuestion = await Effect.runPromise(
      Effect.exit(
        interruptedConnection.connection.answerUserInput({
          sessionId,
          requestId: "request-1",
          answer: "Yes",
        }),
      ),
    );
    expect(String(lateQuestion)).toContain("protocol");
    expect(interruptedHarness.queries[0]?.close).toHaveBeenCalledOnce();
    await interruptedConnection.close();

    const stoppedHarness = harness();
    const stoppedConnection = await acquire(stoppedHarness.driver);
    await Effect.runPromise(
      stoppedConnection.connection.start({
        sessionId,
        modelId,
        executionPolicy: "approval-gated",
      }),
    );
    const stoppedOpen = stoppedHarness.opens[0]!;
    const approvalInput = {
      file_path: `${projectRoot}/src/stopped.ts`,
      old_string: "a",
      new_string: "b",
    };
    await stoppedOpen.preToolUse({
      sessionId: "sdk-session-1",
      projectRoot,
      toolName: "Edit",
      input: approvalInput,
      toolUseId: "stopped-approval",
      signal,
    });
    const approval = stoppedOpen.canUseTool({
      toolName: "Edit",
      input: approvalInput,
      toolUseId: "stopped-approval",
      signal,
    });
    await Effect.runPromise(stoppedConnection.connection.stop(sessionId));
    await expect(approval).resolves.toMatchObject({ behavior: "deny" });
    const lateApproval = await Effect.runPromise(
      Effect.exit(
        stoppedConnection.connection.answerApproval({
          sessionId,
          requestId: "request-1",
          approved: true,
        }),
      ),
    );
    expect(String(lateApproval)).toContain("protocol");
    expect(stoppedHarness.queries[0]?.close).toHaveBeenCalledOnce();
    expect(stoppedHarness.runtimeRegistry.activeSessionCount(instanceId)).toBe(0);
    await stoppedConnection.close();
  });

  it("clears both pending callback kinds on process-stream failure", async () => {
    const f = harness();
    const acquired = await acquire(f.driver);
    await Effect.runPromise(
      acquired.connection.start({
        sessionId,
        modelId,
        executionPolicy: "approval-gated",
      }),
    );
    await Effect.runPromise(
      acquired.connection.send({
        sessionId,
        prompt: "fail with pending callbacks",
        attachments: [],
        tools: [],
      }),
    );
    const open = f.opens[0]!;
    const signal = new AbortController().signal;
    const approvalInput = {
      file_path: `${projectRoot}/src/failed.ts`,
      old_string: "a",
      new_string: "b",
    };
    await open.preToolUse({
      sessionId: "sdk-session-1",
      projectRoot,
      toolName: "Edit",
      input: approvalInput,
      toolUseId: "failed-approval",
      signal,
    });
    const approval = open.canUseTool({
      toolName: "Edit",
      input: approvalInput,
      toolUseId: "failed-approval",
      signal,
    });
    const questionInput = {
      questions: [
        {
          question: "Continue?",
          options: [{ label: "Yes" }, { label: "No" }],
          multiSelect: false,
        },
      ],
    };
    await open.preToolUse({
      sessionId: "sdk-session-1",
      projectRoot,
      toolName: "AskUserQuestion",
      input: questionInput,
      toolUseId: "failed-question",
      signal,
    });
    const question = open.canUseTool({
      toolName: "AskUserQuestion",
      input: questionInput,
      toolUseId: "failed-question",
      signal,
    });
    const terminalEvent = Effect.runPromise(collectTerminal(acquired.connection.events));
    await f.queries[0]!.end();
    const terminalResult = await terminalEvent;
    expect(terminalResult._tag).toBe("Some");
    if (terminalResult._tag === "Some") expect(terminalResult.value.kind).toBe("interrupted");
    await expect(approval).resolves.toMatchObject({ behavior: "deny" });
    await expect(question).resolves.toMatchObject({ behavior: "deny" });
    for (const exit of await Promise.all([
      Effect.runPromise(
        Effect.exit(
          acquired.connection.answerApproval({
            sessionId,
            requestId: "request-1",
            approved: true,
          }),
        ),
      ),
      Effect.runPromise(
        Effect.exit(
          acquired.connection.answerUserInput({
            sessionId,
            requestId: "request-2",
            answer: "Yes",
          }),
        ),
      ),
    ])) {
      expect(String(exit)).toContain("protocol");
    }
    await acquired.close();
    expect(f.queries[0]?.close).toHaveBeenCalledOnce();
    expect(f.runtimeRegistry.activeSessionCount(instanceId)).toBe(0);
  });
});

function collectTerminal(
  events: Stream.Stream<ProviderRuntimeEvent, ProviderFailure>,
  id = sessionId,
) {
  return Stream.runHead(
    events.pipe(
      Stream.filter(
        (event) =>
          event.sessionId === id &&
          ["completed", "failed", "interrupted", "waiting"].includes(event.kind),
      ),
    ),
  );
}

describe("Claude driver probe", () => {
  it("rejects the wrong instance without probing any authentication source", async () => {
    const f = harness();
    const exit = await Effect.runPromise(
      Effect.scoped(Effect.exit(f.driver.probe({ instanceId: otherInstanceId }))),
    );
    expect(String(exit)).toContain("invalid-configuration");
    expect(f.process.probeVersion).not.toHaveBeenCalled();
    expect(f.process.probeSubscription).not.toHaveBeenCalled();
    expect(f.credentialResolver.has).not.toHaveBeenCalled();
    expect(f.credentialResolver.resolve).not.toHaveBeenCalled();
  });

  it("preserves sanitized missing-binary and malformed-version probe failures", async () => {
    for (const providerFailure of [
      { category: "unavailable" as const, message: "Claude binary is unavailable." },
      { category: "protocol" as const, message: "Claude version is malformed." },
    ]) {
      const f = harness();
      vi.mocked(f.process.probeVersion).mockReturnValue(Effect.fail(providerFailure));
      const exit = await Effect.runPromise(
        Effect.scoped(Effect.exit(f.driver.probe({ instanceId }))),
      );
      expect(String(exit)).toContain(providerFailure.category);
      expect(f.process.probeSubscription).not.toHaveBeenCalled();
      expect(f.opens).toHaveLength(0);
    }
  });

  it("uses only provider-native auth for subscription and releases the probe query scope", async () => {
    const f = harness("subscription");
    const result = await Effect.runPromise(Effect.scoped(f.driver.probe({ instanceId })));
    expect(f.process.probeSubscription).toHaveBeenCalledOnce();
    expect(f.credentialResolver.has).not.toHaveBeenCalled();
    expect(f.credentialResolver.resolve).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      readiness: "ready",
      processState: "stopped",
      detectedVersion: "2.1.211",
      models: [
        {
          id: modelId,
          source: "discovered",
          verification: "verified",
          reasoning: "supported",
          options: [{ id: "effort", kind: "selection", values: ["low", "high"] }],
        },
      ],
      capabilities: {
        streaming: "supported",
        nativeChildAgents: "unsupported",
        nativeAttachments: "unsupported",
        nativeWebResearch: "unsupported",
        appManagedTools: "unsupported",
        citations: "unsupported",
      },
      observedAt,
      lastSuccessfulProbeAt: observedAt,
    });
    expect(result.models[0]).not.toHaveProperty("contextLimit");
    expect(f.queries[0]?.supportedModels).toHaveBeenCalledOnce();
    expect(f.queries[0]?.accountInfo).toHaveBeenCalledOnce();
    expect(f.queries[0]?.close).toHaveBeenCalledOnce();
    expect(f.releasedEnvironments).toHaveLength(2);
  });

  it("opens the probe query with only the strict Plan tool allowlist", async () => {
    const f = harness("subscription");

    await Effect.runPromise(Effect.scoped(f.driver.probe({ instanceId })));

    expect(f.opens[0]).toMatchObject({
      executionPolicy: "plan",
      tools: ["Read", "Glob", "Grep"],
    });
  });

  it("reports an unauthenticated subscription without resolving or opening an API-key path", async () => {
    const f = harness("subscription");
    vi.mocked(f.process.probeSubscription).mockReturnValue(
      Effect.succeed("unauthenticated" as const),
    );
    const result = await Effect.runPromise(Effect.scoped(f.driver.probe({ instanceId })));
    expect(result).toMatchObject({
      readiness: "unauthenticated",
      processState: "stopped",
      detectedVersion: "2.1.211",
      models: [],
    });
    expect(result).not.toHaveProperty("credentialStatus");
    expect(f.credentialResolver.has).not.toHaveBeenCalled();
    expect(f.credentialResolver.resolve).not.toHaveBeenCalled();
    expect(f.opens).toHaveLength(0);
  });

  it("uses only the broker key for API-key auth and clears it when the probe scope releases", async () => {
    const f = harness("api-key");
    const result = await Effect.runPromise(Effect.scoped(f.driver.probe({ instanceId })));
    expect(f.process.probeSubscription).not.toHaveBeenCalled();
    expect(f.credentialResolver.has).toHaveBeenCalledOnce();
    expect(f.credentialResolver.resolve).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ readiness: "ready", credentialStatus: "stored" });
    expect(f.opens[0]?.authEnvironment.ANTHROPIC_API_KEY).toBe("api-key-secret-sentinel");
    expect(f.releasedEnvironments[0]?.ANTHROPIC_API_KEY).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain("api-key-secret-sentinel");
  });

  it("reports a missing selected API key without probing subscription or opening the SDK", async () => {
    const f = harness("api-key");
    vi.mocked(f.credentialResolver.has).mockResolvedValue(false);
    const result = await Effect.runPromise(Effect.scoped(f.driver.probe({ instanceId })));
    expect(result).toMatchObject({
      readiness: "unauthenticated",
      credentialStatus: "missing",
      models: [],
    });
    expect(f.credentialResolver.resolve).not.toHaveBeenCalled();
    expect(f.process.probeSubscription).not.toHaveBeenCalled();
    expect(f.opens).toHaveLength(0);
  });

  it("publishes an unavailable credential observation without reflecting broker failures", async () => {
    const broker = harness("api-key");
    vi.mocked(broker.credentialResolver.has).mockRejectedValue(new Error("private broker token"));
    const observation = await Effect.runPromise(Effect.scoped(broker.driver.probe({ instanceId })));
    expect(observation).toMatchObject({
      readiness: "unavailable",
      processState: "stopped",
      detectedVersion: "2.1.211",
      credentialStatus: "unavailable",
      models: [],
      message: "Claude credential broker is unavailable. Restart Octant and try again.",
    });
    expect(JSON.stringify(observation)).not.toContain("private broker token");
    expect(broker.credentialResolver.resolve).not.toHaveBeenCalled();
    expect(broker.process.probeSubscription).not.toHaveBeenCalled();
    expect(broker.opens).toHaveLength(0);
    expect(broker.releasedEnvironments).toHaveLength(0);

    const resolveFailure = harness("api-key");
    vi.mocked(resolveFailure.credentialResolver.resolve).mockRejectedValue(
      new Error("private resolved secret detail"),
    );
    const resolveObservation = await Effect.runPromise(
      Effect.scoped(resolveFailure.driver.probe({ instanceId })),
    );
    expect(resolveObservation).toMatchObject({
      readiness: "unavailable",
      detectedVersion: "2.1.211",
      credentialStatus: "unavailable",
      models: [],
    });
    expect(JSON.stringify(resolveObservation)).not.toContain("private resolved secret detail");
    expect(resolveFailure.opens).toHaveLength(0);
    expect(resolveFailure.releasedEnvironments).toHaveLength(0);
  });

  it("sanitizes SDK initialization failures", async () => {
    const sdk = harness("subscription");
    sdk.setOpenQuery(() =>
      Effect.fail({ category: "protocol", message: "private managed policy detail" }),
    );
    const observation = await Effect.runPromise(Effect.scoped(sdk.driver.probe({ instanceId })));
    expect(observation).toMatchObject({
      readiness: "incompatible",
      models: [],
      message: "Claude runtime policy is incompatible with Octant.",
    });
    expect(JSON.stringify(observation)).not.toContain("private managed policy detail");
  });

  it("reports an unmanaged SDK command surface as incompatible and closes the probe query", async () => {
    const f = harness("subscription");
    f.setOpenQuery((input) => {
      const query = new FakeQuery("command-probe", undefined, input.model);
      f.queries.push(query);
      return Effect.acquireRelease(Effect.succeed(query), (value) => value.close()).pipe(
        Effect.flatMap(() =>
          Effect.fail({
            category: "protocol" as const,
            message: "Claude initialized an unexpected runtime surface.",
          }),
        ),
      );
    });

    const observation = await Effect.runPromise(Effect.scoped(f.driver.probe({ instanceId })));

    expect(observation).toMatchObject({
      readiness: "incompatible",
      models: [],
      message: "Claude initialized an unexpected runtime surface.",
    });
    expect(JSON.stringify(observation)).not.toContain("command-probe");
    expect(f.queries[0]?.close).toHaveBeenCalledOnce();
  });

  it("reports unsupported managed account routing as incompatible", async () => {
    const f = harness("subscription");
    f.setOpenQuery((input) => {
      const query = new FakeQuery("managed-account", undefined, input.model);
      query.accountInfo.mockReturnValue(Effect.succeed({ ready: true, apiProvider: "bedrock" }));
      return Effect.acquireRelease(Effect.succeed(query), (value) => value.close());
    });
    const observation = await Effect.runPromise(Effect.scoped(f.driver.probe({ instanceId })));
    expect(observation).toMatchObject({
      readiness: "incompatible",
      models: [],
      message: "Claude initialized an unsupported account routing policy.",
    });
  });

  it("reports a runtime initialization/version mismatch as incompatible", async () => {
    const f = harness("subscription");
    f.setOpenQuery((input) => {
      const message = initialized("version-mismatch", projectRoot, input.model);
      const query = new FakeQuery(
        "version-mismatch",
        Stream.make({ ...message, runtimeVersion: "9.9.9" } as ClaudeDecodedMessage),
        input.model,
      );
      return Effect.acquireRelease(Effect.succeed(query), (value) => value.close());
    });
    const observation = await Effect.runPromise(Effect.scoped(f.driver.probe({ instanceId })));
    expect(observation).toMatchObject({
      readiness: "incompatible",
      detectedVersion: "2.1.211",
      models: [],
      message: "Claude initialization version did not match the configured binary.",
    });
  });

  it("reports a probe that returns no usable models as incompatible", async () => {
    const f = harness("subscription");
    f.setOpenQuery((input) => {
      const query = new FakeQuery("empty-models", undefined, input.model);
      query.supportedModels.mockReturnValue(Effect.succeed([]));
      return Effect.acquireRelease(Effect.succeed(query), (value) => value.close());
    });
    const observation = await Effect.runPromise(Effect.scoped(f.driver.probe({ instanceId })));
    expect(observation).toMatchObject({
      readiness: "incompatible",
      detectedVersion: "2.1.211",
      models: [],
      message: "Claude returned no usable models.",
    });
  });
});

describe("Claude session lifecycle", () => {
  it("fails closed when the active runtime selects a nondefault output style", async () => {
    const f = harness("subscription");
    f.setOpenQuery((input) => {
      const query = new FakeQuery("styled-session", undefined, input.model);
      f.queries.push(query);
      return Effect.acquireRelease(Effect.succeed(query), (value) => value.close()).pipe(
        Effect.flatMap(() =>
          Effect.fail({
            category: "protocol" as const,
            message: "Claude initialized an unexpected runtime surface.",
          }),
        ),
      );
    });
    const acquired = await acquire(f.driver);

    const startExit = await Effect.runPromise(
      Effect.exit(
        acquired.connection.start({ sessionId, modelId, executionPolicy: "approval-gated" }),
      ),
    );

    expect(String(startExit)).toContain("protocol");
    expect(String(startExit)).toContain("unexpected runtime surface");
    expect(String(startExit)).not.toContain("styled-session");
    const sendExit = await Effect.runPromise(
      Effect.exit(
        acquired.connection.send({
          sessionId,
          prompt: "must not be sent",
          attachments: [],
          tools: [],
        }),
      ),
    );
    expect(String(sendExit)).toContain("protocol");
    expect(f.queries[0]?.send).not.toHaveBeenCalled();
    expect(f.queries[0]?.close).toHaveBeenCalledOnce();
    expect(f.resumeIdentities).toHaveLength(0);
    expect(f.resumeIdentityPort.put).not.toHaveBeenCalled();
    expect(f.runtimeRegistry.activeSessionCount(instanceId)).toBe(0);
    await acquired.close();
    expect(f.queries[0]?.close).toHaveBeenCalledOnce();
  });

  it("fails closed when an active query initializes with unsupported account routing", async () => {
    const f = harness("subscription");
    f.setOpenQuery((input) => {
      const query = new FakeQuery("managed-session", undefined, input.model, {
        ready: true,
        apiProvider: "bedrock",
      });
      f.queries.push(query);
      return Effect.acquireRelease(Effect.succeed(query), (value) => value.close());
    });
    const acquired = await acquire(f.driver);

    const startExit = await Effect.runPromise(
      Effect.exit(
        acquired.connection.start({ sessionId, modelId, executionPolicy: "approval-gated" }),
      ),
    );

    expect(String(startExit)).toContain("protocol");
    expect(String(startExit)).toContain("unsupported account routing policy");
    expect(String(startExit)).not.toContain("bedrock");
    const sendExit = await Effect.runPromise(
      Effect.exit(
        acquired.connection.send({
          sessionId,
          prompt: "must not be sent",
          attachments: [],
          tools: [],
        }),
      ),
    );
    expect(String(sendExit)).toContain("protocol");
    expect(f.queries[0]?.send).not.toHaveBeenCalled();
    expect(f.queries[0]?.close).toHaveBeenCalledOnce();
    expect(f.resumeIdentities).toHaveLength(0);
    expect(f.resumeIdentityPort.put).not.toHaveBeenCalled();
    expect(f.runtimeRegistry.activeSessionCount(instanceId)).toBe(0);
    await acquired.close();
    expect(f.queries[0]?.close).toHaveBeenCalledOnce();
  });

  it("aborts a held identity write without allowing late post-close mutation", async () => {
    const f = harness();
    const acquired = await acquire(f.driver);
    let receivedSignal: AbortSignal | undefined;
    let releaseLateWrite!: () => void;
    vi.mocked(f.resumeIdentityPort.put).mockImplementationOnce(
      (identity, ...signals: readonly unknown[]) =>
        new Promise<void>((resolve, reject) => {
          receivedSignal = signals[0] as AbortSignal | undefined;
          receivedSignal?.addEventListener("abort", () => reject(new Error("cancelled")), {
            once: true,
          });
          releaseLateWrite = () => {
            if (receivedSignal?.aborted) return;
            f.resumeIdentities.set(identity.sdkSessionId, identity);
            resolve();
          };
        }),
    );
    const order: string[] = [];
    const starting = Effect.runPromise(
      Effect.exit(
        acquired.connection.start({ sessionId, modelId, executionPolicy: "approval-gated" }),
      ),
    ).then((exit) => {
      order.push("start");
      return exit;
    });
    await vi.waitFor(() => expect(f.resumeIdentityPort.put).toHaveBeenCalledOnce());
    let closeSettled = false;
    const closing = acquired.close().then(() => {
      closeSettled = true;
      order.push("close");
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const abortedBeforeLateRelease = receivedSignal?.aborted === true;
    const closedBeforeLateRelease = closeSettled;
    releaseLateWrite();
    const [startExit] = await Promise.all([starting, closing]);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(abortedBeforeLateRelease).toBe(true);
    expect(closedBeforeLateRelease).toBe(true);
    expect(order).toEqual(["start", "close"]);
    expect(String(startExit)).toContain("unavailable");
    expect(f.resumeIdentities).toHaveLength(0);
    expect(f.resumeIdentityPort.remove).not.toHaveBeenCalled();
    expect(f.queries[0]?.close).toHaveBeenCalledOnce();
    expect(f.releasedEnvironments).toHaveLength(1);
    expect(f.runtimeRegistry.activeSessionCount(instanceId)).toBe(0);
  });

  it("cancels and joins a held version setup before connection finalization", async () => {
    const f = harness();
    const acquired = await acquire(f.driver);
    const observed: ProviderRuntimeEvent[] = [];
    const subscriber = Effect.runFork(
      Stream.runForEach(acquired.connection.events, (event) =>
        Effect.sync(() => {
          observed.push(event);
        }),
      ),
    );
    let releaseVersion!: (version: string) => void;
    const heldVersion = new Promise<string>((resolve) => {
      releaseVersion = resolve;
    });
    vi.mocked(f.process.probeVersion).mockReturnValue(Effect.promise(() => heldVersion));
    const order: string[] = [];

    const starting = Effect.runPromise(
      Effect.exit(
        acquired.connection.start({ sessionId, modelId, executionPolicy: "approval-gated" }),
      ),
    ).then((exit) => {
      order.push("start");
      return exit;
    });
    await vi.waitFor(() => expect(f.process.probeVersion).toHaveBeenCalledOnce());
    await acquired.close().then(() => {
      order.push("close");
    });
    releaseVersion("2.1.211");
    const startExit = await starting;

    const laterStart = await Effect.runPromise(
      Effect.exit(
        acquired.connection.start({
          sessionId: otherSessionId,
          modelId,
          executionPolicy: "approval-gated",
        }),
      ),
    );
    const lookupCalls = vi.mocked(f.resumeIdentityPort.lookup).mock.calls.length;
    const laterResume = await Effect.runPromise(
      Effect.exit(
        acquired.connection.resume({
          sessionId,
          resumeCursor: { driverKind: "claude", value: "post-close-sdk" },
          executionPolicy: "approval-gated",
        }),
      ),
    );
    if (Exit.isSuccess(startExit)) await Effect.runPromise(acquired.connection.stop(sessionId));
    if (Exit.isSuccess(laterStart)) {
      await Effect.runPromise(acquired.connection.stop(otherSessionId));
    }
    await Effect.runPromise(Fiber.join(subscriber));

    expect(order).toEqual(["start", "close"]);
    expect(String(startExit)).toContain("unavailable");
    expect(String(laterStart)).toContain("unavailable");
    expect(String(laterResume)).toContain("unavailable");
    expect(f.process.probeVersion).toHaveBeenCalledOnce();
    expect(f.resumeIdentityPort.lookup).toHaveBeenCalledTimes(lookupCalls);
    expect(f.resumeIdentityPort.put).not.toHaveBeenCalled();
    expect(f.opens).toHaveLength(0);
    expect(f.queries).toHaveLength(0);
    expect(f.releasedEnvironments).toHaveLength(1);
    expect(f.runtimeRegistry.activeSessionCount(instanceId)).toBe(0);
    expect(observed).toHaveLength(0);
  });

  it("reserves a duplicate start ID before async setup and rolls it back after failure", async () => {
    const f = harness();
    const acquired = await acquire(f.driver);
    let rejectFirst!: (error: unknown) => void;
    const heldVersion = new Promise<string>((_resolve, reject) => {
      rejectFirst = reject;
    });
    vi.mocked(f.process.probeVersion).mockImplementationOnce(() =>
      Effect.tryPromise({
        try: () => heldVersion,
        catch: (): ProviderFailure => ({
          category: "unavailable",
          message: "Claude version probe failed.",
        }),
      }),
    );

    const first = Effect.runPromise(
      Effect.exit(
        acquired.connection.start({ sessionId, modelId, executionPolicy: "approval-gated" }),
      ),
    );
    await vi.waitFor(() => expect(f.process.probeVersion).toHaveBeenCalledOnce());
    const duplicate = await Effect.runPromise(
      Effect.exit(
        acquired.connection.start({ sessionId, modelId, executionPolicy: "approval-gated" }),
      ),
    );
    rejectFirst(new Error("private version failure"));
    const failedFirst = await first;
    if (Exit.isSuccess(duplicate)) {
      await Effect.runPromise(acquired.connection.stop(sessionId));
    }

    const retried = await Effect.runPromise(
      acquired.connection.start({ sessionId, modelId, executionPolicy: "approval-gated" }),
    );

    expect(String(duplicate)).toContain("protocol");
    expect(String(failedFirst)).toContain("unavailable");
    expect(retried.sessionId).toBe(sessionId);
    expect(f.process.probeVersion).toHaveBeenCalledTimes(2);
    expect(f.opens).toHaveLength(1);
    expect(f.queries).toHaveLength(1);
    await acquired.close();
    expect(f.queries[0]?.close).toHaveBeenCalledOnce();
    expect(f.releasedEnvironments).toHaveLength(2);
    expect(f.runtimeRegistry.activeSessionCount(instanceId)).toBe(0);
  });

  it("revalidates only the selected authentication source before every session query", async () => {
    const subscription = harness("subscription");
    const subscriptionConnection = await acquire(subscription.driver);
    await Effect.runPromise(
      subscriptionConnection.connection.start({
        sessionId,
        modelId,
        executionPolicy: "approval-gated",
      }),
    );
    expect(subscription.process.probeVersion).toHaveBeenCalledOnce();
    expect(subscription.process.probeSubscription).toHaveBeenCalledOnce();
    expect(subscription.credentialResolver.has).not.toHaveBeenCalled();
    expect(subscription.credentialResolver.resolve).not.toHaveBeenCalled();
    await subscriptionConnection.close();

    const apiKey = harness("api-key");
    const apiConnection = await acquire(apiKey.driver);
    await Effect.runPromise(
      apiConnection.connection.start({
        sessionId,
        modelId,
        executionPolicy: "approval-gated",
      }),
    );
    expect(apiKey.process.probeVersion).toHaveBeenCalledOnce();
    expect(apiKey.process.probeSubscription).not.toHaveBeenCalled();
    expect(apiKey.credentialResolver.has).toHaveBeenCalledOnce();
    expect(apiKey.credentialResolver.resolve).toHaveBeenCalledOnce();
    await apiConnection.close();
  });

  it("preserves typed unauthenticated when a present API-key entry resolves empty", async () => {
    const f = harness("api-key");
    vi.mocked(f.credentialResolver.resolve).mockResolvedValue("   ");
    const acquired = await acquire(f.driver);

    const exit = await Effect.runPromise(
      Effect.exit(
        acquired.connection.start({ sessionId, modelId, executionPolicy: "approval-gated" }),
      ),
    );

    expect(String(exit)).toContain("unauthenticated");
    expect(String(exit)).not.toContain("provider-failed");
    expect(f.credentialResolver.has).toHaveBeenCalledOnce();
    expect(f.credentialResolver.resolve).toHaveBeenCalledOnce();
    expect(f.process.probeVersion).not.toHaveBeenCalled();
    expect(f.process.probeSubscription).not.toHaveBeenCalled();
    expect(f.opens).toHaveLength(0);
    expect(f.queries).toHaveLength(0);
    expect(f.releasedEnvironments).toHaveLength(0);
    expect(f.runtimeRegistry.activeSessionCount(instanceId)).toBe(0);
    await acquired.close();
  });

  it.each(["absent", "unverified"] as const)(
    "rejects an %s selected model before credentials, environment, process, or SDK work",
    async (modelState) => {
      const f = harness("api-key");
      const rejectedModelId = `claude-${modelState}` as ProviderModelId;
      if (modelState === "unverified") {
        const observed = f.runtimeRegistry.observedState(instanceId)!;
        f.runtimeRegistry.setObservedState({
          ...observed,
          models: [
            {
              id: rejectedModelId,
              displayName: "Unverified Claude",
              source: "manual",
              verification: "unverified",
              reasoning: "unavailable",
              inputModalities: ["text"],
              options: [],
            },
          ],
        });
      }
      const acquired = await acquire(f.driver);

      const exit = await Effect.runPromise(
        Effect.exit(
          acquired.connection.start({
            sessionId,
            modelId: rejectedModelId,
            executionPolicy: "approval-gated",
          }),
        ),
      );
      if (Exit.isSuccess(exit)) {
        await Effect.runPromise(acquired.connection.stop(sessionId));
      }

      expect(String(exit)).toContain("unsupported");
      expect(f.credentialResolver.has).not.toHaveBeenCalled();
      expect(f.credentialResolver.resolve).not.toHaveBeenCalled();
      expect(f.process.probeVersion).not.toHaveBeenCalled();
      expect(f.process.probeSubscription).not.toHaveBeenCalled();
      expect(f.opens).toHaveLength(0);
      expect(f.queries).toHaveLength(0);
      expect(f.releasedEnvironments).toHaveLength(0);
      expect(f.runtimeRegistry.activeSessionCount(instanceId)).toBe(0);
      await acquired.close();
    },
  );

  it("passes only a declared effort level to the Agent SDK query and drops the rest", async () => {
    const f = harness();
    const acquired = await acquire(f.driver);
    await Effect.runPromise(
      acquired.connection.start({
        sessionId,
        modelId,
        executionPolicy: "approval-gated",
        modelOptionValues: { effort: "high", "service-tier": "fast" },
      }),
    );
    // "medium" is a real SDK level, but the verified observation for this
    // model only declared low/high, so it must not be forwarded.
    await Effect.runPromise(
      acquired.connection.start({
        sessionId: otherSessionId,
        modelId,
        executionPolicy: "approval-gated",
        modelOptionValues: { effort: "medium" },
      }),
    );
    expect(f.opens.map(({ effort }) => effort)).toEqual(["high", undefined]);
    await acquired.close();
  });

  it("opens one isolated query per concurrent session with exact root, model, and policy", async () => {
    const f = harness();
    const acquired = await acquire(f.driver);
    const [first, second] = await Promise.all([
      Effect.runPromise(
        acquired.connection.start({ sessionId, modelId, executionPolicy: "approval-gated" }),
      ),
      Effect.runPromise(
        acquired.connection.start({
          sessionId: otherSessionId,
          modelId,
          executionPolicy: "plan",
        }),
      ),
    ]);
    expect(first.resumeCursor).toEqual({ driverKind: "claude", value: "sdk-session-1" });
    expect(second.resumeCursor).toEqual({ driverKind: "claude", value: "sdk-session-2" });
    expect(f.opens).toHaveLength(2);
    expect(
      f.opens.map(({ projectRoot: root, model, executionPolicy }) => ({
        root,
        model,
        executionPolicy,
      })),
    ).toEqual([
      { root: projectRoot, model: modelId, executionPolicy: "approval-gated" },
      { root: projectRoot, model: modelId, executionPolicy: "plan" },
    ]);
    expect(f.runtimeRegistry.activeSessionCount(instanceId)).toBe(2);
    await acquired.close();
    expect(f.queries.every((query) => query.close.mock.calls.length === 1)).toBe(true);
    expect(f.runtimeRegistry.activeSessionCount(instanceId)).toBe(0);
  });

  it("queues multiple turns through one query and emits exactly one terminal per turn", async () => {
    const f = harness();
    const acquired = await acquire(f.driver);
    await Effect.runPromise(
      acquired.connection.start({ sessionId, modelId, executionPolicy: "approval-gated" }),
    );
    const observed: ProviderRuntimeEvent[] = [];
    const subscriber = Effect.runFork(
      Stream.runForEach(acquired.connection.events, (event) =>
        Effect.sync(() => {
          observed.push(event);
        }),
      ),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    const terminal = Effect.runPromise(collectTerminal(acquired.connection.events));
    await Effect.runPromise(
      acquired.connection.send({ sessionId, prompt: "first", attachments: [], tools: [] }),
    );
    await Effect.runPromise(
      acquired.connection.send({ sessionId, prompt: "second", attachments: [], tools: [] }),
    );
    await f.queries[0]!.emit(completed("sdk-session-1"));
    await f.queries[0]!.emit(completed("sdk-session-1"));
    expect(f.queries[0]?.sent).toEqual(["first", "second"]);
    await expect(terminal).resolves.toMatchObject({ value: { kind: "completed" } });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(f.queries[0]?.close).not.toHaveBeenCalled();
    await acquired.close();
    await Effect.runPromise(Fiber.join(subscriber));
    expect(
      observed.filter(
        ({ kind }) =>
          kind === "completed" || kind === "failed" || kind === "interrupted" || kind === "waiting",
      ),
    ).toHaveLength(2);
    expect(f.queries[0]?.close).toHaveBeenCalledOnce();
  });

  it("keeps one query alive for a sequential turn after the prior turn completes", async () => {
    const f = harness();
    const acquired = await acquire(f.driver);
    await Effect.runPromise(
      acquired.connection.start({ sessionId, modelId, executionPolicy: "approval-gated" }),
    );

    const firstTerminal = Effect.runPromise(collectTerminal(acquired.connection.events));
    await Effect.runPromise(
      acquired.connection.send({ sessionId, prompt: "first", attachments: [], tools: [] }),
    );
    await f.queries[0]!.emit(completed("sdk-session-1"));
    await expect(firstTerminal).resolves.toMatchObject({ value: { kind: "completed" } });
    expect(f.queries[0]!.close).not.toHaveBeenCalled();

    const secondTerminal = Effect.runPromise(collectTerminal(acquired.connection.events));
    await Effect.runPromise(
      acquired.connection.send({ sessionId, prompt: "second", attachments: [], tools: [] }),
    );
    await f.queries[0]!.emit(completed("sdk-session-1"));
    await expect(secondTerminal).resolves.toMatchObject({ value: { kind: "completed" } });
    expect(f.opens).toHaveLength(1);
    expect(f.queries[0]!.sent).toEqual(["first", "second"]);
    expect(f.queries[0]!.close).not.toHaveBeenCalled();

    await acquired.close();
    expect(f.queries[0]!.close).toHaveBeenCalledOnce();
  });

  it("closes on a duplicate provider result without publishing a second terminal", async () => {
    const f = harness();
    const acquired = await acquire(f.driver);
    await Effect.runPromise(
      acquired.connection.start({ sessionId, modelId, executionPolicy: "approval-gated" }),
    );
    const observed: ProviderRuntimeEvent[] = [];
    const subscriber = Effect.runFork(
      Stream.runForEach(acquired.connection.events, (event) =>
        Effect.sync(() => {
          observed.push(event);
        }),
      ),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    await Effect.runPromise(
      acquired.connection.send({ sessionId, prompt: "one turn", attachments: [], tools: [] }),
    );
    await f.queries[0]!.emit(completed("sdk-session-1"));
    await f.queries[0]!.emit(completed("sdk-session-1"));
    await vi.waitFor(() => expect(f.queries[0]!.close).toHaveBeenCalledOnce());
    const sendAfterDuplicate = await Effect.runPromise(
      Effect.exit(
        acquired.connection.send({
          sessionId,
          prompt: "must fail closed",
          attachments: [],
          tools: [],
        }),
      ),
    );
    expect(String(sendAfterDuplicate)).toContain("protocol");
    await acquired.close();
    await Effect.runPromise(Fiber.join(subscriber));
    expect(
      observed.filter(
        ({ kind }) =>
          kind === "completed" || kind === "failed" || kind === "interrupted" || kind === "waiting",
      ),
    ).toHaveLength(1);
  });

  it("interrupts the exact query, waits for terminal, and closes its scope", async () => {
    const f = harness();
    const acquired = await acquire(f.driver);
    await Effect.runPromise(
      acquired.connection.start({ sessionId, modelId, executionPolicy: "approval-gated" }),
    );
    f.queries[0]!.interrupt.mockImplementation(() =>
      Effect.promise(async () => {
        await f.queries[0]!.emit(interrupted("sdk-session-1"));
      }),
    );
    const terminal = Effect.runPromise(collectTerminal(acquired.connection.events));
    await Effect.runPromise(
      acquired.connection.send({ sessionId, prompt: "interrupt me", attachments: [], tools: [] }),
    );
    await Effect.runPromise(acquired.connection.interrupt(sessionId));
    await expect(terminal).resolves.toMatchObject({ value: { kind: "interrupted" } });
    expect(f.queries[0]?.interrupt).toHaveBeenCalledOnce();
    expect(f.queries[0]?.close).toHaveBeenCalledOnce();
    await acquired.close();
  });

  it("maps query death after accepted work to one interruption and stop is idempotent", async () => {
    const f = harness();
    const clearObservedState = vi.spyOn(f.runtimeRegistry, "clearObservedState");
    const acquired = await acquire(f.driver);
    await Effect.runPromise(
      acquired.connection.start({ sessionId, modelId, executionPolicy: "approval-gated" }),
    );
    const terminal = Effect.runPromise(collectTerminal(acquired.connection.events));
    await Effect.runPromise(
      acquired.connection.send({ sessionId, prompt: "accepted", attachments: [], tools: [] }),
    );
    await f.queries[0]!.end();
    await expect(terminal).resolves.toMatchObject({ value: { kind: "interrupted" } });
    await Effect.runPromise(acquired.connection.stop(sessionId));
    await Effect.runPromise(acquired.connection.stop(sessionId));
    expect(f.queries[0]?.close).toHaveBeenCalledOnce();
    expect(f.runtimeRegistry.activeSessionCount(instanceId)).toBe(0);
    expect(clearObservedState).toHaveBeenCalledOnce();
    expect(f.runtimeRegistry.observedState(instanceId)).toBeUndefined();
    const subsequentStart = await Effect.runPromise(
      Effect.exit(
        acquired.connection.start({
          sessionId: otherSessionId,
          modelId,
          executionPolicy: "approval-gated",
        }),
      ),
    );
    expect(String(subsequentStart)).toContain("unsupported");
    expect(f.opens).toHaveLength(1);
    expect(f.queries).toHaveLength(1);
    await acquired.close();
  });

  it("maps query death before accepted work to Waiting rather than falsely Done", async () => {
    const f = harness();
    const clearObservedState = vi.spyOn(f.runtimeRegistry, "clearObservedState");
    const acquired = await acquire(f.driver);
    await Effect.runPromise(
      acquired.connection.start({ sessionId, modelId, executionPolicy: "approval-gated" }),
    );
    const terminal = Effect.runPromise(collectTerminal(acquired.connection.events));
    await f.queries[0]!.end();
    await expect(terminal).resolves.toMatchObject({ value: { kind: "waiting" } });
    expect(clearObservedState).toHaveBeenCalledOnce();
    expect(f.runtimeRegistry.observedState(instanceId)).toBeUndefined();
    const subsequentStart = await Effect.runPromise(
      Effect.exit(
        acquired.connection.start({
          sessionId: otherSessionId,
          modelId,
          executionPolicy: "approval-gated",
        }),
      ),
    );
    expect(String(subsequentStart)).toContain("unsupported");
    expect(f.opens).toHaveLength(1);
    expect(f.queries).toHaveLength(1);
    await acquired.close();
  });

  it("fails exactly once and revokes authority when the decoded permission mode drifts", async () => {
    const f = harness();
    let failStream!: () => void;
    const permissionDrift = Effect.async<never, ProviderFailure>((resume) => {
      failStream = () =>
        resume(
          Effect.fail({
            category: "protocol",
            message: "Claude returned an unsupported runtime message.",
          }),
        );
    });
    const query = new FakeQuery(
      "sdk-session-drift",
      Stream.concat(
        Stream.make(initialized("sdk-session-drift")),
        Stream.fromEffect(permissionDrift),
      ),
    );
    f.queries.push(query);
    f.setOpenQuery((input) => {
      f.opens.push({ ...input, authEnvironment: { ...input.authEnvironment } });
      return Effect.acquireRelease(Effect.succeed(query), (value) => value.close());
    });
    const acquired = await acquire(f.driver);
    const observed: ProviderRuntimeEvent[] = [];
    const subscriber = Effect.runFork(
      Stream.runForEach(acquired.connection.events, (event) =>
        Effect.sync(() => {
          observed.push(event);
        }),
      ),
    );
    await Effect.runPromise(
      acquired.connection.start({ sessionId, modelId, executionPolicy: "approval-gated" }),
    );
    const terminal = Effect.runPromise(collectTerminal(acquired.connection.events));

    failStream();

    await expect(terminal).resolves.toMatchObject({ value: { kind: "failed" } });
    await vi.waitFor(() => expect(query.close).toHaveBeenCalledOnce());
    expect(f.runtimeRegistry.observedState(instanceId)).toBeUndefined();
    const sendExit = await Effect.runPromise(
      Effect.exit(
        acquired.connection.send({
          sessionId,
          prompt: "must not be sent",
          attachments: [],
          tools: [],
        }),
      ),
    );
    expect(String(sendExit)).toContain("protocol");
    expect(query.send).not.toHaveBeenCalled();
    const open = f.opens[0]!;
    const toolRequest = {
      toolName: "Read",
      input: { file_path: `${projectRoot}/README.md` },
      toolUseId: "permission-drift-tool",
      signal: new AbortController().signal,
    } as const;
    await expect(
      open.preToolUse({
        sessionId: "sdk-session-drift",
        projectRoot,
        ...toolRequest,
      }),
    ).resolves.toMatchObject({ behavior: "deny" });
    await expect(open.canUseTool(toolRequest)).resolves.toMatchObject({ behavior: "deny" });
    await acquired.close();
    await Effect.runPromise(Fiber.join(subscriber));
    expect(
      observed.filter(({ kind }) =>
        ["completed", "failed", "interrupted", "waiting"].includes(kind),
      ),
    ).toHaveLength(1);
  });

  it("fails startup without identity or normalized output when subagent provenance is decoded", async () => {
    const f = harness();
    const query = new FakeQuery(
      "sdk-session-subagent",
      Stream.concat(
        Stream.make(initialized("sdk-session-subagent")),
        Stream.fail({
          category: "protocol",
          message: "Claude returned an unsupported runtime message.",
        }),
      ),
    );
    f.queries.push(query);
    f.setOpenQuery((input) => {
      f.opens.push({ ...input, authEnvironment: { ...input.authEnvironment } });
      return Effect.acquireRelease(Effect.succeed(query), (value) => value.close());
    });
    const acquired = await acquire(f.driver);
    const observed: ProviderRuntimeEvent[] = [];
    const subscriber = Effect.runFork(
      Stream.runForEach(acquired.connection.events, (event) =>
        Effect.sync(() => {
          observed.push(event);
        }),
      ),
    );

    const startExit = await Effect.runPromise(
      Effect.exit(
        acquired.connection.start({ sessionId, modelId, executionPolicy: "approval-gated" }),
      ),
    );

    expect(String(startExit)).toContain("protocol");
    await vi.waitFor(() => expect(query.close).toHaveBeenCalledOnce());
    expect(observed.map(({ kind }) => kind)).toEqual(["failed"]);
    expect(JSON.stringify(observed)).not.toContain("subagent");
    expect(f.resumeIdentities).toHaveLength(0);
    expect(f.resumeIdentityPort.put).not.toHaveBeenCalled();
    expect(f.runtimeRegistry.observedState(instanceId)).toBeUndefined();
    expect(f.runtimeRegistry.activeSessionCount(instanceId)).toBe(0);
    const sendExit = await Effect.runPromise(
      Effect.exit(
        acquired.connection.send({
          sessionId,
          prompt: "must not be sent",
          attachments: [],
          tools: [],
        }),
      ),
    );
    expect(String(sendExit)).toContain("protocol");
    expect(query.send).not.toHaveBeenCalled();
    const open = f.opens[0]!;
    await expect(
      open.canUseTool({
        toolName: "Read",
        input: { file_path: `${projectRoot}/README.md` },
        toolUseId: "subagent-after-failure",
        signal: new AbortController().signal,
      }),
    ).resolves.toMatchObject({ behavior: "deny" });
    await acquired.close();
    await Effect.runPromise(Fiber.join(subscriber));
  });

  it("joins in-flight terminal cleanup when the connection closes concurrently", async () => {
    const f = harness();
    const acquired = await acquire(f.driver);
    await Effect.runPromise(
      acquired.connection.start({ sessionId, modelId, executionPolicy: "approval-gated" }),
    );
    let finishClose!: () => void;
    const heldClose = new Promise<void>((resolve) => {
      finishClose = resolve;
    });
    f.queries[0]!.close.mockImplementation(() => Effect.promise(() => heldClose));
    await Effect.runPromise(
      acquired.connection.send({
        sessionId,
        prompt: "interrupt cleanup",
        attachments: [],
        tools: [],
      }),
    );
    await f.queries[0]!.emit(interrupted("sdk-session-1"));
    await vi.waitFor(() => expect(f.queries[0]!.close).toHaveBeenCalledOnce());

    let connectionClosed = false;
    const closing = acquired.close().then(() => {
      connectionClosed = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(connectionClosed).toBe(false);
    finishClose();
    await closing;
    expect(connectionClosed).toBe(true);
    expect(f.queries[0]!.close).toHaveBeenCalledOnce();
  });

  it("preserves partial output and emits a sanitized failure when the stream fails", async () => {
    const f = harness();
    const partial = new FakeQuery(
      "sdk-session-partial",
      Stream.concat(
        Stream.make(initialized("sdk-session-partial"), {
          kind: "stream-event",
          sessionId: "sdk-session-partial",
          event: { kind: "text-delta", index: 0, text: "partial" },
        } satisfies ClaudeDecodedMessage),
        Stream.fail({ category: "provider-failed", message: "private raw payload" }),
      ),
    );
    f.setOpenQuery(() => Effect.acquireRelease(Effect.succeed(partial), (query) => query.close()));
    const acquired = await acquire(f.driver);
    const events = Effect.runPromise(
      Stream.runCollect(
        acquired.connection.events.pipe(
          Stream.filter((event) => event.sessionId === sessionId),
          Stream.take(2),
        ),
      ),
    );
    await Effect.runPromise(
      acquired.connection.start({ sessionId, modelId, executionPolicy: "approval-gated" }),
    );
    const collected = Array.from(await events);
    expect(collected.map(({ kind }) => kind)).toEqual(["text-delta", "failed"]);
    expect(JSON.stringify(collected)).not.toContain("private raw payload");
    await acquired.close();
  });

  it("times out startup without retaining a scope, session, or credential", async () => {
    const f = harness("api-key");
    f.setOpenQuery(() => Effect.never);
    const acquired = await acquire(f.driver);
    const exit = await Effect.runPromise(
      Effect.exit(
        acquired.connection.start({ sessionId, modelId, executionPolicy: "approval-gated" }),
      ),
    );
    expect(String(exit)).toContain("unavailable");
    expect(f.runtimeRegistry.activeSessionCount(instanceId)).toBe(0);
    expect(f.releasedEnvironments[0]?.ANTHROPIC_API_KEY).toBeUndefined();
    await acquired.close();
  });
});

describe("Claude exact resume", () => {
  it("cancels and joins a resume held before SDK initialization", async () => {
    const f = harness();
    const acquired = await acquire(f.driver);
    const started = await Effect.runPromise(
      acquired.connection.start({ sessionId, modelId, executionPolicy: "approval-gated" }),
    );
    await Effect.runPromise(acquired.connection.stop(sessionId));
    const identityWrites = vi.mocked(f.resumeIdentityPort.put).mock.calls.length;
    const identityLookups = vi.mocked(f.resumeIdentityPort.lookup).mock.calls.length;
    const heldQuery = new FakeQuery("sdk-session-1", Stream.never, modelId);
    f.setOpenQuery((input) =>
      Effect.acquireRelease(
        Effect.sync(() => {
          f.opens.push({ ...input, authEnvironment: { ...input.authEnvironment } });
          f.queries.push(heldQuery);
          return heldQuery;
        }),
        (query) => query.close(),
      ),
    );
    const observed: ProviderRuntimeEvent[] = [];
    const subscriber = Effect.runFork(
      Stream.runForEach(acquired.connection.events, (event) =>
        Effect.sync(() => {
          observed.push(event);
        }),
      ),
    );
    const order: string[] = [];

    const resuming = Effect.runPromise(
      Effect.exit(
        acquired.connection.resume({
          sessionId,
          resumeCursor: started.resumeCursor!,
          executionPolicy: "approval-gated",
        }),
      ),
    ).then((exit) => {
      order.push("resume");
      return exit;
    });
    await vi.waitFor(() => {
      expect(f.queries).toHaveLength(2);
      expect(f.runtimeRegistry.activeSessionCount(instanceId)).toBe(1);
    });
    await acquired.close().then(() => {
      order.push("close");
    });
    const resumeExit = await resuming;
    const laterResume = await Effect.runPromise(
      Effect.exit(
        acquired.connection.resume({
          sessionId,
          resumeCursor: started.resumeCursor!,
          executionPolicy: "approval-gated",
        }),
      ),
    );
    await Effect.runPromise(Fiber.join(subscriber));

    expect(order).toEqual(["resume", "close"]);
    expect(String(resumeExit)).toContain("unavailable");
    expect(String(laterResume)).toContain("unavailable");
    expect(f.resumeIdentityPort.lookup).toHaveBeenCalledTimes(identityLookups + 1);
    expect(f.resumeIdentityPort.put).toHaveBeenCalledTimes(identityWrites);
    expect(f.queries).toHaveLength(2);
    expect(heldQuery.close).toHaveBeenCalledOnce();
    expect(f.releasedEnvironments).toHaveLength(2);
    expect(f.runtimeRegistry.activeSessionCount(instanceId)).toBe(0);
    expect(observed).toHaveLength(0);
  });

  it("preserves the prior resume identity when an identity refresh write fails", async () => {
    const f = harness();
    const acquired = await acquire(f.driver);
    const started = await Effect.runPromise(
      acquired.connection.start({ sessionId, modelId, executionPolicy: "approval-gated" }),
    );
    await Effect.runPromise(acquired.connection.stop(sessionId));
    vi.mocked(f.resumeIdentityPort.put).mockRejectedValueOnce(
      new Error("private identity write failure"),
    );

    const exit = await Effect.runPromise(
      Effect.exit(
        acquired.connection.resume({
          sessionId,
          resumeCursor: started.resumeCursor!,
          executionPolicy: "approval-gated",
        }),
      ),
    );

    expect(String(exit)).toContain("provider-failed");
    expect(f.resumeIdentities.has(started.resumeCursor!.value)).toBe(true);
    expect(f.queries).toHaveLength(2);
    expect(f.queries.every((query) => query.close.mock.calls.length === 1)).toBe(true);
    expect(f.runtimeRegistry.activeSessionCount(instanceId)).toBe(0);
    await acquired.close();
  });

  it("reserves a duplicate resume ID before identity lookup without opening a second query", async () => {
    const f = harness();
    const acquired = await acquire(f.driver);
    const started = await Effect.runPromise(
      acquired.connection.start({ sessionId, modelId, executionPolicy: "approval-gated" }),
    );
    await Effect.runPromise(acquired.connection.stop(sessionId));

    const identity = f.resumeIdentities.get(started.resumeCursor!.value)!;
    let releaseLookup!: (value: ClaudeResumeIdentity) => void;
    const heldLookup = new Promise<ClaudeResumeIdentity>((resolve) => {
      releaseLookup = resolve;
    });
    vi.mocked(f.resumeIdentityPort.lookup).mockImplementationOnce(async () => heldLookup);

    const resumeInput = {
      sessionId,
      resumeCursor: started.resumeCursor!,
      executionPolicy: "approval-gated" as const,
    };
    const first = Effect.runPromise(Effect.exit(acquired.connection.resume(resumeInput)));
    await vi.waitFor(() => expect(f.resumeIdentityPort.lookup).toHaveBeenCalledOnce());
    const duplicate = await Effect.runPromise(Effect.exit(acquired.connection.resume(resumeInput)));
    releaseLookup(identity);
    const resumed = await first;

    expect(String(duplicate)).toContain("protocol");
    expect(Exit.isSuccess(resumed)).toBe(true);
    expect(f.resumeIdentityPort.lookup).toHaveBeenCalledOnce();
    expect(f.sdk.findSession).toHaveBeenCalledOnce();
    expect(f.opens).toHaveLength(2);
    expect(f.queries).toHaveLength(2);
    await acquired.close();
    expect(f.queries.every((query) => query.close.mock.calls.length === 1)).toBe(true);
    expect(f.runtimeRegistry.activeSessionCount(instanceId)).toBe(0);
  });

  it("rejects a cross-session resume identity before SDK lookup and rolls back its reservation", async () => {
    const f = harness();
    const acquired = await acquire(f.driver);
    const started = await Effect.runPromise(
      acquired.connection.start({ sessionId, modelId, executionPolicy: "approval-gated" }),
    );
    await Effect.runPromise(acquired.connection.stop(sessionId));
    const stored = f.resumeIdentities.get(started.resumeCursor!.value)!;
    f.resumeIdentities.set(started.resumeCursor!.value, {
      ...stored,
      octantSessionId: otherSessionId,
    });
    const releasedBeforeResume = f.releasedEnvironments.length;
    const processCallsBeforeResume = vi.mocked(f.process.probeVersion).mock.calls.length;

    const exit = await Effect.runPromise(
      Effect.exit(
        acquired.connection.resume({
          sessionId,
          resumeCursor: started.resumeCursor!,
          executionPolicy: "approval-gated",
        }),
      ),
    );

    expect(String(exit)).toContain("stale-resume");
    expect(f.resumeIdentityPort.lookup).toHaveBeenCalledOnce();
    expect(f.sdk.findSession).not.toHaveBeenCalled();
    expect(f.opens).toHaveLength(1);
    expect(f.queries).toHaveLength(1);
    expect(f.process.probeVersion).toHaveBeenCalledTimes(processCallsBeforeResume);
    expect(f.releasedEnvironments).toHaveLength(releasedBeforeResume);
    expect(f.runtimeRegistry.activeSessionCount(instanceId)).toBe(0);

    f.resumeIdentities.set(started.resumeCursor!.value, stored);
    const retried = await Effect.runPromise(
      acquired.connection.resume({
        sessionId,
        resumeCursor: started.resumeCursor!,
        executionPolicy: "approval-gated",
      }),
    );
    expect(retried.sessionId).toBe(sessionId);
    await acquired.close();
    expect(f.queries).toHaveLength(2);
    expect(f.queries.every((query) => query.close.mock.calls.length === 1)).toBe(true);
  });

  it("resumes after driver recreation using injected identity, exact SDK root, and explicit ID", async () => {
    const f = harness();
    const acquired = await acquire(f.driver);
    const started = await Effect.runPromise(
      acquired.connection.start({ sessionId, modelId, executionPolicy: "approval-gated" }),
    );
    await Effect.runPromise(acquired.connection.stop(sessionId));
    await acquired.close();
    const recreated = await acquire(f.makeDriver());

    const wrong = await Effect.runPromise(
      Effect.exit(
        recreated.connection.resume({
          sessionId,
          resumeCursor: { driverKind: "codex", value: "sdk-session-1" },
          executionPolicy: "approval-gated",
        }),
      ),
    );
    expect(String(wrong)).toContain("stale-resume");

    const resumed = await Effect.runPromise(
      recreated.connection.resume({
        sessionId,
        resumeCursor: started.resumeCursor!,
        executionPolicy: "plan",
      }),
    );
    expect(resumed.resumeCursor).toEqual({ driverKind: "claude", value: "sdk-session-1" });
    expect(f.sdk.findSession).toHaveBeenCalledWith({
      sessionId: "sdk-session-1",
      projectRoot,
    });
    expect(f.opens.at(-1)).toMatchObject({
      projectRoot,
      model: modelId,
      executionPolicy: "plan",
      resumeSessionId: "sdk-session-1",
    });
    expect(f.opens.at(-1)).not.toHaveProperty("continue");
    expect(f.resumeIdentityPort.lookup).toHaveBeenCalledWith(
      {
        providerInstanceId: instanceId,
        sdkSessionId: "sdk-session-1",
      },
      expect.any(AbortSignal),
    );
    expect(f.resumeIdentityPort.put).toHaveBeenCalledWith(
      {
        providerInstanceId: instanceId,
        octantSessionId: sessionId,
        sdkSessionId: "sdk-session-1",
        projectRoot,
        modelId,
        authentication: "subscription",
      },
      expect.any(AbortSignal),
    );
    expect(JSON.stringify([...f.resumeIdentities.values()])).not.toContain("secret");
    await recreated.close();
  });

  it("fails closed for missing identity/history and mismatched root or auth source", async () => {
    const f = harness("subscription");
    const acquired = await acquire(f.driver);
    const unknown = await Effect.runPromise(
      Effect.exit(
        acquired.connection.resume({
          sessionId,
          resumeCursor: { driverKind: "claude", value: "most-recent" },
          executionPolicy: "approval-gated",
        }),
      ),
    );
    expect(String(unknown)).toContain("stale-resume");
    expect(f.sdk.findSession).not.toHaveBeenCalled();

    const started = await Effect.runPromise(
      acquired.connection.start({ sessionId, modelId, executionPolicy: "approval-gated" }),
    );
    await Effect.runPromise(acquired.connection.stop(sessionId));

    const wrongAuth = await acquire(f.makeDriver("api-key"));
    const authMismatch = await Effect.runPromise(
      Effect.exit(
        wrongAuth.connection.resume({
          sessionId: otherSessionId,
          resumeCursor: started.resumeCursor!,
          executionPolicy: "approval-gated",
        }),
      ),
    );
    expect(String(authMismatch)).toContain("stale-resume");
    expect(f.opens).toHaveLength(1);
    await wrongAuth.close();

    const wrongRootScope = await Effect.runPromise(Scope.make());
    const wrongRoot = await Effect.runPromise(
      f.driver
        .acquire({ instanceId, projectRoot: "/tmp/different-project" })
        .pipe(Effect.provideService(Scope.Scope, wrongRootScope)),
    );
    const rootMismatch = await Effect.runPromise(
      Effect.exit(
        wrongRoot.resume({
          sessionId: otherSessionId,
          resumeCursor: started.resumeCursor!,
          executionPolicy: "approval-gated",
        }),
      ),
    );
    expect(String(rootMismatch)).toContain("stale-resume");
    await Effect.runPromise(Scope.close(wrongRootScope, Exit.void));

    f.sessions.delete(started.resumeCursor!.value);
    const missing = await Effect.runPromise(
      Effect.exit(
        acquired.connection.resume({
          sessionId: otherSessionId,
          resumeCursor: started.resumeCursor!,
          executionPolicy: "approval-gated",
        }),
      ),
    );
    expect(String(missing)).toContain("stale-resume");
    await acquired.close();
  });

  it("rejects a resumed query that initializes with a different SDK session identity", async () => {
    const f = harness();
    const acquired = await acquire(f.driver);
    const started = await Effect.runPromise(
      acquired.connection.start({ sessionId, modelId, executionPolicy: "approval-gated" }),
    );
    await Effect.runPromise(acquired.connection.stop(sessionId));
    f.setOpenQuery((input) =>
      Effect.acquireRelease(
        Effect.succeed(new FakeQuery("wrong-sdk-session", undefined, input.model)),
        (query) => query.close(),
      ),
    );
    const exit = await Effect.runPromise(
      Effect.exit(
        acquired.connection.resume({
          sessionId: otherSessionId,
          resumeCursor: started.resumeCursor!,
          executionPolicy: "approval-gated",
        }),
      ),
    );
    expect(String(exit)).toMatch(/stale-resume|protocol/);
    expect(f.resumeIdentities.has("wrong-sdk-session")).toBe(false);
    expect(f.runtimeRegistry.activeSessionCount(instanceId)).toBe(0);
    await acquired.close();
  });
});
