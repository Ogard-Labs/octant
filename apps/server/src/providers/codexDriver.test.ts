import { BROWSER_TOOL_DEFINITION } from "../browser/browserToolDefinition";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  decodeProviderInstanceId,
  decodeProviderModelId,
  decodeProviderSessionId,
  type ProviderExecutionPolicy,
  type ProviderProbeResult,
  type ProviderRuntimeEvent,
} from "@octant/contracts";
import { Effect, Exit, Fiber, Scope, Stream } from "effect";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import {
  makeCodexProcessLive,
  type CodexAppServerConnection,
  type CodexProcessPort,
  type CodexLaunchAuthority,
} from "./codexProcess";
import { CodexRpcClientFailure } from "./codexRpcClient";
import type { CodexServerMessage } from "./codexProtocol";
import type {
  CodexAccountReadResult,
  CodexConfigReadResult,
  CodexRateLimitsReadResult,
  CodexSkillsListResult,
  CodexThreadResult,
  RateLimitSnapshot,
} from "./codexProtocol";
import {
  codexExecutionSettings,
  codexTurnExecutionSettings,
  makeCodexClient,
  makeCodexDriver,
  type CodexClientPort,
  type CodexDriverOptions,
  type CodexThreadResumeInput,
  type CodexThreadStartInput,
} from "./codexDriver";
import { ProviderRuntimeRegistry } from "./providerRuntimeRegistry";

const instanceId = decodeProviderInstanceId("80000000-0000-4000-8000-000000000061");
const otherInstanceId = decodeProviderInstanceId("80000000-0000-4000-8000-000000000062");
const sessionId = decodeProviderSessionId("90000000-0000-4000-8000-000000000061");
const secondSessionId = decodeProviderSessionId("90000000-0000-4000-8000-000000000062");
const projectRoot = "/tmp/octant-codex-project";
const fakeCliPath = fileURLToPath(new URL("./fixtures/fakeCodexCli.ts", import.meta.url));
const processDirectories: string[] = [];

function processFixture(mode: string): { readonly binaryPath: string; readonly root: string } {
  const root = mkdtempSync(join(tmpdir(), "octant-codex-driver-"));
  processDirectories.push(root);
  const binaryPath = join(root, "codex-fixture");
  writeFileSync(
    binaryPath,
    `#!/bin/sh\nFAKE_CODEX_MODE='${mode}' FAKE_CODEX_ROOT='${root}' exec '${fakeCliPath}' "$@"\n`,
  );
  chmodSync(binaryPath, 0o755);
  return { binaryPath, root };
}

