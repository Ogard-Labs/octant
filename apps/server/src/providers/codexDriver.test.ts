import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  decodeProviderInstanceId,
  decodeProviderSessionId,
  type ProviderExecutionPolicy,
  type ProviderRuntimeEvent,
} from "@octant/contracts";
import { Effect, Exit, Scope, Stream } from "effect";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import {
  makeCodexProcessLive,
  type CodexAppServerConnection,
  type CodexProcessPort,
} from "./codexProcess";
import { CodexRpcClientFailure } from "./codexRpcClient";
import type { CodexServerMessage } from "./codexProtocol";
import type { CodexAccountReadResult, CodexThreadResult } from "./codexProtocol";
import {
  codexExecutionSettings,
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
}

function fixture(
  input: {
    readonly account?: CodexAccountReadResult;
    readonly modelPages?: ReadonlyArray<{
      readonly data: ReadonlyArray<ReturnType<typeof model>>;
      readonly nextCursor: string | null;
    }>;
    readonly threadResume?: (input: CodexThreadResumeInput) => Promise<CodexThreadResult>;
    readonly threadStart?: (input: CodexThreadStartInput) => Promise<CodexThreadResult>;
    readonly respondApproval?: (input: unknown) => Promise<void>;
    readonly turnStart?: () => Promise<{
      readonly turn: { readonly id: string; readonly status: "inProgress" };
    }>;
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
    modelList: async (cursor) => {
      calls.push({ method: "model/list", input: cursor });
      return pages[Math.min(page++, pages.length - 1)]!;
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
    turnInterrupt: async (value) => {
      calls.push({ method: "turn/interrupt", input: value });
    },
    respondApproval: async (value) => {
      calls.push({ method: "approval/respond", input: value });
      await input.respondApproval?.(value);
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
  const processPort: CodexProcessPort = {
    start: () =>
      Effect.acquireRelease(
        Effect.sync(() => {
          starts += 1;
          const exited = new Promise<void>((resolve) => {
            resolveExit = resolve;
          });
          return {
            version: "0.144.4",
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
      ...overrides,
    }),
  };
}

async function acquireConnection(driver: ReturnType<typeof makeCodexDriver>) {
  const scope = await Effect.runPromise(Scope.make());
  const connection = await Effect.runPromise(
    driver.acquire({ instanceId, projectRoot }).pipe(Effect.provideService(Scope.Scope, scope)),
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

async function takeEvents(
  connection: Awaited<ReturnType<typeof acquireConnection>>["connection"],
  count: number,
): Promise<ReadonlyArray<ProviderRuntimeEvent>> {
  return Effect.runPromise(Stream.runCollect(connection.events.pipe(Stream.take(count)))).then(
    (chunk) => [...chunk],
  );
}

afterEach(() => {
  vi.useRealTimers();
});

afterAll(() => {
  for (const root of processDirectories.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("Codex driver probe and runtime lifecycle", () => {
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

  it("shares one concurrent runtime per instance, isolates instances, and idles for 30 seconds", async () => {
    vi.useFakeTimers();
    const registry = new ProviderRuntimeRegistry();
    const f = fixture();
    const driver = makeCodexDriver(f.options({ runtimeRegistry: registry }));
    const firstScope = await Effect.runPromise(Scope.make());
    const secondScope = await Effect.runPromise(Scope.make());
    await Promise.all([
      Effect.runPromise(
        driver
          .acquire({ instanceId, projectRoot })
          .pipe(Effect.provideService(Scope.Scope, firstScope)),
      ),
      Effect.runPromise(
        driver
          .acquire({ instanceId, projectRoot })
          .pipe(Effect.provideService(Scope.Scope, secondScope)),
      ),
    ]);
    expect(f.startCount()).toBe(1);
    await Promise.all([
      Effect.runPromise(Scope.close(firstScope, Exit.void)),
      Effect.runPromise(Scope.close(secondScope, Exit.void)),
    ]);
    await vi.advanceTimersByTimeAsync(29_999);
    expect(f.closeCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(f.closeCount()).toBe(1);

    const second = fixture();
    await Effect.runPromise(
      Effect.scoped(
        makeCodexDriver(
          second.options({ instanceId: otherInstanceId, runtimeRegistry: registry }),
        ).acquire({ instanceId: otherInstanceId, projectRoot }),
      ),
    );
    expect(second.startCount()).toBe(1);
  });
});

describe("Codex thread and turn lifecycle", () => {
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
    // The server records the last probe as the instance's observed state; the
    // driver validates option values against that declared catalog.
    registry.setObservedState(await Effect.runPromise(Effect.scoped(driver.probe({ instanceId }))));
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
      approvalPolicy: "on-request",
      sandbox: "workspace-write",
      serviceTier: "fast",
      config: { model_reasoning_effort: "low" },
    });
    expect(starts[1]?.input).toEqual({
      cwd: projectRoot,
      model: "gpt-5.4",
      approvalPolicy: "on-request",
      sandbox: "workspace-write",
    });
    await acquired.close();
  });

  it("starts a thread with root/model/policy, subscribes before a text turn, and interrupts exact IDs", async () => {
    const f = fixture();
    const acquired = await acquireConnection(makeCodexDriver(f.options()));
    const handle = await startSession(acquired.connection);
    expect(handle.resumeCursor).toEqual({ driverKind: "codex", value: "thread-1" });
    expect(f.calls.find(({ method }) => method === "thread/start")?.input).toMatchObject({
      cwd: projectRoot,
      model: "gpt-5.4",
      approvalPolicy: "on-request",
      sandbox: "workspace-write",
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
      "subscribe",
      "thread/start",
      "turn/start",
    ]);
    expect(f.calls.at(-1)?.input).toEqual({
      threadId: "thread-1",
      input: [{ type: "text", text: "Explain the repository." }],
    });
    await Effect.runPromise(acquired.connection.interrupt(sessionId));
    expect(f.calls.at(-1)).toEqual({
      method: "turn/interrupt",
      input: { threadId: "thread-1", turnId: "turn-1" },
    });
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
    });
    await acquired.close();
  });

  it("stops by unsubscribing and releasing local state without provider history mutation", async () => {
    const f = fixture();
    const acquired = await acquireConnection(makeCodexDriver(f.options()));
    await startSession(acquired.connection);
    await Effect.runPromise(acquired.connection.stop(sessionId));
    expect(f.calls.map(({ method }) => method)).toEqual([
      "subscribe",
      "thread/start",
      "unsubscribe",
    ]);
    expect(f.calls.some(({ method }) => /archive|delete/.test(method))).toBe(false);
    await acquired.close();
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
          executionPolicy: "plan",
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
      const terminal = Effect.runPromise(Stream.runCollect(first.connection.events)).then(
        (events) => [...events],
      );
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
    });
    expect(codexExecutionSettings("approval-gated")).toEqual({
      approvalPolicy: "on-request",
      sandbox: "workspace-write",
    });
    expect(codexExecutionSettings("plan")).toEqual({
      approvalPolicy: "never",
      sandbox: "read-only",
    });
  });

  it.each([
    ["full-access", "never", "danger-full-access"],
    ["approval-gated", "on-request", "workspace-write"],
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
      await Effect.runPromise(
        acquired.connection.answerApproval({ sessionId, requestId: "request-1", approved: false }),
      );
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
      Effect.runPromise(Stream.runCollect(acquired.connection.events)).then((chunk) => [...chunk]),
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