function processRecords(root: string): readonly Record<string, unknown>[] {
  try {
    return readFileSync(join(root, "records.jsonl"), "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  } catch {
    return [];
  }
}

function processPids(root: string): number[] {
  return processRecords(root)
    .filter((record) => record.kind === "pid")
    .map((record) => Number(record.pid));
}

function processIsRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

const account = { account: { type: "chatgpt" as const }, requiresOpenaiAuth: true };
const model = (id = "gpt-5.4", inputModalities: ReadonlyArray<"text" | "image"> = ["text"]) => ({
  id,
  model: id,
  displayName: "GPT 5.4",
  hidden: false,
  supportedReasoningEfforts: [
    { reasoningEffort: "low", description: "Fast" },
    { reasoningEffort: "high", description: "Deep" },
  ],
  defaultReasoningEffort: "high",
  inputModalities,
  serviceTiers: [{ id: "fast", name: "Fast", description: "Fast tier" }],
  defaultServiceTier: "fast",
  isDefault: true,
});

interface Fixture {
  readonly calls: Array<{ readonly method: string; readonly input?: unknown }>;
  readonly client: CodexClientPort;
  readonly closeCount: () => number;
  readonly emit: (message: CodexServerMessage) => void;
  readonly exit: () => void;
  readonly listenerCount: () => number;
  readonly options: (overrides?: Partial<CodexDriverOptions>) => CodexDriverOptions;
  readonly startCount: () => number;
  readonly authorities: () => ReadonlyArray<CodexLaunchAuthority>;
}

function fixture(
  input: {
    readonly account?: CodexAccountReadResult;
    readonly rateLimitsByLimitId?: Readonly<Record<string, RateLimitSnapshot>>;
    readonly rateLimitsRead?: () => Promise<CodexRateLimitsReadResult>;
    readonly rateLimits?: RateLimitSnapshot;
    readonly ordinaryUsageAllowed?: boolean | null;
    readonly modelPages?: ReadonlyArray<{
      readonly data: ReadonlyArray<ReturnType<typeof model>>;
      readonly nextCursor: string | null;
    }>;
    readonly configRead?: () => Promise<CodexConfigReadResult>;
    readonly skillsList?: () => Promise<CodexSkillsListResult>;
    readonly threadResume?: (input: CodexThreadResumeInput) => Promise<CodexThreadResult>;
    readonly threadStart?: (input: CodexThreadStartInput) => Promise<CodexThreadResult>;
    readonly respondApproval?: (input: unknown) => Promise<void>;
    readonly respondTool?: (input: unknown) => Promise<void>;
    readonly turnStart?: () => Promise<{
      readonly turn: { readonly id: string; readonly status: "inProgress" };
    }>;
    readonly version?: string;
    readonly threadCompactStart?: (input: { readonly threadId: string }) => Promise<void>;
  } = {},
): Fixture {
  const calls: Array<{ method: string; input?: unknown }> = [];
  const listeners = new Set<(message: CodexServerMessage) => void>();
  let starts = 0;
  let closes = 0;
  let resolveExit: () => void = () => undefined;
  const pages = input.modelPages ?? [{ data: [model()], nextCursor: null }];
  let page = 0;
  const client: CodexClientPort = {
    accountRead: async () => {
      calls.push({ method: "account/read" });
      return input.account ?? account;
    },
    rateLimitsRead: async () => {
      calls.push({ method: "account/rateLimits/read" });
      if (input.rateLimitsRead !== undefined) return input.rateLimitsRead();
      return {
        rateLimits: input.rateLimits ?? { rateLimitReachedType: null },
        ...(input.ordinaryUsageAllowed === undefined
          ? {}
          : { ordinaryUsageAllowed: input.ordinaryUsageAllowed }),
        ...(input.rateLimitsByLimitId === undefined
          ? {}
          : { rateLimitsByLimitId: input.rateLimitsByLimitId }),
      };
    },
    modelList: async (cursor) => {
      calls.push({ method: "model/list", input: cursor });
      return pages[Math.min(page++, pages.length - 1)]!;
    },
    configRead: async (value) => {
      calls.push({ method: "config/read", input: value });
      return input.configRead === undefined ? { config: {} } : input.configRead();
    },
    skillsList: async (value) => {
      calls.push({ method: "skills/list", input: value });
      return input.skillsList === undefined
        ? { data: [{ skills: [], errors: [] }] }
        : input.skillsList();
    },
    threadStart: async (value) => {
      calls.push({ method: "thread/start", input: value });
      if (input.threadStart !== undefined) return input.threadStart(value);
      return {
        thread: { id: `thread-${calls.filter((call) => call.method === "thread/start").length}` },
        model: value.model,
        modelProvider: "openai",
        serviceTier: null,
        cwd: value.cwd,
      };
    },
    threadResume: async (value) => {
      calls.push({ method: "thread/resume", input: value });
      if (input.threadResume !== undefined) return input.threadResume(value);
      if (value.threadId === "missing") throw new Error("private provider detail");
      return {
        thread: { id: value.threadId },
        model: "gpt-5.4",
        modelProvider: "openai",
        serviceTier: null,
        cwd: value.threadId === "wrong-root" ? "/tmp/another-project" : projectRoot,
      };
    },
    turnStart: async (value) => {
      calls.push({ method: "turn/start", input: value });
      return input.turnStart?.() ?? { turn: { id: "turn-1", status: "inProgress" } };
    },
    turnSteer: async (value) => {
      calls.push({ method: "turn/steer", input: value });
      return { turnId: value.expectedTurnId };
    },
    turnInterrupt: async (value) => {
      calls.push({ method: "turn/interrupt", input: value });
    },
    threadCompactStart: async (value) => {
      calls.push({ method: "thread/compact/start", input: value });
      await input.threadCompactStart?.(value);
    },
    respondApproval: async (value) => {
      calls.push({ method: "approval/respond", input: value });
      await input.respondApproval?.(value);
    },
    respondTool: async (value) => {
      calls.push({ method: "tool/respond", input: value });
      await input.respondTool?.(value);
    },
    subscribe: (listener) => {
      calls.push({ method: "subscribe" });
      listeners.add(listener);
      return () => {
        calls.push({ method: "unsubscribe" });
        listeners.delete(listener);
      };
    },
  };
  const authorities: CodexLaunchAuthority[] = [];
  const processPort: CodexProcessPort = {
    start: ({ authority }) =>
      Effect.acquireRelease(
        Effect.sync(() => {
          starts += 1;
          authorities.push(authority);
          const exited = new Promise<void>((resolve) => {
            resolveExit = resolve;
          });
          return {
            version: input.version ?? "0.144.4",
            pid: starts,
            rpc: {} as CodexAppServerConnection["rpc"],
            exited,
          };
        }),
        () => Effect.sync(() => void (closes += 1)),
      ),
  };
  return {
    calls,
    client,
    closeCount: () => closes,
    emit: (message) => listeners.forEach((listener) => listener(message)),
    exit: () => resolveExit(),
    listenerCount: () => listeners.size,
    startCount: () => starts,
    authorities: () => authorities,
    options: (overrides = {}) => ({
      instanceId,
      binaryPath: "/usr/local/bin/codex",
      process: processPort,
      runtimeRegistry: new ProviderRuntimeRegistry(),
      clientFactory: () => client,
      clock: () => "2026-07-15T10:00:00.000Z",
      correlationId: () => "10000000-0000-4000-8000-000000000001",
      requestId: () => "request-1",
      taskId: () => "task-1",
      toolCallId: () => "tool-1",
      jitter: () => 0,
      sleep: async () => undefined,
      // A CODEX_HOME that names nothing: the provider credential probe must
      // never read the developer's real config.toml inside a test.
      environment: { CODEX_HOME: "/nonexistent-octant-test-home" },
      ...overrides,
    }),
  };
}

async function acquireConnection(
  driver: ReturnType<typeof makeCodexDriver>,
  mode?: "chat" | "work" | "code",
) {
  const scope = await Effect.runPromise(Scope.make());
  const connection = await Effect.runPromise(
    driver
      .acquire({ instanceId, projectRoot, ...(mode === undefined ? {} : { mode }) })
      .pipe(Effect.provideService(Scope.Scope, scope)),
  );
  return { connection, close: () => Effect.runPromise(Scope.close(scope, Exit.void)) };
}

async function startSession(
  connection: Awaited<ReturnType<typeof acquireConnection>>["connection"],
  id = sessionId,
  executionPolicy: ProviderExecutionPolicy = "approval-gated",
) {
  return Effect.runPromise(
    connection.start({ sessionId: id, modelId: "gpt-5.4" as never, executionPolicy }),
  );
}

function notification(
  method: Extract<CodexServerMessage, { kind: "notification" }>["method"],
  params: unknown,
): CodexServerMessage {
  return { kind: "notification", method, params } as CodexServerMessage;
}

function commandApproval(
  input: {
    readonly id?: number | string;
    readonly threadId?: string;
    readonly turnId?: string;
    readonly itemId?: string;
    readonly network?: boolean;
    readonly cwd?: string | null;
  } = {},
): CodexServerMessage {
  return {
    kind: "request",
    id: input.id ?? "provider-command-request",
    method: "item/commandExecution/requestApproval",
    params: {
      threadId: input.threadId ?? "thread-1",
      turnId: input.turnId ?? "turn-1",
      itemId: input.itemId ?? "provider-command-item",
      startedAtMs: 10,
      environmentId: null,
      reason: "private command reason must-not-cross",
      command: "curl private.example/secret",
      cwd: input.cwd === undefined ? projectRoot : input.cwd,
      ...(input.network
        ? { networkApprovalContext: { host: "private.example", protocol: "https" as const } }
        : {}),
    },
  };
}

function fileApproval(
  input: {
    readonly id?: number | string;
    readonly threadId?: string;
    readonly turnId?: string;
    readonly itemId?: string;
    readonly grantRoot?: string | null;
  } = {},
): CodexServerMessage {
  return {
    kind: "request",
    id: input.id ?? "provider-file-request",
    method: "item/fileChange/requestApproval",
    params: {
      threadId: input.threadId ?? "thread-1",
      turnId: input.turnId ?? "turn-1",
      itemId: input.itemId ?? "provider-file-item",
      startedAtMs: 10,
      reason: "private file reason must-not-cross",
      grantRoot: input.grantRoot ?? null,
    },
  };
}

function permissionsApproval(
  input: {
    readonly id?: number | string;
    readonly threadId?: string;
    readonly turnId?: string;
    readonly itemId?: string;
    readonly cwd?: string;
    readonly permissions?: Extract<
      CodexServerMessage,
      { readonly kind: "request"; readonly method: "item/permissions/requestApproval" }
    >["params"]["permissions"];
  } = {},
): CodexServerMessage {
  return {
    kind: "request",
    id: input.id ?? "provider-permissions-request",
    method: "item/permissions/requestApproval",
    params: {
      threadId: input.threadId ?? "thread-1",
      turnId: input.turnId ?? "turn-1",
      itemId: input.itemId ?? "provider-permissions-item",
      environmentId: null,
      startedAtMs: 10,
      cwd: input.cwd ?? projectRoot,
      reason: "private permission reason must-not-cross",
      permissions: input.permissions ?? {
        network: { enabled: true },
        fileSystem: null,
      },
    },
  };
}

function dynamicToolCall(
  input: {
    readonly id?: number | string;
    readonly threadId?: string;
    readonly turnId?: string;
    readonly callId?: string;
    readonly tool?: string;
    readonly arguments?: unknown;
  } = {},
): CodexServerMessage {
  return {
    kind: "request",
    id: input.id ?? "provider-tool-request",
    method: "item/tool/call",
    params: {
      threadId: input.threadId ?? "thread-1",
      turnId: input.turnId ?? "turn-1",
      callId: input.callId ?? "call-1",
      namespace: null,
      tool: input.tool ?? "octant_browser",
      arguments: input.arguments ?? { operation: "screenshot" },
    },
  };
}

async function takeEvents(
  connection: Awaited<ReturnType<typeof acquireConnection>>["connection"],
  count: number,
): Promise<ReadonlyArray<ProviderRuntimeEvent>> {
  return Effect.runPromise(
    Stream.runCollect(Stream.unwrapScoped(connection.subscribe).pipe(Stream.take(count))),
  ).then((chunk) => [...chunk]);
}

afterEach(() => {
  vi.useRealTimers();
});

afterAll(() => {
  for (const root of processDirectories.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("Codex driver probe and runtime lifecycle", () => {
  it("refreshes account limits through a non-generating app-server read", async () => {
    const f = fixture({
      rateLimits: {
        limitId: "codex",
        limitName: "Codex",
        primary: {
          usedPercent: 42,
          windowDurationMins: 300,
          resetsAt: 1_800_000_000,
        },
        secondary: {
          usedPercent: 91,
          windowDurationMins: 10_080,
          resetsAt: 1_800_060_000,
        },
        rateLimitReachedType: null,
      },
    });
    const driver = makeCodexDriver(f.options({ idleLeaseMs: 0 }));
    const facts = driver.contextFacts;
    expect(facts).toBeDefined();
    if (facts === undefined) return;
    const limits = await Effect.runPromise(
      Effect.scoped(facts.observeServiceLimits({ instanceId })),
    );
    expect(limits).toMatchObject({
      providerInstanceId: instanceId,
      scope: "account",
      source: "runtime-reported",
      confidence: "high",
      requests: { status: "unavailable" },
      tokens: { status: "unavailable" },
      quota: "available",
      rateLimitWindows: [
        { window: "codex:primary_5h", status: "allowed", utilization: 0.42 },
        { window: "codex:secondary_7d", status: "warning", utilization: 0.91 },
      ],
    });
    expect(f.calls.map((call) => call.method)).toEqual(["account/rateLimits/read"]);
  });

  it("keeps multiple Codex limit IDs as distinct account windows", async () => {
    const f = fixture({
      rateLimits: { rateLimitReachedType: null },
      rateLimitsByLimitId: {
        codex: {
          limitId: "codex",
          primary: { usedPercent: 10, windowDurationMins: 300, resetsAt: 1_800_000_000 },
          rateLimitReachedType: null,
        },
        "codex-mini": {
          limitId: "codex-mini",
          primary: { usedPercent: 80, windowDurationMins: 60, resetsAt: 1_800_060_000 },
          rateLimitReachedType: null,
        },
      },
    });
    const facts = makeCodexDriver(f.options({ idleLeaseMs: 0 })).contextFacts;
    if (facts === undefined) throw new Error("Expected Codex context facts.");
    const limits = await Effect.runPromise(
      Effect.scoped(facts.observeServiceLimits({ instanceId })),
    );
    expect(limits.rateLimitWindows).toMatchObject([
      { window: "codex:primary_5h", utilization: 0.1 },
      { window: "codex-mini:primary_1h", utilization: 0.8 },
    ]);
  });

  it("uses the slot and duration as the identity for a legacy unnamed window", async () => {
    const f = fixture({
      rateLimits: {
        primary: { usedPercent: 42, windowDurationMins: 300, resetsAt: 1_800_000_000 },
        rateLimitReachedType: null,
      },
    });
    const facts = makeCodexDriver(f.options({ idleLeaseMs: 0 })).contextFacts;
    if (facts === undefined) throw new Error("Expected Codex context facts.");
    const limits = await Effect.runPromise(
      Effect.scoped(facts.observeServiceLimits({ instanceId })),
    );
    expect(limits.rateLimitWindows).toMatchObject([
      { window: "primary_5h", status: "allowed", utilization: 0.42 },
    ]);
  });

  it("leaves account capacity unknown when the sanctioned read fails", async () => {
    const f = fixture({
      rateLimitsRead: async () => {
        throw new CodexRpcClientFailure("timeout", "synthetic timeout");
      },
    });
    const facts = makeCodexDriver(f.options({ idleLeaseMs: 0 })).contextFacts;
    if (facts === undefined) throw new Error("Expected Codex context facts.");
    const exit = await Effect.runPromise(
      Effect.scoped(Effect.exit(facts.observeServiceLimits({ instanceId }))),
    );
    expect(String(exit)).toContain("unavailable");
    expect(f.calls.map((call) => call.method)).toEqual(["account/rateLimits/read"]);
  });

  it("does not fabricate capacity from malformed account windows", async () => {
    const f = fixture({
      rateLimits: {
        primary: { usedPercent: 101, windowDurationMins: 300, resetsAt: 1_800_000_000 },
        rateLimitReachedType: null,
      },
    });
    const facts = makeCodexDriver(f.options({ idleLeaseMs: 0 })).contextFacts;
    if (facts === undefined) throw new Error("Expected Codex context facts.");
    const limits = await Effect.runPromise(
      Effect.scoped(facts.observeServiceLimits({ instanceId })),
    );
    expect(limits.quota).toBe("unknown");
    expect(limits.confidence).toBe("unknown");
    expect(limits.rateLimitWindows).toBeUndefined();
  });

  it("uses the account permission flag when Codex supplies no window buckets", async () => {
    const f = fixture({
      ordinaryUsageAllowed: false,
      rateLimits: { rateLimitReachedType: null },
    });
    const facts = makeCodexDriver(f.options({ idleLeaseMs: 0 })).contextFacts;
    if (facts === undefined) throw new Error("Expected Codex context facts.");
    const limits = await Effect.runPromise(
      Effect.scoped(facts.observeServiceLimits({ instanceId })),
    );
    expect(limits).toMatchObject({
      quota: "exhausted",
      confidence: "high",
      requests: { status: "unavailable" },
      tokens: { status: "unavailable" },
    });
  });

  it("retains an explicit account exhaustion state without inventing window buckets", async () => {
    const f = fixture({
      rateLimits: { rateLimitReachedType: "rate_limit_reached" },
    });
    const facts = makeCodexDriver(f.options({ idleLeaseMs: 0 })).contextFacts;
    if (facts === undefined) throw new Error("Expected Codex context facts.");
    const limits = await Effect.runPromise(
      Effect.scoped(facts.observeServiceLimits({ instanceId })),
    );
    expect(limits).toMatchObject({ quota: "exhausted", confidence: "unknown" });
    expect(limits.rateLimitWindows).toBeUndefined();
  });

  it("returns probe-derived model evidence when the runtime registry has context bounds", async () => {
    const f = fixture();
    const registry = new ProviderRuntimeRegistry();
    const driver = makeCodexDriver(f.options({ runtimeRegistry: registry }));
    const probe = await Effect.runPromise(Effect.scoped(driver.probe({ instanceId })));
    const model = probe.models[0];
    if (model === undefined) throw new Error("Expected a Codex model probe result.");
    registry.setObservedState({
      ...probe,
      models: [{ ...model, contextLimit: 128_000 }],
    });
    const facts = driver.contextFacts;
    if (facts === undefined) throw new Error("Expected Codex context facts.");
    await expect(
      Effect.runPromise(Effect.scoped(facts.observeModelLimits({ instanceId }))),
    ).resolves.toMatchObject([
      { providerInstanceId: instanceId, modelId: model.id, contextWindow: 128_000 },
    ]);
  });

  it("cancels an in-flight account read and closes its runtime lease", async () => {
    const f = fixture({
      rateLimitsRead: () => new Promise<CodexRateLimitsReadResult>(() => undefined),
    });
    const facts = makeCodexDriver(f.options({ idleLeaseMs: 0 })).contextFacts;
    if (facts === undefined) throw new Error("Expected Codex context facts.");
    const controller = new AbortController();
    const running = Effect.runPromise(Effect.scoped(facts.observeServiceLimits({ instanceId })), {
      signal: controller.signal,
    });
    await vi.waitFor(() =>
      expect(f.calls.map((call) => call.method)).toContain("account/rateLimits/read"),
    );
    controller.abort();
    await expect(running).rejects.toBeDefined();
    await vi.waitFor(() => expect(f.closeCount()).toBe(1));
    expect(f.calls.map((call) => call.method)).toEqual(["account/rateLimits/read"]);
  });

  it("carries the app-server pid as runtime metadata for ownership receipts", async () => {
    const receiptDirectory = mkdtempSync(join(tmpdir(), "octant-codex-receipts-"));
    try {
      const f = fixture();
      const registry = new ProviderRuntimeRegistry({
        receiptDirectory,
        processIdentity: async () => `sha256:${"a".repeat(64)}`,
      });
      const acquired = await acquireConnection(
        makeCodexDriver(f.options({ runtimeRegistry: registry })),
      );
      await startSession(acquired.connection);
      expect(await readdir(receiptDirectory)).toHaveLength(1);
      await acquired.close();
      await registry.closeAll();
      expect(await readdir(receiptDirectory)).toHaveLength(0);
    } finally {
      await rm(receiptDirectory, { recursive: true, force: true });
    }
  });

  it("rejects mismatched instances and non-normalized Project roots", async () => {
    const f = fixture();
    const driver = makeCodexDriver(f.options());
    const mismatch = await Effect.runPromise(
      Effect.scoped(Effect.exit(driver.probe({ instanceId: otherInstanceId }))),
    );
    const relative = await Effect.runPromise(
      Effect.scoped(Effect.exit(driver.acquire({ instanceId, projectRoot: "relative" }))),
    );
    const nonNormalized = await Effect.runPromise(
      Effect.scoped(Effect.exit(driver.acquire({ instanceId, projectRoot: "/tmp/project/.." }))),
    );
    expect(String(mismatch)).toContain("invalid-configuration");
    expect(String(relative)).toContain("absolute normalized");
    expect(String(nonNormalized)).toContain("absolute normalized");
  });

  it("uses only read-only account/model probe calls and normalizes model options", async () => {
    const f = fixture();
    const probe = await Effect.runPromise(
      Effect.scoped(makeCodexDriver(f.options()).probe({ instanceId })),
    );
    expect(f.calls.map(({ method }) => method)).toEqual(["account/read", "model/list"]);
    expect(probe).toMatchObject({
      readiness: "ready",
      detectedVersion: "0.144.4",
      capabilities: {
        streaming: "supported",
        resume: "supported",
        userQuestions: "unsupported",
        nativeChildAgents: "unsupported",
        harnessAutoReview: "supported",
      },
      models: [
        {
          id: "gpt-5.4",
          reasoning: "supported",
          // The fixture reports a text-only modality list, which is an
          // observed fact rather than a fallback.
          imageInput: "unsupported",
          options: [
            { id: "reasoning", values: ["low", "high"] },
            { id: "service-tier", values: ["fast"] },
          ],
        },
      ],
    });
  });

  it("bounds model pagination and reports authentication honestly", async () => {
    const unauthenticated = fixture({
      account: { account: null, requiresOpenaiAuth: true },
      modelPages: [{ data: [], nextCursor: null }],
    });
    const unauthenticatedProbe = await Effect.runPromise(
      Effect.scoped(makeCodexDriver(unauthenticated.options()).probe({ instanceId })),
    );
    expect(unauthenticatedProbe.readiness).toBe("unauthenticated");

    const optional = fixture({ account: { account: null, requiresOpenaiAuth: false } });
    const optionalProbe = await Effect.runPromise(
      Effect.scoped(makeCodexDriver(optional.options()).probe({ instanceId })),
    );
    expect(optionalProbe.readiness).toBe("ready");
    // Ready without an OpenAI login is not a subscription sign-in.
    expect(optionalProbe.accountAuthentication).toBe("none");

    // A provider that authenticates outside the OpenAI login answers
    // requiresOpenaiAuth: false whether or not it holds a credential, so the
    // probe names the variable the config's env_key needs and refuses ready
    // while the runtime's allowlist does not carry it.
    const codexHome = mkdtempSync(join(tmpdir(), "octant-codex-home-"));
    writeFileSync(
      join(codexHome, "config.toml"),
      'model_provider = "vendor"\n\n[model_providers.vendor]\nname = "Vendor"\nbase_url = "http://127.0.0.1:9/v1"\nenv_key = "VENDOR_API_KEY"\n',
    );
    try {
      const missing = fixture({
        account: {
          account: { type: "apiKey" as const },
          requiresOpenaiAuth: false,
        },
      });
      const missingProbe = await Effect.runPromise(
        Effect.scoped(
          makeCodexDriver(missing.options({ environment: { CODEX_HOME: codexHome } })).probe({
            instanceId,
          }),
        ),
      );
      expect(missingProbe.readiness).toBe("unauthenticated");
      expect(missingProbe.message).toContain("VENDOR_API_KEY");

      // A custom env_key is never allowlisted, so it stays unauthenticated
      // even exported: admitting it would let a config exfiltrate a host
      // secret to its own base_url.
      const exported = fixture({
        account: {
          account: { type: "apiKey" as const },
          requiresOpenaiAuth: false,
        },
      });
      const exportedProbe = await Effect.runPromise(
        Effect.scoped(
          makeCodexDriver(
            exported.options({
              environment: { CODEX_HOME: codexHome, VENDOR_API_KEY: "sk-test" },
            }),
          ).probe({ instanceId }),
        ),
      );
      expect(exportedProbe.readiness).toBe("unauthenticated");
    } finally {
      rmSync(codexHome, { recursive: true, force: true });
    }

    const pages = Array.from({ length: 11 }, (_, index) => ({
      data: [model(`model-${index}`)],
      nextCursor: `cursor-${index}`,
    }));
    const bounded = fixture({ modelPages: pages });
    const exit = await Effect.runPromise(
      Effect.scoped(Effect.exit(makeCodexDriver(bounded.options()).probe({ instanceId }))),
    );
    expect(String(exit)).toContain("protocol");
    expect(bounded.calls.filter(({ method }) => method === "model/list")).toHaveLength(10);
  });

  it("refuses a Bedrock sign-in that reaches the AWS profile or shared config and admits an instance-scoped one", async () => {
    const bedrock = (usesCodexManagedCredentials = false) => ({
      account: { type: "amazonBedrock" as const, usesCodexManagedCredentials },
      requiresOpenaiAuth: false,
    });
    const effectiveConfig = (aws?: Readonly<Record<string, unknown>>, auth?: unknown) => ({
      config: {
        model_provider: "amazon-bedrock",
        model_providers: {
          "amazon-bedrock": {
            ...(aws === undefined ? {} : { aws }),
            ...(auth === undefined ? {} : { auth }),
          },
        },
      },
    });
    const probe = async (
      input: Parameters<typeof fixture>[0],
      environment: NodeJS.ProcessEnv,
    ): Promise<ProviderProbeResult> =>
      Effect.runPromise(
        Effect.scoped(
          makeCodexDriver(fixture(input).options({ environment })).probe({ instanceId }),
        ),
      );
    const bearer = { AWS_BEARER_TOKEN_BEDROCK: "bedrock-token", AWS_REGION: "us-east-1" };

    // With no Codex-managed key and no bearer token, Codex falls through to
    // the AWS SDK's default chain, which reads `~/.aws` through `HOME` whether
    // or not a profile variable names it.
    for (const environment of [
      { AWS_PROFILE: "work", AWS_REGION: "us-east-1" },
      { AWS_SHARED_CREDENTIALS_FILE: "/Users/test/.aws/credentials" },
      { HOME: "/Users/test" },
      { AWS_ACCESS_KEY_ID: "AKIAEXAMPLE", AWS_SECRET_ACCESS_KEY: "secret-sentinel" },
      { AWS_BEARER_TOKEN_BEDROCK: " " },
    ]) {
      const refused = await probe(
        { account: bedrock(), configRead: async () => effectiveConfig() },
        environment,
      );
      expect(refused.readiness, JSON.stringify(environment)).toBe("incompatible");
      expect(refused.message).toContain("AWS_BEARER_TOKEN_BEDROCK");
      expect(refused.message).not.toContain("secret-sentinel");
    }

    // A profile or a credential export in the config outranks the bearer
    // token in Codex's own order, so exporting the token does not help.
    const profile = await probe(
      { account: bedrock(), configRead: async () => effectiveConfig({ profile: "work" }) },
      bearer,
    );
    expect(profile.readiness).toBe("incompatible");
    expect(profile.message).toContain("aws.profile");
    const credentialExport = await probe(
      {
        account: bedrock(),
        configRead: async () =>
          effectiveConfig({ credential_export: { command: "aws", args: ["configure"] } }),
      },
      bearer,
    );
    expect(credentialExport.readiness).toBe("incompatible");
    expect(credentialExport.message).toContain("aws.credential_export");

    // What the person configured for this account alone still works.
    expect(
      (await probe({ account: bedrock(), configRead: async () => effectiveConfig() }, bearer))
        .readiness,
    ).toBe("ready");
    expect(
      (await probe({ account: bedrock(true), configRead: async () => effectiveConfig() }, {}))
        .readiness,
    ).toBe("ready");
    expect(
      (
        await probe(
          {
            account: bedrock(),
            configRead: async () =>
              effectiveConfig({ region: "us-east-1" }, { command: "bedrock-token" }),
          },
          {},
        )
      ).readiness,
    ).toBe("ready");

    // A runtime older than the Bedrock account report is recognised from its
    // config and held to the same rule.
    const codexHome = mkdtempSync(join(tmpdir(), "octant-codex-home-"));
    try {
      writeFileSync(join(codexHome, "config.toml"), 'model_provider = "amazon-bedrock"\n');
      const older = {
        account: { account: { type: "apiKey" as const }, requiresOpenaiAuth: false },
      };
      expect((await probe(older, { CODEX_HOME: codexHome, AWS_PROFILE: "work" })).readiness).toBe(
        "incompatible",
      );
      expect((await probe(older, { CODEX_HOME: codexHome, ...bearer })).readiness).toBe("ready");
    } finally {
      rmSync(codexHome, { recursive: true, force: true });
    }

    // Every session acquisition holds the same line, so a caller that never
    // probed cannot start a thread on a refused sign-in either.
    const unprobed = fixture({
      account: bedrock(),
      configRead: async () => effectiveConfig({ profile: "work" }),
    });
    const scope = await Effect.runPromise(Scope.make());
    const acquired = await Effect.runPromise(
      Effect.either(
        makeCodexDriver(unprobed.options({ environment: bearer }))
          .acquire({ instanceId, projectRoot })
          .pipe(
            Effect.flatMap((connection) =>
              connection.start({
                sessionId,
                modelId: "gpt-5.4" as never,
                executionPolicy: "approval-gated",
              }),
            ),
            Effect.provideService(Scope.Scope, scope),
          ),
      ),
    );
    await Effect.runPromise(Scope.close(scope, Exit.void));
    expect(acquired._tag).toBe("Left");
    if (acquired._tag === "Left") expect(acquired.left.category).toBe("incompatible");
    expect(unprobed.calls.some(({ method }) => method === "thread/start")).toBe(false);
  });

  it("shares one process per root and posture, separates postures and instances, and idles for 30 seconds", async () => {
    vi.useFakeTimers();
    const registry = new ProviderRuntimeRegistry();
    const f = fixture();
    const driver = makeCodexDriver(f.options({ runtimeRegistry: registry }));
    const first = await Effect.runPromise(Scope.make());
    const second = await Effect.runPromise(Scope.make());
    const third = await Effect.runPromise(Scope.make());
    const open = (
      scope: Scope.CloseableScope,
      policy: ProviderExecutionPolicy,
      id: typeof sessionId,
    ) =>
      Effect.runPromise(
        driver.acquire({ instanceId, projectRoot }).pipe(
          Effect.flatMap((connection) =>
            connection.start({
              sessionId: id,
              modelId: "gpt-5.4" as never,
              executionPolicy: policy,
            }),
          ),
          Effect.provideService(Scope.Scope, scope),
        ),
      );
    await Promise.all([
      open(first, "approval-gated", sessionId),
      open(second, "approval-gated", secondSessionId),
    ]);
    // Acquiring a connection leases nothing; the first session names the posture.
    expect(f.startCount()).toBe(1);
    await open(third, "plan", sessionId);
    expect(f.startCount()).toBe(2);
    expect(f.authorities()).toEqual([
      { kind: "thread", root: projectRoot, mode: "code", executionPolicy: "approval-gated" },
      { kind: "thread", root: projectRoot, mode: "code", executionPolicy: "plan" },
    ]);
    await Promise.all(
      [first, second, third].map((scope) => Effect.runPromise(Scope.close(scope, Exit.void))),
    );
    await vi.advanceTimersByTimeAsync(29_999);
    expect(f.closeCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(f.closeCount()).toBe(2);

    const other = fixture();
    await Effect.runPromise(
      Effect.scoped(
        makeCodexDriver(other.options({ instanceId: otherInstanceId, runtimeRegistry: registry }))
          .acquire({ instanceId: otherInstanceId, projectRoot })
          .pipe(
            Effect.flatMap((connection) =>
              connection.start({
                sessionId,
                modelId: "gpt-5.4" as never,
                executionPolicy: "approval-gated",
              }),
            ),
          ),
      ),
    );
    expect(other.startCount()).toBe(1);
  });

  it("reads the account and models through a process that carries no thread", async () => {
    const f = fixture();
    await Effect.runPromise(Effect.scoped(makeCodexDriver(f.options()).probe({ instanceId })));
    expect(f.authorities()).toEqual([{ kind: "catalog" }]);
  });

  it("refuses to change the posture of a connection's confined process", async () => {
    const f = fixture();
    const acquired = await acquireConnection(makeCodexDriver(f.options()));
    try {
      await startSession(acquired.connection, sessionId, "plan");
      const widened = await Effect.runPromise(
        Effect.either(
          acquired.connection.start({
            sessionId: secondSessionId,
            modelId: "gpt-5.4" as never,
            executionPolicy: "approval-gated",
          }),
        ),
      );
      expect(widened._tag).toBe("Left");
      if (widened._tag === "Left") expect(widened.left.category).toBe("unauthorized");
      expect(f.startCount()).toBe(1);
    } finally {
      await acquired.close();
    }
  });
});

describe("Codex thread and turn lifecycle", () => {
  it("steers only the currently active turn and leaves the session and authority unchanged", async () => {
    const f = fixture();
    const acquired = await acquireConnection(makeCodexDriver(f.options()));
    try {
      await startSession(acquired.connection);
      const steer = () =>
        Effect.runPromise(
          acquired.connection.steer?.({ sessionId, message: "Check only the changed files" }) ??
            Effect.succeed("unsupported"),
        );
      expect(await steer()).toBe("unsupported");
      await Effect.runPromise(
        acquired.connection.send({ sessionId, prompt: "Review", attachments: [], tools: [] }),
      );
      expect(await steer()).toBe("steered");
      expect(f.calls.at(-1)).toEqual({
        method: "turn/steer",
        input: {
          threadId: "thread-1",
          expectedTurnId: "turn-1",
          input: [{ type: "text", text: "Check only the changed files", text_elements: [] }],
        },
      });
      expect(f.calls.filter((call) => call.method === "turn/start")).toHaveLength(1);
      expect(f.calls.filter((call) => call.method === "thread/start")).toHaveLength(1);
    } finally {
      await acquired.close();
    }
  });

  it("rejects a started thread outside the exact normalized Project root without retaining state", async () => {
    const f = fixture({
      threadStart: async (value) => ({
        thread: { id: "thread-wrong-root" },
        model: value.model,
        modelProvider: "openai",
        serviceTier: null,
        cwd: "/private/provider/root",
      }),
    });
    const registry = new ProviderRuntimeRegistry();
    const acquired = await acquireConnection(
      makeCodexDriver(f.options({ runtimeRegistry: registry })),
    );
    const exit = await Effect.runPromise(
      Effect.exit(
        acquired.connection.start({
          sessionId,
          modelId: "gpt-5.4" as never,
          executionPolicy: "approval-gated",
        }),
      ),
    );
    expect(String(exit)).toContain("unauthorized");
    expect(String(exit)).not.toContain("/private/provider/root");
    expect(f.listenerCount()).toBe(0);
    expect(registry.activeSessionCount(instanceId)).toBe(0);
    const sendExit = await Effect.runPromise(
      Effect.exit(
        acquired.connection.send({
          sessionId,
          prompt: "must not exist",
          attachments: [],
          tools: [],
        }),
      ),
    );
    expect(String(sendExit)).toContain("not active");
    await acquired.close();
  });

  it("removes the shared listener when thread/start fails before session registration", async () => {
    const f = fixture({
      threadStart: async () => {
        throw new Error("private thread/start failure");
      },
    });
    const registry = new ProviderRuntimeRegistry();
    const acquired = await acquireConnection(
      makeCodexDriver(f.options({ runtimeRegistry: registry })),
    );
    const exit = await Effect.runPromise(
      Effect.exit(
        acquired.connection.start({
          sessionId,
          modelId: "gpt-5.4" as never,
          executionPolicy: "approval-gated",
        }),
      ),
    );
    expect(String(exit)).toContain("provider-failed");
    expect(String(exit)).not.toContain("private thread/start failure");
    expect(f.listenerCount()).toBe(0);
    expect(registry.activeSessionCount(instanceId)).toBe(0);
    await acquired.close();
  });

  it("forwards only declared reasoning and service tier selections to thread/start", async () => {
    const f = fixture();
    const registry = new ProviderRuntimeRegistry();
    const driver = makeCodexDriver(f.options({ runtimeRegistry: registry }));
    // A fresh server with no Settings check behind it: the probe Chat runs
    // before the turn is what publishes the catalog the driver validates
    // option values against. Nothing else installs an observed state here.
    await Effect.runPromise(Effect.scoped(driver.probe({ instanceId })));
    const acquired = await acquireConnection(driver);
    await Effect.runPromise(
      acquired.connection.start({
        sessionId,
        modelId: "gpt-5.4" as never,
        executionPolicy: "approval-gated",
        modelOptionValues: { reasoning: "low", "service-tier": "fast", effort: "high" },
      }),
    );
    // "medium" is not a reasoning level this model advertised; "slow" is not
    // one of its tiers. Neither may reach Codex.
    await Effect.runPromise(
      acquired.connection.start({
        sessionId: secondSessionId,
        modelId: "gpt-5.4" as never,
        executionPolicy: "approval-gated",
        modelOptionValues: { reasoning: "medium", "service-tier": "slow" },
      }),
    );
    const starts = f.calls.filter(({ method }) => method === "thread/start");
    expect(starts[0]?.input).toEqual({
      cwd: projectRoot,
      model: "gpt-5.4",
      approvalPolicy: "untrusted",
      sandbox: "read-only",
      approvalsReviewer: "user",
      serviceTier: "fast",
      config: { model_reasoning_effort: "low", skills: { config: [] } },
    });
    expect(starts[1]?.input).toEqual({
      cwd: projectRoot,
      model: "gpt-5.4",
      approvalPolicy: "untrusted",
      sandbox: "read-only",
      approvalsReviewer: "user",
      config: { skills: { config: [] } },
    });
    await acquired.close();
  });

  it("runs a resumed thread's turns on the model it was switched to, with that model's reasoning", async () => {
    const f = fixture({
      modelPages: [
        { data: [model(), { ...model("gpt-5.5"), isDefault: false }], nextCursor: null },
      ],
    });
    const registry = new ProviderRuntimeRegistry();
    const driver = makeCodexDriver(f.options({ runtimeRegistry: registry }));
    await Effect.runPromise(Effect.scoped(driver.probe({ instanceId })));
    const acquired = await acquireConnection(driver);
    // The fake records the thread as gpt-5.4; the thread now asks for gpt-5.5.
    await Effect.runPromise(
      acquired.connection.resume({
        sessionId,
        resumeCursor: { driverKind: "codex", value: "thread-existing" },
        executionPolicy: "approval-gated",
        modelId: "gpt-5.5" as never,
        modelOptionValues: { reasoning: "low" },
      }),
    );
    await Effect.runPromise(
      acquired.connection.send({ sessionId, prompt: "hello", attachments: [], tools: [] }),
    );
    expect(f.calls.find(({ method }) => method === "turn/start")?.input).toMatchObject({
      model: "gpt-5.5",
      effort: "low",
    });
    await acquired.close();
  });

  it("leaves the model to Codex when a resumed thread keeps the model it recorded", async () => {
    const f = fixture();
    const acquired = await acquireConnection(makeCodexDriver(f.options()));
    await Effect.runPromise(
      acquired.connection.resume({
        sessionId,
        resumeCursor: { driverKind: "codex", value: "thread-existing" },
        executionPolicy: "approval-gated",
        modelId: "gpt-5.4" as never,
      }),
    );
    await Effect.runPromise(
      acquired.connection.send({ sessionId, prompt: "hello", attachments: [], tools: [] }),
    );
    const turn = f.calls.find(({ method }) => method === "turn/start");
    expect(turn?.input).not.toHaveProperty("model");
    expect(turn?.input).not.toHaveProperty("effort");
    await acquired.close();
  });

  it("fails a start that declares option values instead of dropping them without a catalog", async () => {
    const f = fixture();
    const registry = new ProviderRuntimeRegistry();
    const acquired = await acquireConnection(
      makeCodexDriver(f.options({ runtimeRegistry: registry })),
    );
    const exit = await Effect.runPromiseExit(
      acquired.connection.start({
        sessionId,
        modelId: "gpt-5.4" as never,
        executionPolicy: "approval-gated",
        modelOptionValues: { reasoning: "low" },
      }),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    expect(String(exit)).toContain("invalid-configuration");
    expect(f.calls.filter(({ method }) => method === "thread/start")).toHaveLength(0);
    await acquired.close();
  });

  it("starts a thread with root/model/policy, subscribes before a text turn, and interrupts exact IDs", async () => {
    const f = fixture();
    const acquired = await acquireConnection(makeCodexDriver(f.options()));
    const handle = await startSession(acquired.connection);
    expect(handle.resumeCursor).toEqual({
      driverKind: "codex",
      value: "thread-1",
      binding: { instanceId, sessionId, projectRoot, mode: "code", modelId: "gpt-5.4" },
    });
    expect(f.calls.find(({ method }) => method === "thread/start")?.input).toMatchObject({
      cwd: projectRoot,
      model: "gpt-5.4",
      approvalPolicy: "untrusted",
      sandbox: "read-only",
      approvalsReviewer: "user",
    } satisfies Partial<CodexThreadStartInput>);
    await Effect.runPromise(
      acquired.connection.send({
        sessionId,
        prompt: "Explain the repository.",
        attachments: [],
        tools: [],
      }),
    );
    expect(f.calls.map(({ method }) => method)).toEqual([
      "account/read",
      "subscribe",
      "skills/list",
      "thread/start",
      "turn/start",
    ]);
    expect(f.calls.at(-1)?.input).toEqual({
      threadId: "thread-1",
      input: [{ type: "text", text: "Explain the repository." }],
      approvalPolicy: "untrusted",
      sandboxPolicy: { type: "externalSandbox", networkAccess: "restricted" },
      approvalsReviewer: "user",
    });
    await Effect.runPromise(acquired.connection.interrupt(sessionId));
    expect(f.calls.at(-1)).toEqual({
      method: "turn/interrupt",
      input: { threadId: "thread-1", turnId: "turn-1" },
    });
    await acquired.close();
  });

  it("registers dynamic app tools at thread start and answers a correlated tool call", async () => {
    let emit: (message: CodexServerMessage) => void = () => undefined;
    const f = fixture({
      turnStart: async () => {
        emit(
          notification("turn/started", {
            threadId: "thread-1",
            turn: { id: "turn-1", status: "inProgress" },
          }),
        );
        emit(dynamicToolCall());
        return { turn: { id: "turn-1", status: "inProgress" } };
      },
    });
    emit = f.emit;
    const registry = new ProviderRuntimeRegistry();
    const driver = makeCodexDriver(f.options({ runtimeRegistry: registry }));
    registry.setObservedState(await Effect.runPromise(Effect.scoped(driver.probe({ instanceId }))));
    const acquired = await acquireConnection(driver);
    const tool = BROWSER_TOOL_DEFINITION;

    await Effect.runPromise(
      acquired.connection.start({
        sessionId,
        modelId: "gpt-5.4" as never,
        executionPolicy: "approval-gated",
        tools: [tool],
      }),
    );
    expect(f.calls.find(({ method }) => method === "thread/start")?.input).toMatchObject({
      dynamicTools: [{ type: "function", ...tool }],
    });

    const eventsPromise = takeEvents(acquired.connection, 1);
    await Effect.runPromise(
      acquired.connection.send({
        sessionId,
        prompt: "Inspect the page.",
        attachments: [],
        tools: [tool],
      }),
    );
    const [event] = await eventsPromise;
    expect(event).toMatchObject({
      kind: "tool-request",
      requestId: "request-1",
      toolName: "octant_browser",
      inputJson: '{"operation":"screenshot"}',
    });
    if (event === undefined || event.kind !== "tool-request") {
      throw new Error("Expected an app-tool request event.");
    }
    const signal = acquired.connection.toolRequestSignal?.({
      sessionId,
      requestId: event.requestId,
    });
    expect(signal?.aborted).toBe(false);

    await Effect.runPromise(
      acquired.connection.answerTool({
        sessionId,
        requestId: event.requestId,
        resultJson: '{"heading":"Example"}',
        isError: false,
      }),
    );
    expect(f.calls.find(({ method }) => method === "tool/respond")?.input).toEqual({
      providerRequestId: "provider-tool-request",
      result: {
        success: true,
        contentItems: [{ type: "inputText", text: '{"heading":"Example"}' }],
      },
    });
    await acquired.close();
  });

  it("aborts an app-tool signal when its session stops", async () => {
    let emit: (message: CodexServerMessage) => void = () => undefined;
    const f = fixture({
      turnStart: async () => {
        emit(
          notification("turn/started", {
            threadId: "thread-1",
            turn: { id: "turn-1", status: "inProgress" },
          }),
        );
        emit(dynamicToolCall());
        return { turn: { id: "turn-1", status: "inProgress" } };
      },
    });
    emit = f.emit;
    const registry = new ProviderRuntimeRegistry();
    const driver = makeCodexDriver(f.options({ runtimeRegistry: registry }));
    registry.setObservedState(await Effect.runPromise(Effect.scoped(driver.probe({ instanceId }))));
    const acquired = await acquireConnection(driver);
    await startSession(acquired.connection);
    const eventsPromise = takeEvents(acquired.connection, 1);
    await Effect.runPromise(
      acquired.connection.send({
        sessionId,
        prompt: "Inspect the page.",
        attachments: [],
        tools: [{ name: "octant_browser", inputSchema: {} }],
      }),
    );
    const [event] = await eventsPromise;
    if (event === undefined || event.kind !== "tool-request") {
      throw new Error("Expected an app-tool request event.");
    }
    const signal = acquired.connection.toolRequestSignal?.({
      sessionId,
      requestId: event.requestId,
    });
    await Effect.runPromise(acquired.connection.stop(sessionId));
    expect(signal?.aborted).toBe(true);
    expect(
      acquired.connection.toolRequestSignal?.({ sessionId, requestId: event.requestId }).aborted,
    ).toBe(true);
    await acquired.close();
  });

  it("aborts an app-tool signal when the provider terminal event arrives first", async () => {
    let emit: (message: CodexServerMessage) => void = () => undefined;
    const f = fixture({
      turnStart: async () => {
        emit(
          notification("turn/started", {
            threadId: "thread-1",
            turn: { id: "turn-1", status: "inProgress" },
          }),
        );
        emit(dynamicToolCall());
        emit(
          notification("turn/completed", {
            threadId: "thread-1",
            turn: { id: "turn-1", status: "completed" },
          }),
        );
        return { turn: { id: "turn-1", status: "inProgress" } };
      },
    });
    emit = f.emit;
    const registry = new ProviderRuntimeRegistry();
    const driver = makeCodexDriver(f.options({ runtimeRegistry: registry }));
    registry.setObservedState(await Effect.runPromise(Effect.scoped(driver.probe({ instanceId }))));
    const acquired = await acquireConnection(driver);
    await startSession(acquired.connection);
    const eventsPromise = takeEvents(acquired.connection, 1);
    await Effect.runPromise(
      acquired.connection.send({
        sessionId,
        prompt: "Inspect the page.",
        attachments: [],
        tools: [{ name: "octant_browser", inputSchema: {} }],
      }),
    );
    const [event] = await eventsPromise;
    if (event === undefined || event.kind !== "tool-request") {
      throw new Error("Expected an app-tool request event.");
    }
    expect(
      acquired.connection.toolRequestSignal?.({ sessionId, requestId: event.requestId }).aborted,
    ).toBe(true);
    await acquired.close();
  });

  it("encodes supported image attachments into the native Codex turn input", async () => {
    const f = fixture({
      modelPages: [{ data: [model("gpt-5.4", ["text", "image"])], nextCursor: null }],
    });
    const registry = new ProviderRuntimeRegistry();
    const driver = makeCodexDriver(f.options({ runtimeRegistry: registry }));
    registry.setObservedState(await Effect.runPromise(Effect.scoped(driver.probe({ instanceId }))));
    const acquired = await acquireConnection(driver);
    await startSession(acquired.connection);

    await Effect.runPromise(
      acquired.connection.send({
        sessionId,
        prompt: "Compare the image.",
        attachments: [
          {
            attachmentId: "attachment-1",
            displayName: "diagram.png",
            mediaType: "image/png",
            bytes: new Uint8Array([1, 2, 3]),
          },
        ],
        tools: [],
      }),
    );

    expect(f.calls.find(({ method }) => method === "turn/start")?.input).toEqual({
      threadId: "thread-1",
      input: [
        { type: "text", text: "Compare the image." },
        { type: "image", url: "data:image/png;base64,AQID" },
      ],
      approvalPolicy: "untrusted",
      sandboxPolicy: { type: "externalSandbox", networkAccess: "restricted" },
      approvalsReviewer: "user",
    });
    await acquired.close();
  });

  it("stops by unsubscribing and releasing local state without provider history mutation", async () => {
    const f = fixture();
    const acquired = await acquireConnection(makeCodexDriver(f.options()));
    await startSession(acquired.connection);
    await Effect.runPromise(acquired.connection.stop(sessionId));
    expect(f.calls.map(({ method }) => method)).toEqual([
      "account/read",
      "subscribe",
      "skills/list",
      "thread/start",
      "unsubscribe",
    ]);
    expect(f.calls.some(({ method }) => /archive|delete/.test(method))).toBe(false);
    await acquired.close();
  });

  it("keeps Codex's shell on and the Project's agent brief off for a Work thread on start and again on every resume", async () => {
    const workOff = {
      project_doc_max_bytes: 0,
      skills: { config: [] },
    };
    const f = fixture();
    const work = await acquireConnection(makeCodexDriver(f.options()), "work");
    await startSession(work.connection);
    await Effect.runPromise(
      work.connection.resume({
        sessionId: "session-resumed" as never,
        resumeCursor: { driverKind: "codex", value: "thread-existing" },
        executionPolicy: "approval-gated",
      }),
    );
    expect(f.calls.find(({ method }) => method === "thread/start")?.input).toMatchObject({
      config: workOff,
    });
    expect(f.calls.find(({ method }) => method === "thread/resume")?.input).toEqual({
      threadId: "thread-existing",
      config: workOff,
    });
    // Work shares Code's shell at the thread's level, so nothing switches it off.
    expect(f.calls.find(({ method }) => method === "thread/start")?.input).not.toHaveProperty([
      "config",
      "features.shell_tool",
    ]);
    await work.close();

    const code = fixture();
    const coding = await acquireConnection(makeCodexDriver(code.options()), "code");
    await startSession(coding.connection);
    expect(code.calls.find(({ method }) => method === "thread/start")?.input).toMatchObject({
      config: { skills: { config: [] } },
    });
    expect(code.calls.find(({ method }) => method === "thread/start")?.input).not.toHaveProperty([
      "config",
      "features.shell_tool",
    ]);
    expect(code.calls.find(({ method }) => method === "thread/start")?.input).not.toHaveProperty([
      "config",
      "project_doc_max_bytes",
    ]);
    await coding.close();
  });

  it("gives a Chat thread no environment, shell, image reads, plugins, or MCP servers on start, resume, and every turn", async () => {
    const chatOff = {
      "features.shell_tool": false,
      "features.unified_exec": false,
      "features.view_image": false,
      "features.plugins": false,
      "features.apps": false,
      mcp_servers: { node_repl: { enabled: false }, "docs.local": { enabled: false } },
      skills: { config: [] },
    };
    const f = fixture({
      configRead: async () => ({
        config: { mcp_servers: { node_repl: { command: "node_repl" }, "docs.local": {} } },
      }),
    });
    const chat = await acquireConnection(makeCodexDriver(f.options()), "chat");
    await startSession(chat.connection);
    await Effect.runPromise(
      chat.connection.send({ sessionId, prompt: "hello", attachments: [], tools: [] }),
    );
    await Effect.runPromise(
      chat.connection.resume({
        sessionId: "session-resumed" as never,
        resumeCursor: { driverKind: "codex", value: "thread-existing" },
        executionPolicy: "approval-gated",
      }),
    );
    expect(f.calls.find(({ method }) => method === "thread/start")?.input).toMatchObject({
      environments: [],
      config: chatOff,
    });
    expect(f.calls.find(({ method }) => method === "thread/resume")?.input).toEqual({
      threadId: "thread-existing",
      config: chatOff,
    });
    expect(f.calls.find(({ method }) => method === "turn/start")?.input).toMatchObject({
      environments: [],
    });
    expect(f.calls.find(({ method }) => method === "config/read")?.input).toEqual({
      cwd: projectRoot,
    });
    await chat.close();

    const code = fixture();
    const coding = await acquireConnection(makeCodexDriver(code.options()), "code");
    await startSession(coding.connection);
    await Effect.runPromise(
      coding.connection.send({ sessionId, prompt: "hello", attachments: [], tools: [] }),
    );
    for (const method of ["thread/start", "turn/start"]) {
      expect(code.calls.find((call) => call.method === method)?.input).not.toHaveProperty(
        "environments",
      );
    }
    await coding.close();
  });

  it("refuses to start a Chat thread when Codex cannot list its MCP servers", async () => {
    const f = fixture({
      configRead: async () => {
        throw new Error("config unreadable");
      },
    });
    const chat = await acquireConnection(makeCodexDriver(f.options()), "chat");
    await expect(startSession(chat.connection)).rejects.toThrow();
    expect(f.calls.some(({ method }) => method === "thread/start")).toBe(false);
    await chat.close();
  });

  it("switches off by path every Project skill Codex lists or could not load, on start and every resume, in every mode", async () => {
    const listing: CodexSkillsListResult = {
      data: [
        {
          skills: [
            { path: `${projectRoot}/.agents/skills/probe/SKILL.md`, scope: "repo" },
            { path: "/tmp/.agents/skills/repo-probe/SKILL.md", scope: "repo" },
            { path: `${projectRoot}/.agents/skills/later/SKILL.md`, scope: "workspace" },
            { path: "/Users/someone/.agents/skills/mine/SKILL.md", scope: "user" },
            { path: "/Users/someone/.codex/skills/.system/imagegen/SKILL.md", scope: "system" },
            { path: "/etc/codex/skills/policy/SKILL.md", scope: "admin" },
          ],
          errors: [{ path: `${projectRoot}/.agents/skills/unreadable/SKILL.md` }],
        },
      ],
    };
    const skillsOff = {
      config: [
        { path: `${projectRoot}/.agents/skills/probe/SKILL.md`, enabled: false },
        { path: "/tmp/.agents/skills/repo-probe/SKILL.md", enabled: false },
        { path: `${projectRoot}/.agents/skills/later/SKILL.md`, enabled: false },
        { path: `${projectRoot}/.agents/skills/unreadable/SKILL.md`, enabled: false },
      ],
    };
    for (const mode of ["chat", "work", "code"] as const) {
      const f = fixture({ skillsList: async () => listing });
      const acquired = await acquireConnection(makeCodexDriver(f.options()), mode);
      await startSession(acquired.connection);
      await Effect.runPromise(
        acquired.connection.resume({
          sessionId: secondSessionId,
          resumeCursor: { driverKind: "codex", value: "thread-existing" },
          executionPolicy: "approval-gated",
        }),
      );
      // Each lifecycle call is preceded by a listing of its own.
      const methods = f.calls.map(({ method }) => method);
      const start = methods.indexOf("thread/start");
      const resume = methods.indexOf("thread/resume");
      expect(methods.lastIndexOf("skills/list", start), mode).toBeGreaterThanOrEqual(0);
      expect(methods.lastIndexOf("skills/list", resume), mode).toBeGreaterThan(start);
      for (const at of [start, resume]) {
        expect(f.calls[at]?.input, mode).toMatchObject({ config: { skills: skillsOff } });
      }
      expect(
        f.calls.filter(({ method }) => method === "skills/list").map(({ input }) => input),
      ).toEqual([
        { cwds: [projectRoot], forceReload: true },
        { cwds: [projectRoot], forceReload: true },
      ]);
      await acquired.close();
    }
  });

  it("starts and resumes without skill rules on a Codex older than Project skills that does not know skills/list", async () => {
    for (const mode of ["chat", "work", "code"] as const) {
      const f = fixture({
        version: "0.65.0",
        skillsList: async () => {
          throw new CodexRpcClientFailure("remote", "Codex request failed.", {
            remoteCode: -32601,
            remoteMessage: "Method not found",
          });
        },
      });
      const acquired = await acquireConnection(makeCodexDriver(f.options()), mode);
      await startSession(acquired.connection);
      await Effect.runPromise(
        acquired.connection.resume({
          sessionId: secondSessionId,
          resumeCursor: { driverKind: "codex", value: "thread-existing" },
          executionPolicy: "approval-gated",
        }),
      );
      for (const method of ["thread/start", "thread/resume"]) {
        expect(f.calls.find((call) => call.method === method)?.input, mode).not.toHaveProperty([
          "config",
          "skills",
        ]);
      }
      await acquired.close();
    }

    const failing = fixture({
      version: "0.65.0",
      skillsList: async () => {
        throw new CodexRpcClientFailure("timeout", "synthetic timeout");
      },
    });
    const acquired = await acquireConnection(makeCodexDriver(failing.options()), "code");
    await expect(startSession(acquired.connection)).rejects.toThrow();
    expect(failing.calls.some(({ method }) => method === "thread/start")).toBe(false);
    await acquired.close();
  });

  it("refuses every thread on a Codex that loads Project skills but cannot take a thread's skill rules", async () => {
    for (const version of ["0.66.0", "0.107.2", "0.108.0-alpha.1"]) {
      const f = fixture({ version });
      const acquired = await acquireConnection(makeCodexDriver(f.options()), "code");
      await expect(startSession(acquired.connection)).rejects.toThrow(/0\.108\.0 or later/);
      await expect(
        Effect.runPromise(
          acquired.connection.resume({
            sessionId: secondSessionId,
            resumeCursor: { driverKind: "codex", value: "thread-existing" },
            executionPolicy: "approval-gated",
          }),
        ),
      ).rejects.toThrow(/0\.108\.0 or later/);
      expect(
        f.calls.some(({ method }) =>
          ["skills/list", "thread/start", "thread/resume"].includes(method),
        ),
        version,
      ).toBe(false);
      await acquired.close();
    }
  });

  it("refuses to start or resume a thread in any mode when Codex cannot list its skills", async () => {
    for (const mode of ["chat", "work", "code"] as const) {
      const f = fixture({
        skillsList: async () => {
          throw new Error("skills unreadable");
        },
      });
      const acquired = await acquireConnection(makeCodexDriver(f.options()), mode);
      await expect(startSession(acquired.connection)).rejects.toThrow();
      await expect(
        Effect.runPromise(
          acquired.connection.resume({
            sessionId: secondSessionId,
            resumeCursor: { driverKind: "codex", value: "thread-existing" },
            executionPolicy: "approval-gated",
          }),
        ),
      ).rejects.toThrow();
      expect(
        f.calls.some(({ method }) => method === "thread/start" || method === "thread/resume"),
      ).toBe(false);
      await acquired.close();
    }
  });

  it("resumes only Codex cursors that exist under the exact Project root", async () => {
    const f = fixture();
    const acquired = await acquireConnection(makeCodexDriver(f.options()));
    const valid = await Effect.runPromise(
      acquired.connection.resume({
        sessionId,
        resumeCursor: { driverKind: "codex", value: "thread-existing" },
        executionPolicy: "plan",
      }),
    );
    expect(valid.resumeCursor).toEqual({ driverKind: "codex", value: "thread-existing" });
    expect(f.calls.find(({ method }) => method === "thread/resume")?.input).toEqual({
      threadId: "thread-existing",
      config: { skills: { config: [] } },
    });
    for (const resumeCursor of [
      { driverKind: "opencode" as const, value: "thread-existing" },
      { driverKind: "codex" as const, value: "missing" },
      { driverKind: "codex" as const, value: "wrong-root" },
    ]) {
      const exit = await Effect.runPromise(
        Effect.exit(
          acquired.connection.resume({
            sessionId: secondSessionId,
            resumeCursor,
            executionPolicy: "plan",
          }),
        ),
      );
      expect(String(exit)).toMatch(/stale-resume|unauthorized/);
      expect(String(exit)).not.toContain("private provider detail");
    }
    await acquired.close();
  });

  it("refuses to resume a thread recorded for another task, folder, mode, or provider before asking Codex", async () => {
    const f = fixture();
    const acquired = await acquireConnection(makeCodexDriver(f.options()), "work");
    const binding = {
      instanceId,
      sessionId,
      projectRoot,
      mode: "work" as const,
      modelId: decodeProviderModelId("gpt-5.4"),
    };
    for (const mismatch of [
      { sessionId: secondSessionId },
      { projectRoot: "/tmp/octant-codex-other" },
      { mode: "code" as const },
      { instanceId: decodeProviderInstanceId("80000000-0000-4000-8000-000000000069") },
    ]) {
      const exit = await Effect.runPromise(
        Effect.exit(
          acquired.connection.resume({
            sessionId,
            resumeCursor: {
              driverKind: "codex",
              value: "thread-existing",
              binding: { ...binding, ...mismatch },
            },
            executionPolicy: "plan",
          }),
        ),
      );
      expect(String(exit)).toContain("stale-resume");
    }
    expect(f.calls.some(({ method }) => method === "thread/resume")).toBe(false);
    // Codex carries a thread onto another model, so the recorded one does not refuse it.
    const resumed = await Effect.runPromise(
      acquired.connection.resume({
        sessionId,
        resumeCursor: {
          driverKind: "codex",
          value: "thread-existing",
          binding: { ...binding, modelId: decodeProviderModelId("gpt-5.3") },
        },
        executionPolicy: "plan",
      }),
    );
    expect(resumed.resumeCursor?.binding?.sessionId).toBe(sessionId);
    await acquired.close();
  });

  it("resume retries while another Codex process holds the thread writer and succeeds once it is released", async () => {
    let attempts = 0;
    const delays: number[] = [];
    const f = fixture({
      threadResume: async () => {
        attempts += 1;
        if (attempts < 3) {
          throw new CodexRpcClientFailure("remote", "Codex request failed.", {
            remoteCode: -32600,
            remoteMessage: "thread t already has an active writer",
          });
        }
        return {
          thread: { id: "thread-released" },
          model: "gpt-5.4",
          modelProvider: "openai",
          serviceTier: null,
          cwd: projectRoot,
        };
      },
    });
    const acquired = await acquireConnection(
      makeCodexDriver(f.options({ sleep: async (milliseconds) => void delays.push(milliseconds) })),
    );

    const resumed = await Effect.runPromise(
      acquired.connection.resume({
        sessionId,
        resumeCursor: { driverKind: "codex", value: "thread-released" },
        executionPolicy: "plan",
      }),
    );

    expect(resumed.resumeCursor).toEqual({ driverKind: "codex", value: "thread-released" });
    expect(attempts).toBe(3);
    expect(delays).toEqual([400, 400]);
    await acquired.close();
  });

  it("resumes a thread under a new posture by closing the idle process that still holds it, but never one in use", async () => {
    // Measured with codex-cli 0.164.0: a thread stays loaded in its app-server
    // after `thread/unsubscribe`, so only that process ending frees the writer.
    let oldPostureAlive = () => false;
    const f = fixture({
      threadResume: async () => {
        if (oldPostureAlive()) {
          throw new CodexRpcClientFailure("remote", "Codex request failed.", {
            remoteCode: -32600,
            remoteMessage: "thread t already has an active writer",
          });
        }
        return {
          thread: { id: "thread-moved" },
          model: "gpt-5.4",
          modelProvider: "openai",
          serviceTier: null,
          cwd: projectRoot,
        };
      },
    });
    const driver = makeCodexDriver(f.options());
    const resume = (
      connection: Awaited<ReturnType<typeof acquireConnection>>["connection"],
      executionPolicy: ProviderExecutionPolicy,
    ) =>
      Effect.runPromise(
        Effect.exit(
          connection.resume({
            sessionId,
            resumeCursor: { driverKind: "codex", value: "thread-moved" },
            executionPolicy,
          }),
        ),
      );

    const planTurn = await acquireConnection(driver);
    expect(Exit.isSuccess(await resume(planTurn.connection, "plan"))).toBe(true);
    const otherPlanTurn = await acquireConnection(driver);
    expect(Exit.isSuccess(await resume(otherPlanTurn.connection, "plan"))).toBe(true);
    oldPostureAlive = () => f.closeCount() === 0;

    await planTurn.close();
    const held = await acquireConnection(driver);
    const refused = await resume(held.connection, "approval-gated");
    expect(String(refused)).toContain("Another Codex process is still using this thread");
    expect(f.closeCount()).toBe(0);
    await held.close();

    await otherPlanTurn.close();
    const gatedTurn = await acquireConnection(driver);
    expect(Exit.isSuccess(await resume(gatedTurn.connection, "approval-gated"))).toBe(true);
    // The Plan process closed; the approval-gated process that resumed stays.
    expect(f.closeCount()).toBe(1);
    expect(f.startCount()).toBe(2);
    await gatedTurn.close();
  });

  it("resume reports another Codex process using the thread when the writer conflict persists", async () => {
    const delays: number[] = [];
    const f = fixture({
      threadResume: async () => {
        throw new CodexRpcClientFailure("remote", "Codex request failed.", {
          remoteCode: -32600,
          remoteMessage: "thread t already has an active writer",
        });
      },
    });
    const registry = new ProviderRuntimeRegistry();
    const acquired = await acquireConnection(
      makeCodexDriver(
        f.options({
          runtimeRegistry: registry,
          sleep: async (milliseconds) => void delays.push(milliseconds),
        }),
      ),
    );

    const exit = await Effect.runPromise(
      Effect.exit(
        acquired.connection.resume({
          sessionId,
          resumeCursor: { driverKind: "codex", value: "thread-persistently-locked" },
          executionPolicy: "plan",
        }),
      ),
    );

    expect(String(exit)).toContain("unavailable");
    expect(String(exit)).toContain("Another Codex process is still using this thread");
    expect(String(exit)).not.toContain("no longer available");
    expect(f.calls.filter(({ method }) => method === "thread/resume")).toHaveLength(5);
    expect(delays).toEqual([400, 400, 400, 400]);
    expect(f.listenerCount()).toBe(0);
    expect(registry.activeSessionCount(instanceId)).toBe(0);
    await acquired.close();
  });

  it("resume keeps reporting a missing thread for other Codex errors", async () => {
    const f = fixture({
      threadResume: async () => {
        throw new CodexRpcClientFailure("remote", "Codex request failed.", {
          remoteCode: -32600,
          remoteMessage: "no rollout found",
        });
      },
    });
    const acquired = await acquireConnection(makeCodexDriver(f.options()));

    const exit = await Effect.runPromise(
      Effect.exit(
        acquired.connection.resume({
          sessionId,
          resumeCursor: { driverKind: "codex", value: "thread-missing" },
          executionPolicy: "plan",
        }),
      ),
    );

    expect(String(exit)).toContain("stale-resume");
    expect(String(exit)).toContain("Codex thread is no longer available for resume.");
    expect(String(exit)).not.toContain("no rollout found");
    expect(f.calls.filter(({ method }) => method === "thread/resume")).toHaveLength(1);
    await acquired.close();
  });

  it("removes the shared listener when thread/resume fails or returns a mismatched root", async () => {
    for (const value of ["missing", "wrong-root"] as const) {
      const f = fixture();
      const registry = new ProviderRuntimeRegistry();
      const acquired = await acquireConnection(
        makeCodexDriver(f.options({ runtimeRegistry: registry })),
      );
      const exit = await Effect.runPromise(
        Effect.exit(
          acquired.connection.resume({
            sessionId,
            resumeCursor: { driverKind: "codex", value },
            executionPolicy: "plan",
          }),
        ),
      );
      expect(String(exit)).toMatch(/stale-resume|unauthorized/);
      expect(String(exit)).not.toContain("private provider detail");
      expect(f.listenerCount()).toBe(0);
      expect(registry.activeSessionCount(instanceId)).toBe(0);
      await acquired.close();
    }
  });

  it("retains the shared listener when one overlapping lifecycle fails while another is pending", async () => {
    let resolveStart!: (thread: CodexThreadResult) => void;
    const pendingStart = new Promise<CodexThreadResult>((resolve) => {
      resolveStart = resolve;
    });
    const f = fixture({
      threadStart: async () => pendingStart,
      threadResume: async () => {
        throw new Error("private overlapping resume failure");
      },
    });
    const acquired = await acquireConnection(makeCodexDriver(f.options()));
    const starting = Effect.runPromise(
      acquired.connection.start({
        sessionId,
        modelId: "gpt-5.4" as never,
        executionPolicy: "approval-gated",
      }),
    );
    await vi.waitFor(() =>
      expect(f.calls.filter(({ method }) => method === "thread/start")).toHaveLength(1),
    );

    const failedResume = await Effect.runPromise(
      Effect.exit(
        acquired.connection.resume({
          sessionId: secondSessionId,
          resumeCursor: { driverKind: "codex", value: "thread-overlap" },
          executionPolicy: "approval-gated",
        }),
      ),
    );
    expect(String(failedResume)).toContain("stale-resume");
    expect(String(failedResume)).not.toContain("private overlapping resume failure");
    expect(f.listenerCount()).toBe(1);

    resolveStart({
      thread: { id: "thread-overlap" },
      model: "gpt-5.4",
      modelProvider: "openai",
      serviceTier: null,
      cwd: projectRoot,
    });
    await starting;
    await Effect.runPromise(
      acquired.connection.send({ sessionId, prompt: "stream once", attachments: [], tools: [] }),
    );
    const events = takeEvents(acquired.connection, 2);
    f.emit(
      notification("item/agentMessage/delta", {
        threadId: "thread-overlap",
        turnId: "turn-1",
        itemId: "item-1",
        delta: "retained",
      }),
    );
    f.emit(
      notification("turn/completed", {
        threadId: "thread-overlap",
        turn: { id: "turn-1", status: "completed" },
      }),
    );
    await expect(events).resolves.toMatchObject([
      { kind: "text-delta", text: "retained" },
      { kind: "completed" },
    ]);
    expect(f.listenerCount()).toBe(0);
    await acquired.close();
  });

  it("tells the running session about account usage windows that name no thread", async () => {
    const f = fixture();
    const acquired = await acquireConnection(makeCodexDriver(f.options()));
    await startSession(acquired.connection);
    await Effect.runPromise(
      acquired.connection.send({ sessionId, prompt: "usage", attachments: [], tools: [] }),
    );
    const events = takeEvents(acquired.connection, 2);
    f.emit(
      notification("account/rateLimits/updated", {
        rateLimits: {
          limitId: "codex",
          primary: { usedPercent: 40, windowDurationMins: 300, resetsAt: 1_784_000_000 },
          secondary: null,
        },
      }),
    );
    f.emit(
      notification("turn/completed", {
        threadId: "thread-1",
        turn: { id: "turn-1", status: "completed" },
      }),
    );

    await expect(events).resolves.toMatchObject([
      {
        kind: "rate-limit-window",
        window: "codex:primary_5h",
        status: "allowed",
        utilization: 0.4,
        sessionId,
      },
      { kind: "completed" },
    ]);
    await acquired.close();
  });

  it("keeps a running session alive on command output without exposing the output", async () => {
    const f = fixture();
    const acquired = await acquireConnection(makeCodexDriver(f.options()));
    await startSession(acquired.connection);
    await Effect.runPromise(
      acquired.connection.send({ sessionId, prompt: "build", attachments: [], tools: [] }),
    );
    const events = takeEvents(acquired.connection, 2);
    f.emit(
      notification("item/commandExecution/outputDelta", {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "item-1",
        delta: "private build output",
      }),
    );
    f.emit(
      notification("turn/completed", {
        threadId: "thread-1",
        turn: { id: "turn-1", status: "completed" },
      }),
    );

    const seen = await events;
    expect(seen).toMatchObject([{ kind: "liveness", sessionId }, { kind: "completed" }]);
    expect(JSON.stringify(seen)).not.toContain("private build output");
    await acquired.close();
  });

  it("retries saturation three times before accepted output with 50/100/200ms delays", async () => {
    let attempts = 0;
    const delays: number[] = [];
    const f = fixture({
      turnStart: async () => {
        attempts += 1;
        if (attempts < 4) throw new CodexRpcClientFailure("saturated", "private saturation");
        return { turn: { id: "turn-retried", status: "inProgress" } };
      },
    });
    const acquired = await acquireConnection(
      makeCodexDriver(f.options({ sleep: async (milliseconds) => void delays.push(milliseconds) })),
    );
    await startSession(acquired.connection);
    await Effect.runPromise(
      acquired.connection.send({ sessionId, prompt: "retry", attachments: [], tools: [] }),
    );
    expect(attempts).toBe(4);
    expect(delays).toEqual([50, 100, 200]);
    await acquired.close();
  });

  it("does not retry saturation after streamed output is accepted", async () => {
    let attempts = 0;
    let f!: Fixture;
    f = fixture({
      turnStart: async () => {
        attempts += 1;
        f.emit(
          notification("turn/started", {
            threadId: "thread-1",
            turn: { id: "turn-output", status: "inProgress" },
          }),
        );
        f.emit(
          notification("item/agentMessage/delta", {
            threadId: "thread-1",
            turnId: "turn-output",
            itemId: "item-1",
            delta: "accepted",
          }),
        );
        throw new CodexRpcClientFailure("saturated", "private saturation");
      },
    });
    const acquired = await acquireConnection(makeCodexDriver(f.options()));
    await startSession(acquired.connection);
    const eventPromise = takeEvents(acquired.connection, 1);
    const exit = await Effect.runPromise(
      Effect.exit(
        acquired.connection.send({ sessionId, prompt: "no retry", attachments: [], tools: [] }),
      ),
    );
    expect(attempts).toBe(1);
    expect(String(exit)).toContain("provider-failed");
    await expect(eventPromise).resolves.toMatchObject([{ kind: "text-delta", text: "accepted" }]);
    await acquired.close();
  });

  it("does not retry saturation after turn/started definitively accepts execution", async () => {
    let attempts = 0;
    const delays: number[] = [];
    let f!: Fixture;
    f = fixture({
      turnStart: async () => {
        attempts += 1;
        f.emit(
          notification("turn/started", {
            threadId: "thread-1",
            turn: { id: "turn-accepted", status: "inProgress" },
          }),
        );
        throw new CodexRpcClientFailure("saturated", "private saturation");
      },
    });
    const acquired = await acquireConnection(
      makeCodexDriver(f.options({ sleep: async (milliseconds) => void delays.push(milliseconds) })),
    );
    await startSession(acquired.connection);
    const exit = await Effect.runPromise(
      Effect.exit(
        acquired.connection.send({
          sessionId,
          prompt: "accepted once",
          attachments: [],
          tools: [],
        }),
      ),
    );
    expect(attempts).toBe(1);
    expect(delays).toEqual([]);
    expect(String(exit)).toContain("provider-failed");
    await acquired.close();
  });

  it("emits exactly one terminal event and fails closed on unexpected process death", async () => {
    const f = fixture();
    const acquired = await acquireConnection(makeCodexDriver(f.options()));
    await startSession(acquired.connection);
    await Effect.runPromise(
      acquired.connection.send({ sessionId, prompt: "terminal", attachments: [], tools: [] }),
    );
    const terminal = takeEvents(acquired.connection, 1);
    f.emit(
      notification("turn/completed", {
        threadId: "thread-1",
        turn: { id: "turn-1", status: "completed" },
      }),
    );
    f.emit(
      notification("turn/completed", {
        threadId: "thread-1",
        turn: { id: "turn-1", status: "completed" },
      }),
    );
    f.exit();
    await expect(terminal).resolves.toMatchObject([{ kind: "completed" }]);
    await Promise.resolve();
    expect(f.calls.filter(({ method }) => method === "unsubscribe")).toHaveLength(1);
    await acquired.close();

    const dying = fixture();
    const dyingConnection = await acquireConnection(makeCodexDriver(dying.options()));
    await startSession(dyingConnection.connection);
    await Effect.runPromise(
      dyingConnection.connection.send({
        sessionId,
        prompt: "process death",
        attachments: [],
        tools: [],
      }),
    );
    const interrupted = takeEvents(dyingConnection.connection, 1);
    dying.exit();
    await expect(interrupted).resolves.toMatchObject([
      { kind: "interrupted", message: expect.stringMatching(/runtime exited/i) },
    ]);
    await dyingConnection.close();
  });

  it("starts a fresh runtime and verifies the opaque thread again when reconnecting", async () => {
    const f = fixture();
    const driver = makeCodexDriver(f.options());
    const first = await acquireConnection(driver);
    await startSession(first.connection);
    f.exit();
    await vi.waitFor(() => expect(f.closeCount()).toBe(1));

    const reconnected = await acquireConnection(driver);
    const resumed = await Effect.runPromise(
      reconnected.connection.resume({
        sessionId: secondSessionId,
        resumeCursor: { driverKind: "codex", value: "thread-1" },
        executionPolicy: "plan",
      }),
    );
    expect(f.startCount()).toBe(2);
    expect(resumed.resumeCursor).toEqual({ driverKind: "codex", value: "thread-1" });
    expect(f.calls.filter(({ method }) => method === "thread/resume")).toHaveLength(1);
    await reconnected.close();
    await first.close();
  });

  it("fails closed to Waiting when process death leaves session recovery ambiguous", async () => {
    const f = fixture();
    const acquired = await acquireConnection(makeCodexDriver(f.options()));
    await startSession(acquired.connection);
    const waiting = takeEvents(acquired.connection, 1);
    f.exit();
    await expect(waiting).resolves.toMatchObject([
      { kind: "waiting", message: expect.stringMatching(/resume must be verified/i) },
    ]);
    await acquired.close();
  });

  it.each(["transport-corrupt", "transport-close"])(
    "fails closed once, releases listeners, and starts fresh after %s while the child stays alive",
    async (mode) => {
      const target = processFixture(mode);
      // A real launch resolves the thread's root before it starts the process.
      mkdirSync(projectRoot, { recursive: true });
      const registry = new ProviderRuntimeRegistry();
      let triggerFailure = true;
      let activeListeners = 0;
      const driver = makeCodexDriver({
        instanceId,
        binaryPath: target.binaryPath,
        process: makeCodexProcessLive({
          octantVersion: "0.1.0-test",
          startupTimeoutMs: 500,
          shutdownTimeoutMs: 50,
          // This case asserts transport recovery, not the profile: the live
          // builder refuses on a host without `sandbox-exec`, and a real
          // profile would deny the fixture the records file it writes beside
          // itself.
          versionProbeConfinement: {
            prepare: (input) => ({ command: input.executable, args: input.args }),
          },
          confinement: {
            prepare: (input) => ({ command: input.executable, args: input.args }),
          },
        }),
        runtimeRegistry: registry,
        idleLeaseMs: 0,
        clientFactory: (connection) => {
          const client = makeCodexClient(connection);
          return {
            ...client,
            turnStart: async (input) => {
              const turn = await client.turnStart(input);
              if (triggerFailure) {
                triggerFailure = false;
                await connection.rpc.notify("test/triggerTransportFailure");
                if (mode === "transport-close") await connection.rpc.close();
              }
              return turn;
            },
            subscribe: (listener) => {
              activeListeners += 1;
              const unsubscribe = client.subscribe(listener);
              return () => {
                activeListeners -= 1;
                unsubscribe();
              };
            },
          };
        },
      });

      const first = await acquireConnection(driver);
      await startSession(first.connection);
      const terminal = Effect.runPromise(
        Stream.runCollect(Stream.unwrapScoped(first.connection.subscribe)),
      ).then((events) => [...events]);
      await Effect.runPromise(
        first.connection.send({ sessionId, prompt: "break transport", attachments: [], tools: [] }),
      );
      const terminalEvents = await terminal;
      expect(terminalEvents).toHaveLength(1);
      expect(terminalEvents).toMatchObject([
        { kind: "interrupted", message: expect.stringMatching(/runtime exited/i) },
      ]);
      expect(activeListeners).toBe(0);
      await vi.waitFor(() => expect(registry.hasRuntime(instanceId)).toBe(false));
      const firstRuntimePids = processPids(target.root);
      expect(firstRuntimePids).toHaveLength(2);
      await vi.waitFor(() =>
        expect(firstRuntimePids.every((pid) => !processIsRunning(pid))).toBe(true),
      );

      const recovered = await acquireConnection(driver);
      await startSession(recovered.connection, secondSessionId);
      expect(processRecords(target.root).filter((record) => record.kind === "spawn")).toHaveLength(
        2,
      );
      await Effect.runPromise(recovered.connection.stop(secondSessionId));
      await recovered.close();
      await first.close();
      await vi.waitFor(() =>
        expect(processPids(target.root).every((pid) => !processIsRunning(pid))).toBe(true),
      );
      expect(activeListeners).toBe(0);
    },
  );
});

describe("Codex execution authority and approvals", () => {
  it("maps all execution policies to exact stable Codex settings", () => {
    expect(codexExecutionSettings("full-access")).toEqual({
      approvalPolicy: "never",
      sandbox: "danger-full-access",
      approvalsReviewer: "user",
    });
    expect(codexExecutionSettings("approval-gated")).toEqual({
      approvalPolicy: "untrusted",
      sandbox: "read-only",
      approvalsReviewer: "user",
    });
    expect(codexExecutionSettings("auto-accept-edits")).toEqual({
      approvalPolicy: "untrusted",
      sandbox: "read-only",
      approvalsReviewer: "user",
    });
    expect(codexExecutionSettings("plan")).toEqual({
      approvalPolicy: "never",
      sandbox: "read-only",
      approvalsReviewer: "user",
    });
  });

  it("asks before every command on both prompting postures, since the sandbox outside Codex never escalates", () => {
    // Below Full access the process runs inside Octant's profile and macOS
    // refuses Codex's own Seatbelt inside it, so turns name the sandbox
    // external. Under an external sandbox `on-request` runs every command
    // without asking (codex-rs `exec_policy.rs`, rust-v0.164.0), which would
    // silently waive the `shell-commands` class both postures keep. `untrusted`
    // asks for each command Codex does not know to be read-only.
    for (const policy of ["approval-gated", "auto-accept-edits"] as const) {
      expect(codexExecutionSettings(policy).approvalPolicy).toBe("untrusted");
      expect(codexTurnExecutionSettings(policy).sandboxPolicy).toEqual({
        type: "externalSandbox",
        networkAccess: "restricted",
      });
    }
  });

  it("carries the posture into a turn on a thread created under an older one", async () => {
    // `thread/start` settles a thread once, and codex-cli 0.154.0 accepts
    // `approvalPolicy`/`sandbox` on `thread/resume` while keeping what the
    // thread was created with — measured: a thread started `workspace-write`
    // and resumed `read-only` still wrote in-root without asking. So a thread
    // created before this mapping changed only comes under it if every turn
    // re-asserts it, which `sandboxPolicy` is documented to do for "this turn
    // and subsequent turns".
    const f = fixture();
    const acquired = await acquireConnection(makeCodexDriver(f.options()));
    await Effect.runPromise(
      acquired.connection.resume({
        sessionId,
        resumeCursor: { driverKind: "codex", value: "thread-existing" },
        executionPolicy: "approval-gated",
      }),
    );
    await Effect.runPromise(
      acquired.connection.send({ sessionId, prompt: "Write a file.", attachments: [], tools: [] }),
    );
    expect(f.calls.find(({ method }) => method === "turn/start")?.input).toMatchObject({
      approvalPolicy: "untrusted",
      sandboxPolicy: { type: "externalSandbox", networkAccess: "restricted" },
    });
    await acquired.close();
  });

  it.each([
    ["full-access", "never", { type: "dangerFullAccess" }],
    ["approval-gated", "untrusted", { type: "externalSandbox", networkAccess: "restricted" }],
    ["auto-accept-edits", "untrusted", { type: "externalSandbox", networkAccess: "restricted" }],
    ["plan", "never", { type: "externalSandbox", networkAccess: "restricted" }],
  ] as const)("re-asserts %s authority on every turn", (policy, approvalPolicy, sandboxPolicy) => {
    expect(codexTurnExecutionSettings(policy)).toEqual({
      approvalPolicy,
      sandboxPolicy,
      approvalsReviewer: "user",
    });
  });

  it("routes approvals back to the user rather than leaving the reviewer set", () => {
    // Codex documents `approvalsReviewer` as an override for "this thread and
    // subsequent turns", so omitting it keeps whatever the thread was last
    // told. A thread that once delegated would still route to the reviewer
    // after taint, after the user turns delegation off, or on a resume under a
    // posture that must not delegate — with the host never seeing the request.
    // Every path states the value, so the absence of delegation is sent rather
    // than implied.
    for (const policy of ["full-access", "approval-gated", "auto-accept-edits", "plan"] as const) {
      expect(codexExecutionSettings(policy).approvalsReviewer).toBe("user");
      expect(codexTurnExecutionSettings(policy).approvalsReviewer).toBe("user");
      expect(codexExecutionSettings(policy, false).approvalsReviewer).toBe("user");
    }
    expect(codexTurnExecutionSettings("approval-gated", true).approvalsReviewer).toBe(
      "auto_review",
    );
  });

  it("lets the reviewer answer on both prompting postures when the thread asks for Auto", () => {
    expect(codexExecutionSettings("auto-accept-edits", true)).toEqual({
      approvalPolicy: "untrusted",
      sandbox: "read-only",
      approvalsReviewer: "auto_review",
    });
    expect(codexExecutionSettings("approval-gated", true)).toEqual({
      approvalPolicy: "untrusted",
      sandbox: "read-only",
      approvalsReviewer: "auto_review",
    });
  });

  it.each([
    ["full-access", "never", "danger-full-access"],
    ["approval-gated", "untrusted", "read-only"],
    ["auto-accept-edits", "untrusted", "read-only"],
    ["plan", "never", "read-only"],
  ] as const)(
    "starts %s with only the Project root and exact authority",
    async (policy, approvalPolicy, sandbox) => {
      const f = fixture();
      const acquired = await acquireConnection(makeCodexDriver(f.options()));
      await startSession(acquired.connection, sessionId, policy);
      expect(f.calls.find(({ method }) => method === "thread/start")?.input).toEqual({
        cwd: projectRoot,
        model: "gpt-5.4",
        approvalPolicy,
        sandbox,
        approvalsReviewer: "user",
        config: { skills: { config: [] } },
      });
      await acquired.close();
    },
  );

  it.each([
    ["command", commandApproval, true, "current-session", "acceptForSession"],
    ["command", commandApproval, true, "project-default", "accept"],
    ["command", commandApproval, false, "current-session", "decline"],
    ["file change", fileApproval, true, "current-session", "acceptForSession"],
    ["file change", fileApproval, true, "project-default", "accept"],
    ["file change", fileApproval, false, "current-session", "decline"],
  ] as const)(
    "maps %s approval responses",
    async (_name, makeRequest, approved, persistence, decision) => {
      const f = fixture();
      const acquired = await acquireConnection(
        makeCodexDriver(f.options({ permissionPersistence: () => persistence })),
      );
      await startSession(acquired.connection);
      await Effect.runPromise(
        acquired.connection.send({ sessionId, prompt: "approval", attachments: [], tools: [] }),
      );
      const event = takeEvents(acquired.connection, 1);
      f.emit(makeRequest());
      await expect(event).resolves.toMatchObject([
        {
          kind: "approval-request",
          requestId: "request-1",
          description: "Approval is required for this action.",
        },
      ]);
      await Effect.runPromise(
        acquired.connection.answerApproval({ sessionId, requestId: "request-1", approved }),
      );
      expect(f.calls.at(-1)).toEqual({
        method: "approval/respond",
        input: {
          providerRequestId: expect.anything(),
          result: { decision },
        },
      });
      await acquired.close();
    },
  );

  it.each([
    ["command", commandApproval],
    ["file change", fileApproval],
  ] as const)(
    "accepts a one-call %s answer for that call only, even under current-session persistence",
    async (_name, makeRequest) => {
      const f = fixture();
      const acquired = await acquireConnection(
        makeCodexDriver(f.options({ permissionPersistence: () => "current-session" })),
      );
      await startSession(acquired.connection);
      await Effect.runPromise(
        acquired.connection.send({ sessionId, prompt: "approval", attachments: [], tools: [] }),
      );
      const event = takeEvents(acquired.connection, 1);
      f.emit(makeRequest());
      await event;
      await Effect.runPromise(
        acquired.connection.answerApproval({
          sessionId,
          requestId: "request-1",
          approved: true,
          scope: "once",
        }),
      );
      expect(f.calls.at(-1)?.input).toMatchObject({ result: { decision: "accept" } });
      await acquired.close();
    },
  );

  it("defaults approval persistence to the current session", async () => {
    const f = fixture();
    const acquired = await acquireConnection(makeCodexDriver(f.options()));
    await startSession(acquired.connection);
    await Effect.runPromise(
      acquired.connection.send({ sessionId, prompt: "approval", attachments: [], tools: [] }),
    );
    const event = takeEvents(acquired.connection, 1);
    f.emit(commandApproval());
    await event;
    await Effect.runPromise(
      acquired.connection.answerApproval({ sessionId, requestId: "request-1", approved: true }),
    );
    expect(f.calls.at(-1)?.input).toMatchObject({ result: { decision: "acceptForSession" } });
    await acquired.close();
  });

  it.each(["current-session", "project-default"] as const)(
    "grants only the requested permission subset for one turn with %s persistence",
    async (persistence) => {
      const permissions = {
        network: { enabled: true },
        fileSystem: {
          read: [projectRoot],
          write: [`${projectRoot}/src`],
          entries: [
            {
              path: { type: "path" as const, path: `${projectRoot}/src` },
              access: "write" as const,
            },
          ],
        },
      };
      const f = fixture();
      const acquired = await acquireConnection(
        makeCodexDriver(f.options({ permissionPersistence: () => persistence })),
      );
      await startSession(acquired.connection);
      await Effect.runPromise(
        acquired.connection.send({ sessionId, prompt: "permissions", attachments: [], tools: [] }),
      );
      const event = takeEvents(acquired.connection, 1);
      f.emit(permissionsApproval({ permissions }));
      await event;
      await Effect.runPromise(
        acquired.connection.answerApproval({ sessionId, requestId: "request-1", approved: true }),
      );
      expect(f.calls.at(-1)?.input).toEqual({
        providerRequestId: "provider-permissions-request",
        result: { permissions, scope: "turn" },
      });
      await acquired.close();
    },
  );

  it("surfaces network approval only in approval-gated mode with a sanitized description", async () => {
    const f = fixture();
    const acquired = await acquireConnection(makeCodexDriver(f.options()));
    await startSession(acquired.connection);
    await Effect.runPromise(
      acquired.connection.send({ sessionId, prompt: "network", attachments: [], tools: [] }),
    );
    const event = takeEvents(acquired.connection, 1);
    f.emit(commandApproval({ network: true }));
    await expect(event).resolves.toMatchObject([
      {
        kind: "approval-request",
        action: "command",
        description: "Approval is required for this action.",
      },
    ]);
    expect(JSON.stringify(await event)).not.toMatch(/private\.example|secret|curl/);
    await acquired.close();
  });

  it.each([projectRoot, `${projectRoot}/src`] as const)(
    "surfaces a command approval with private cwd %s only when it is Project-confined",
    async (cwd) => {
      const f = fixture();
      const acquired = await acquireConnection(makeCodexDriver(f.options()));
      await startSession(acquired.connection);
      await Effect.runPromise(
        acquired.connection.send({ sessionId, prompt: "confined cwd", attachments: [], tools: [] }),
      );
      const event = takeEvents(acquired.connection, 1);
      f.emit(commandApproval({ cwd }));
      const approvalEvents = await event;
      expect(approvalEvents).toMatchObject([
        {
          kind: "approval-request",
          requestId: "request-1",
          description: "Approval is required for this action.",
        },
      ]);
      expect(JSON.stringify(approvalEvents)).not.toMatch(
        /octant-codex-project|curl|private\.example/,
      );
      // The command reaches an automatic reviewer through the connection
      // alone, with its working directory and without the runtime's reason.
      const call = acquired.connection.approvalCall?.({ sessionId, requestId: "request-1" });
      expect(call).toMatchObject({ tool: "command", workingDirectory: cwd });
      expect(call?.input).toContain("curl private.example/secret");
      expect(call?.input).not.toContain("must-not-cross");
      await Effect.runPromise(
        acquired.connection.answerApproval({ sessionId, requestId: "request-1", approved: false }),
      );
      expect(
        acquired.connection.approvalCall?.({ sessionId, requestId: "request-1" }),
      ).toBeUndefined();
      expect(f.calls.at(-1)?.input).toMatchObject({ result: { decision: "decline" } });
      await acquired.close();
    },
  );

  it.each(["/private/outside", `${projectRoot}/../outside`, "../outside"])(
    "auto-declines command approval cwd outside the Project root: %s",
    async (cwd) => {
      const f = fixture();
      const acquired = await acquireConnection(makeCodexDriver(f.options()));
      await startSession(acquired.connection);
      await Effect.runPromise(
        acquired.connection.send({ sessionId, prompt: "outside cwd", attachments: [], tools: [] }),
      );
      f.emit(commandApproval({ cwd }));
      await vi.waitFor(() =>
        expect(f.calls.filter(({ method }) => method === "approval/respond")).toHaveLength(1),
      );
      expect(f.calls.at(-1)?.input).toMatchObject({ result: { decision: "decline" } });
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
      expect(String(answer)).not.toContain(cwd);
      await acquired.close();
    },
  );

  it.each([
    [fileApproval({ grantRoot: "/private/outside" }), { decision: "decline" }],
    [
      permissionsApproval({
        permissions: {
          network: null,
          fileSystem: { read: null, write: ["/private/outside"] },
        },
      }),
      { permissions: {}, scope: "turn" },
    ],
  ] as const)(
    "auto-declines an outside-root filesystem request",
    async (requestMessage, result) => {
      const f = fixture();
      const acquired = await acquireConnection(makeCodexDriver(f.options()));
      await startSession(acquired.connection);
      await Effect.runPromise(
        acquired.connection.send({ sessionId, prompt: "filesystem", attachments: [], tools: [] }),
      );
      f.emit(requestMessage);
      await vi.waitFor(() =>
        expect(f.calls.filter(({ method }) => method === "approval/respond")).toHaveLength(1),
      );
      expect(f.calls.at(-1)?.input).toMatchObject({ result });
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
      await acquired.close();
    },
  );

  it.each([
    ["command", commandApproval()],
    ["permissions", permissionsApproval()],
  ] as const)(
    "asks a person about a Project-confined %s approval in a Work session, as in Code",
    async (_kind, requestMessage) => {
      for (const mode of ["work", "code"] as const) {
        const f = fixture();
        const acquired = await acquireConnection(makeCodexDriver(f.options()), mode);
        await startSession(acquired.connection);
        await Effect.runPromise(
          acquired.connection.send({ sessionId, prompt: mode, attachments: [], tools: [] }),
        );
        const event = takeEvents(acquired.connection, 1);
        f.emit(requestMessage);
        await expect(event).resolves.toMatchObject([
          { kind: "approval-request", requestId: "request-1" },
        ]);
        expect(f.calls.some(({ method }) => method === "approval/respond")).toBe(false);
        await acquired.close();
      }
    },
  );

  it.each([
    [commandApproval(), { decision: "decline" }],
    [fileApproval(), { decision: "decline" }],
    [permissionsApproval(), { permissions: {}, scope: "turn" }],
  ] as const)(
    "declines every provider approval in a Chat session without asking anyone",
    async (requestMessage, result) => {
      const f = fixture();
      const acquired = await acquireConnection(makeCodexDriver(f.options()), "chat");
      await startSession(acquired.connection);
      await Effect.runPromise(
        acquired.connection.send({ sessionId, prompt: "chat", attachments: [], tools: [] }),
      );
      f.emit(requestMessage);
      await vi.waitFor(() =>
        expect(f.calls.filter(({ method }) => method === "approval/respond")).toHaveLength(1),
      );
      expect(f.calls.at(-1)?.input).toMatchObject({ result });
      await acquired.close();
    },
  );

  it("still asks a person about a Project-confined file change in a Work session", async () => {
    const f = fixture();
    const acquired = await acquireConnection(makeCodexDriver(f.options()), "work");
    await startSession(acquired.connection);
    await Effect.runPromise(
      acquired.connection.send({ sessionId, prompt: "work edit", attachments: [], tools: [] }),
    );
    const event = takeEvents(acquired.connection, 1);
    f.emit(fileApproval());
    await expect(event).resolves.toMatchObject([
      { kind: "approval-request", requestId: "request-1" },
    ]);
    expect(f.calls.some(({ method }) => method === "approval/respond")).toBe(false);
    await acquired.close();
  });

  it.each([
    [commandApproval(), { decision: "decline" }],
    [fileApproval(), { decision: "decline" }],
    [permissionsApproval(), { permissions: {}, scope: "turn" }],
  ] as const)("auto-declines provider approvals in Plan mode", async (requestMessage, result) => {
    const f = fixture();
    const acquired = await acquireConnection(makeCodexDriver(f.options()));
    await startSession(acquired.connection, sessionId, "plan");
    await Effect.runPromise(
      acquired.connection.send({ sessionId, prompt: "plan", attachments: [], tools: [] }),
    );
    f.emit(requestMessage);
    await vi.waitFor(() =>
      expect(f.calls.filter(({ method }) => method === "approval/respond")).toHaveLength(1),
    );
    expect(f.calls.at(-1)?.input).toMatchObject({ result });
    const answer = await Effect.runPromise(
      Effect.exit(
        acquired.connection.answerApproval({ sessionId, requestId: "request-1", approved: true }),
      ),
    );
    expect(String(answer)).toContain("unauthorized");
    await acquired.close();
  });

  it("answers project-confined file changes itself under auto-accept edits and still asks for commands", async () => {
    const f = fixture();
    const acquired = await acquireConnection(makeCodexDriver(f.options()));
    await startSession(acquired.connection, sessionId, "auto-accept-edits");
    await Effect.runPromise(
      acquired.connection.send({ sessionId, prompt: "edit", attachments: [], tools: [] }),
    );
    f.emit(fileApproval({ id: "file-1" }));
    await vi.waitFor(() =>
      expect(f.calls.filter(({ method }) => method === "approval/respond")).toHaveLength(1),
    );
    expect(f.calls.find(({ method }) => method === "approval/respond")?.input).toMatchObject({
      result: { decision: "accept" },
    });
    // A file change reaching outside the Project is still declined, not accepted.
    f.emit(fileApproval({ id: "file-2", grantRoot: "/outside" }));
    await vi.waitFor(() =>
      expect(f.calls.filter(({ method }) => method === "approval/respond")).toHaveLength(2),
    );
    expect(f.calls.filter(({ method }) => method === "approval/respond")[1]?.input).toMatchObject({
      result: { decision: "decline" },
    });
    // Commands are not edits: they surface as an approval for the user.
    const event = takeEvents(acquired.connection, 1);
    f.emit(commandApproval({ id: "cmd-1" }));
    const [approval] = await event;
    expect(approval?.kind).toBe("approval-request");
    await acquired.close();
  });

  it("treats a provider approval in Full access as a protocol failure", async () => {
    const f = fixture();
    const acquired = await acquireConnection(makeCodexDriver(f.options()));
    await startSession(acquired.connection, sessionId, "full-access");
    await Effect.runPromise(
      acquired.connection.send({ sessionId, prompt: "full", attachments: [], tools: [] }),
    );
    const failed = takeEvents(acquired.connection, 1);
    f.emit(commandApproval({ network: true }));
    await expect(failed).resolves.toMatchObject([
      { kind: "failed", failure: { category: "protocol" } },
    ]);
    expect(f.calls.filter(({ method }) => method === "approval/respond")).toHaveLength(0);
    await acquired.close();
  });

  it("removes a pending approval before writing its response", async () => {
    let release!: () => void;
    const pendingResponse = new Promise<void>((resolve) => {
      release = resolve;
    });
    const f = fixture({ respondApproval: async () => pendingResponse });
    const acquired = await acquireConnection(makeCodexDriver(f.options()));
    await startSession(acquired.connection);
    await Effect.runPromise(
      acquired.connection.send({ sessionId, prompt: "atomic", attachments: [], tools: [] }),
    );
    const event = takeEvents(acquired.connection, 1);
    f.emit(commandApproval());
    await event;
    const first = Effect.runPromise(
      acquired.connection.answerApproval({ sessionId, requestId: "request-1", approved: true }),
    );
    await vi.waitFor(() =>
      expect(f.calls.filter(({ method }) => method === "approval/respond")).toHaveLength(1),
    );
    const duplicate = await Effect.runPromise(
      Effect.exit(
        acquired.connection.answerApproval({ sessionId, requestId: "request-1", approved: true }),
      ),
    );
    expect(String(duplicate)).toContain("protocol");
    release();
    await first;
    await acquired.close();
  });

  it("fails closed when the provider rejects an atomically consumed approval response", async () => {
    let request = 0;
    const registry = new ProviderRuntimeRegistry();
    const f = fixture({
      respondApproval: async () => {
        throw new Error("raw approval write secret must-not-cross");
      },
    });
    const acquired = await acquireConnection(
      makeCodexDriver(
        f.options({
          runtimeRegistry: registry,
          requestId: () => `request-${++request}`,
        }),
      ),
    );
    await startSession(acquired.connection);
    await Effect.runPromise(
      acquired.connection.send({
        sessionId,
        prompt: "reject response",
        attachments: [],
        tools: [],
      }),
    );
    const approvals = takeEvents(acquired.connection, 2);
    f.emit(commandApproval({ id: "provider-request-1", itemId: "item-1" }));
    f.emit(fileApproval({ id: "provider-request-2", itemId: "item-2" }));
    await expect(approvals).resolves.toMatchObject([
      { kind: "approval-request", requestId: "request-1" },
      { kind: "approval-request", requestId: "request-2" },
    ]);

    const terminal = Promise.race([
      Effect.runPromise(Stream.runCollect(Stream.unwrapScoped(acquired.connection.subscribe))).then(
        (chunk) => [...chunk],
      ),
      new Promise<ReadonlyArray<ProviderRuntimeEvent>>((resolveTimeout) =>
        setTimeout(() => resolveTimeout([]), 50),
      ),
    ]);
    const response = await Effect.runPromise(
      Effect.exit(
        acquired.connection.answerApproval({
          sessionId,
          requestId: "request-1",
          approved: true,
        }),
      ),
    );
    const duplicate = await Effect.runPromise(
      Effect.exit(
        acquired.connection.answerApproval({
          sessionId,
          requestId: "request-1",
          approved: true,
        }),
      ),
    );
    const sibling = await Effect.runPromise(
      Effect.exit(
        acquired.connection.answerApproval({
          sessionId,
          requestId: "request-2",
          approved: true,
        }),
      ),
    );
    const terminalEvents = await terminal;
    const activeSessions = registry.activeSessionCount(instanceId);
    const responseCalls = f.calls.filter(({ method }) => method === "approval/respond");
    await acquired.close();

    expect(String(response)).toContain("provider-failed");
    expect(String(duplicate)).toContain("protocol");
    expect(String(sibling)).toContain("protocol");
    expect(JSON.stringify([response, duplicate, sibling, terminalEvents])).not.toContain(
      "raw approval write secret",
    );
    expect(terminalEvents).toMatchObject([
      {
        kind: "waiting",
        message: expect.stringMatching(/approval response failed.*resume/i),
      },
    ]);
    expect(terminalEvents).toHaveLength(1);
    expect(activeSessions).toBe(0);
    expect(responseCalls).toHaveLength(1);
  });

  it("rejects unknown, late, cross-session, cross-turn, and wrong-item approval answers", async () => {
    const f = fixture();
    const acquired = await acquireConnection(makeCodexDriver(f.options()));
    await startSession(acquired.connection);
    await Effect.runPromise(
      acquired.connection.send({ sessionId, prompt: "correlate", attachments: [], tools: [] }),
    );

    const unknown = await Effect.runPromise(
      Effect.exit(
        acquired.connection.answerApproval({ sessionId, requestId: "unknown", approved: true }),
      ),
    );
    expect(String(unknown)).toContain("protocol");

    const crossTurnFailure = takeEvents(acquired.connection, 1);
    f.emit(commandApproval({ turnId: "turn-other" }));
    await expect(crossTurnFailure).resolves.toMatchObject([
      { kind: "failed", failure: { category: "protocol" } },
    ]);
    const crossTurn = await Effect.runPromise(
      Effect.exit(
        acquired.connection.answerApproval({ sessionId, requestId: "request-1", approved: true }),
      ),
    );
    expect(String(crossTurn)).toContain("protocol");

    await Effect.runPromise(acquired.connection.stop(sessionId));
    await startSession(acquired.connection, sessionId);
    await Effect.runPromise(
      acquired.connection.send({ sessionId, prompt: "late", attachments: [], tools: [] }),
    );
    const pending = takeEvents(acquired.connection, 1);
    f.emit(commandApproval({ id: "late-request", threadId: "thread-2" }));
    await pending;
    await Effect.runPromise(acquired.connection.stop(sessionId));
    const late = await Effect.runPromise(
      Effect.exit(
        acquired.connection.answerApproval({ sessionId, requestId: "request-1", approved: true }),
      ),
    );
    expect(String(late)).toContain("protocol");

    await startSession(acquired.connection, sessionId);
    await startSession(acquired.connection, secondSessionId);
    await Effect.runPromise(
      acquired.connection.send({ sessionId, prompt: "session one", attachments: [], tools: [] }),
    );
    const crossSessionEvent = takeEvents(acquired.connection, 1);
    f.emit(commandApproval({ id: "cross-session", threadId: "thread-3" }));
    await crossSessionEvent;
    const crossSession = await Effect.runPromise(
      Effect.exit(
        acquired.connection.answerApproval({
          sessionId: secondSessionId,
          requestId: "request-1",
          approved: true,
        }),
      ),
    );
    expect(String(crossSession)).toContain("protocol");
    await Effect.runPromise(
      acquired.connection.answerApproval({
        sessionId,
        requestId: "request-1",
        approved: false,
      }),
    );

    await Effect.runPromise(
      acquired.connection.send({
        sessionId: secondSessionId,
        prompt: "item",
        attachments: [],
        tools: [],
      }),
    );
    const firstItem = takeEvents(acquired.connection, 1);
    f.emit(commandApproval({ id: "item-one", threadId: "thread-4", itemId: "item-one" }));
    await firstItem;
    const wrongItemFailure = takeEvents(acquired.connection, 1);
    f.emit(commandApproval({ id: "item-two", threadId: "thread-4", itemId: "item-two" }));
    await expect(wrongItemFailure).resolves.toMatchObject([
      { kind: "failed", failure: { category: "protocol" } },
    ]);
    const wrongItem = await Effect.runPromise(
      Effect.exit(
        acquired.connection.answerApproval({
          sessionId: secondSessionId,
          requestId: "request-1",
          approved: true,
        }),
      ),
    );
    expect(String(wrongItem)).toContain("protocol");
    await acquired.close();
  });

  it.each(["full-access", "approval-gated", "plan"] as const)(
    "keeps stable user questions unsupported in %s mode",
    async (policy) => {
      const f = fixture();
      const acquired = await acquireConnection(makeCodexDriver(f.options()));
      await startSession(acquired.connection, sessionId, policy);
      const answer = await Effect.runPromise(
        Effect.exit(
          acquired.connection.answerUserInput({
            sessionId,
            requestId: "question",
            answer: "private answer",
          }),
        ),
      );
      expect(String(answer)).toContain("unsupported");
      await acquired.close();
    },
  );
});

function compactOf(connection: Awaited<ReturnType<typeof acquireConnection>>["connection"]) {
  const compact = connection.compact;
  if (compact === undefined) throw new Error("The Codex connection compacts.");
  return compact;
}

describe("compacting a Codex session", () => {
  const compactionId = "c0000000-0000-4000-8000-000000000001";
  const turnStarted = (turnId: string) =>
    notification("turn/started", {
      threadId: "thread-1",
      turn: { id: turnId, status: "inProgress" },
    });
  const compactionItem = (method: "item/started" | "item/completed", turnId: string) =>
    notification(method, {
      threadId: "thread-1",
      turnId,
      item: { type: "contextCompaction", id: "compaction-item" },
      ...(method === "item/started" ? { startedAtMs: 10 } : { completedAtMs: 20 }),
    });
  const turnCompleted = (turnId: string, status: "completed" | "failed" | "interrupted") =>
    notification("turn/completed", {
      threadId: "thread-1",
      turn: { id: turnId, status },
    });

  async function compacting(f: Fixture): Promise<{
    readonly acquired: Awaited<ReturnType<typeof acquireConnection>>;
    readonly events: Promise<ReadonlyArray<ProviderRuntimeEvent>>;
    readonly result: Promise<unknown>;
  }> {
    const acquired = await acquireConnection(makeCodexDriver(f.options()), "work");
    await startSession(acquired.connection);
    const compact = compactOf(acquired.connection);
    const events = takeEvents(acquired.connection, 2);
    const result = Effect.runPromise(compact({ sessionId, compactionId }));
    return { acquired, events, result };
  }

  it("claims compaction in every mode only from the release it was read against", async () => {
    const current = fixture({ version: "0.162.1" });
    const probed = await Effect.runPromise(
      Effect.scoped(makeCodexDriver(current.options()).probe({ instanceId })),
    );
    expect(probed.capabilities.sessionCompaction).toEqual({
      chat: "supported",
      work: "supported",
      code: "supported",
    });
    const older = fixture({ version: "0.162.0" });
    const olderProbe = await Effect.runPromise(
      Effect.scoped(makeCodexDriver(older.options()).probe({ instanceId })),
    );
    expect(olderProbe.capabilities.sessionCompaction).toEqual({
      chat: "unavailable",
      work: "unavailable",
      code: "unavailable",
    });
  });

  it("asks Codex to compact the thread and reports the compaction as requested before answering", async () => {
    const f = fixture({ version: "0.162.1" });
    const { acquired, events, result } = await compacting(f);
    f.emit(turnStarted("turn-c"));
    f.emit(compactionItem("item/started", "turn-c"));
    f.emit(compactionItem("item/completed", "turn-c"));
    f.emit(turnCompleted("turn-c", "completed"));

    await expect(result).resolves.toEqual({ kind: "compacted" });
    expect(f.calls.find(({ method }) => method === "thread/compact/start")?.input).toEqual({
      threadId: "thread-1",
    });
    expect((await events).map((event) => event.kind)).toEqual(["context-compacted", "completed"]);
    expect((await events)[0]).toMatchObject({ trigger: "requested", sessionId });
    await acquired.close();
  });

  it("interrupts in Codex a compaction the host gave up waiting for", async () => {
    const f = fixture({ version: "0.162.1" });
    const acquired = await acquireConnection(makeCodexDriver(f.options()), "work");
    await startSession(acquired.connection);
    const waiting = Effect.runFork(compactOf(acquired.connection)({ sessionId, compactionId }));
    await vi.waitFor(() =>
      expect(f.calls.some(({ method }) => method === "thread/compact/start")).toBe(true),
    );
    f.emit(turnStarted("turn-c"));
    // The host's bound runs out: it stops waiting, then ends the run.
    await Effect.runPromise(Fiber.interrupt(waiting));
    await Effect.runPromise(acquired.connection.interrupt(sessionId));

    expect(f.calls.find(({ method }) => method === "turn/interrupt")?.input).toEqual({
      threadId: "thread-1",
      turnId: "turn-c",
    });
    await acquired.close();
  });

  it("says a compaction Codex reported as failed left the thread alone", async () => {
    const f = fixture({ version: "0.162.1" });
    const { acquired, result } = await compacting(f);
    f.emit(turnStarted("turn-c"));
    f.emit(compactionItem("item/started", "turn-c"));
    f.emit(turnCompleted("turn-c", "failed"));

    await expect(result).resolves.toEqual({
      kind: "failed",
      message: "Codex could not compact the session.",
      sessionMayHaveChanged: false,
    });
    await acquired.close();
  });

  it("cannot vouch for a compaction that was interrupted before it reported", async () => {
    const f = fixture({ version: "0.162.1" });
    const { acquired, result } = await compacting(f);
    f.emit(turnStarted("turn-c"));
    f.emit(compactionItem("item/started", "turn-c"));
    f.emit(turnCompleted("turn-c", "interrupted"));

    await expect(result).resolves.toMatchObject({
      kind: "failed",
      sessionMayHaveChanged: true,
    });
    await acquired.close();
  });

  it("counts a compaction whose item completed even when the run then fails", async () => {
    const f = fixture({ version: "0.162.1" });
    const { acquired, result } = await compacting(f);
    f.emit(turnStarted("turn-c"));
    f.emit(compactionItem("item/started", "turn-c"));
    f.emit(compactionItem("item/completed", "turn-c"));
    f.emit(turnCompleted("turn-c", "failed"));

    await expect(result).resolves.toEqual({ kind: "compacted" });
    await acquired.close();
  });

  it("refuses as too old when the runtime does not know the request, and touches nothing", async () => {
    const f = fixture({
      version: "0.162.1",
      threadCompactStart: async () => {
        throw new CodexRpcClientFailure("remote", "Codex request failed.", {
          remoteCode: -32601,
          remoteMessage: "Method not found",
        });
      },
    });
    const { acquired, result } = await compacting(f);
    await expect(result).resolves.toEqual({
      kind: "refused",
      reason: "runtime-version-unsupported",
    });
    await acquired.close();
  });

  it("refuses an install older than the release it was read against without asking it", async () => {
    const f = fixture({ version: "0.162.0" });
    const acquired = await acquireConnection(makeCodexDriver(f.options()), "chat");
    await startSession(acquired.connection);
    await expect(
      Effect.runPromise(compactOf(acquired.connection)({ sessionId, compactionId })),
    ).resolves.toEqual({ kind: "refused", reason: "runtime-version-unsupported" });
    expect(f.calls.some(({ method }) => method === "thread/compact/start")).toBe(false);
    await acquired.close();
  });

  it("answers a compaction whose session is stopped or whose connection closes as one that may have changed it", async () => {
    const stopped = fixture({ version: "0.162.1" });
    const first = await compacting(stopped);
    await Effect.runPromise(first.acquired.connection.stop(sessionId));
    await expect(first.result).resolves.toMatchObject({
      kind: "failed",
      sessionMayHaveChanged: true,
    });
    await first.acquired.close();

    const closed = fixture({ version: "0.162.1" });
    const second = await compacting(closed);
    await second.acquired.close();
    await expect(second.result).resolves.toMatchObject({
      kind: "failed",
      sessionMayHaveChanged: true,
    });
  });

  it("refuses a turn while its compaction is pending", async () => {
    const f = fixture({ version: "0.162.1" });
    const { acquired, result } = await compacting(f);
    await expect(
      Effect.runPromise(
        acquired.connection.send({ sessionId, prompt: "too soon", attachments: [], tools: [] }),
      ),
    ).rejects.toThrow();
    expect(f.calls.some(({ method }) => method === "turn/start")).toBe(false);
    f.emit(turnStarted("turn-c"));
    f.emit(turnCompleted("turn-c", "failed"));
    await expect(result).resolves.toMatchObject({ kind: "failed", sessionMayHaveChanged: false });
    await acquired.close();
  });

  it("refuses while a turn runs on the session", async () => {
    const f = fixture({ version: "0.162.1" });
    const acquired = await acquireConnection(makeCodexDriver(f.options()), "work");
    await startSession(acquired.connection);
    await Effect.runPromise(
      acquired.connection.send({ sessionId, prompt: "Keep going.", attachments: [], tools: [] }),
    );
    await expect(
      Effect.runPromise(compactOf(acquired.connection)({ sessionId, compactionId })),
    ).resolves.toEqual({ kind: "refused", reason: "turn-running" });
    await acquired.close();
  });

  it("reports a compaction Codex ran by itself inside a turn as automatic", async () => {
    const f = fixture({ version: "0.162.1" });
    const acquired = await acquireConnection(makeCodexDriver(f.options()), "work");
    await startSession(acquired.connection);
    const events = takeEvents(acquired.connection, 2);
    await Effect.runPromise(
      acquired.connection.send({ sessionId, prompt: "Keep going.", attachments: [], tools: [] }),
    );
    f.emit(turnStarted("turn-1"));
    f.emit(compactionItem("item/started", "turn-1"));
    f.emit(compactionItem("item/completed", "turn-1"));
    f.emit(turnCompleted("turn-1", "completed"));
    expect((await events).map((event) => event.kind)).toEqual(["context-compacted", "completed"]);
    expect((await events)[0]).toMatchObject({ trigger: "automatic" });
    await acquired.close();
  });
});
