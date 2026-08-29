import type {
  BrowserAutomationSnapshot,
  CodeOperationCommand,
  CodeOperationResult,
  CodeThread,
  ToolActionAuthority,
  WindowId,
} from "@octant/contracts";
import { describe, expect, it, vi } from "vitest";
import {
  CODE_BROWSER_TOOL_NAME,
  CODE_TERMINAL_TOOL_NAME,
  createCodeAppManagedTools,
} from "./codeAppManagedTools";

const windowId = "10000000-0000-4000-8000-000000000001" as WindowId;
const threadId = "20000000-0000-4000-8000-000000000001";
const checkoutId = "30000000-0000-4000-8000-000000000001";

describe("Code app-managed tools", () => {
  it("runs a command in the stable thread terminal and returns its bounded transcript", async () => {
    let terminalStarted = false;
    let completionMarker = "";
    const executeOperation = vi.fn(
      async (_windowId: WindowId, command: CodeOperationCommand): Promise<CodeOperationResult> =>
        command.kind === "start-terminal" || command.kind === "write-terminal"
          ? ({
              kind: "terminal-state",
              operationId: command.operationId,
              terminalId: command.terminalId,
              state: "running",
            } as never)
          : ({
              kind: "operation-failed",
              operationId: command.operationId,
              failure: { category: "invalid", message: "Unexpected operation." },
            } as never),
    );
    const tools = createCodeAppManagedTools({
      windowId,
      thread: thread(),
      readThread: () => thread(),
      uuid: uuidFactory(),
      executeOperation: async (targetWindowId, command) => {
        const result = await executeOperation(targetWindowId, command);
        if (command.kind === "start-terminal" && result.kind === "terminal-state") {
          terminalStarted = true;
        }
        if (command.kind === "write-terminal") {
          completionMarker = command.data.match(/octant=([^;]+);/)?.[1] ?? "";
        }
        return result;
      },
      terminal: {
        read: async () => {
          if (!terminalStarted) throw new Error("No terminal.");
          return {
            terminalId: threadId,
            status: "running",
            canRerun: false,
            transcript: {
              chunks: [
                `$ pwd\n/private/repo\n${completionMarker === "" ? "" : `\u001b]777;octant=${completionMarker};exit=0\u0007`}`,
              ],
              byteLength: 20,
              truncated: false,
              characters: 0,
            },
          };
        },
      },
      wait: async () => undefined,
    });

    const result = await tools.execute({
      name: CODE_TERMINAL_TOOL_NAME,
      inputJson: JSON.stringify({ operation: "run", command: "pwd" }),
    });

    expect(executeOperation.mock.calls.map(([, command]) => command.kind)).toEqual([
      "start-terminal",
      "write-terminal",
    ]);
    expect(executeOperation).toHaveBeenLastCalledWith(
      windowId,
      expect.objectContaining({
        kind: "write-terminal",
        terminalId: threadId,
        data: expect.stringMatching(/^pwd\rprintf .*octant=.*exit=/),
      }),
    );
    expect(result).toEqual({
      result: {
        status: "running",
        transcript: "$ pwd\n/private/repo\n",
        truncated: false,
        commandCompleted: true,
        commandExitCode: 0,
      },
      isError: false,
    });
  });

  it("waits for a terminal completion marker instead of returning a timed partial transcript", async () => {
    let marker = "";
    let readsAfterWrite = 0;
    const executeOperation = vi.fn(async (_windowId: WindowId, command: CodeOperationCommand) => {
      if (command.kind === "write-terminal") {
        marker = command.data.match(/octant=([^;]+);/)?.[1] ?? "";
      }
      return {
        kind: "terminal-state",
        operationId: command.operationId,
        terminalId: threadId,
        state: "running",
      } as never;
    });
    const tools = createCodeAppManagedTools({
      windowId,
      thread: thread(),
      readThread: () => thread(),
      uuid: uuidFactory(),
      executeOperation,
      terminal: {
        read: async () => {
          if (marker !== "") readsAfterWrite += 1;
          return {
            terminalId: threadId,
            status: "running",
            transcript: {
              chunks: [
                readsAfterWrite < 2
                  ? "working…"
                  : `working…done\n\u001b]777;octant=${marker};exit=7\u0007`,
              ],
              truncated: false,
              characters: 0,
            },
          };
        },
      },
      wait: async () => undefined,
    });

    const result = await tools.execute({
      name: CODE_TERMINAL_TOOL_NAME,
      inputJson: JSON.stringify({ operation: "run", command: "slow-command" }),
    });

    expect(readsAfterWrite).toBe(2);
    expect(result).toMatchObject({
      isError: false,
      result: {
        transcript: "working…done\n",
        commandCompleted: true,
        commandExitCode: 7,
      },
    });
  });

  it("interrupts the shared foreground command when its provider turn is cancelled", async () => {
    const controller = new AbortController();
    let marker = "";
    const executeOperation = vi.fn(async (_windowId: WindowId, command: CodeOperationCommand) => {
      if (command.kind === "write-terminal") {
        marker = command.data.match(/octant=([^;]+);/)?.[1] ?? "";
      }
      return {
        kind: "terminal-state",
        operationId: command.operationId,
        terminalId: threadId,
        state: "running",
      } as never;
    });
    const interrupt = vi.fn(async () => ({
      terminalId: threadId,
      status: "running" as const,
      transcript: {
        chunks: [`interrupted\n\u001b]777;octant=${marker};exit=130\u0007`],
        truncated: false,
        characters: 0,
      },
    }));
    const tools = createCodeAppManagedTools({
      windowId,
      thread: thread(),
      readThread: () => thread(),
      uuid: uuidFactory(),
      executeOperation,
      terminal: {
        interrupt,
        read: async () => ({
          terminalId: threadId,
          status: "running",
          transcript: { chunks: ["still running"], truncated: false, characters: 0 },
        }),
        terminate: vi.fn(),
      },
      wait: async () => {
        controller.abort();
      },
    });

    const result = await tools.execute({
      name: CODE_TERMINAL_TOOL_NAME,
      inputJson: JSON.stringify({ operation: "run", command: "long-command" }),
      signal: controller.signal,
    });

    expect(result).toEqual({ result: { error: "tool-interrupted" }, isError: true });
    expect(interrupt).toHaveBeenCalledWith(
      windowId,
      expect.objectContaining({ terminalId: threadId }),
    );
    expect(executeOperation).toHaveBeenCalledOnce();
  });

  it("interrupts through the owner-scoped cleanup path after Full access is revoked", async () => {
    let current = thread();
    let marker = "";
    const interrupt = vi.fn(async () => ({
      terminalId: threadId,
      status: "running" as const,
      transcript: {
        chunks: [`stopped\n\u001b]777;octant=${marker};exit=130\u0007`],
        truncated: false,
        characters: 0,
      },
    }));
    const executeOperation = vi.fn(async (_windowId: WindowId, command: CodeOperationCommand) => {
      if (command.kind === "write-terminal") {
        marker = command.data.match(/octant=([^;]+);/)?.[1] ?? "";
      }
      return {
        kind: "terminal-state",
        operationId: command.operationId,
        terminalId: threadId,
        state: "running",
      } as never;
    });
    const tools = createCodeAppManagedTools({
      windowId,
      thread: current,
      readThread: () => current,
      uuid: uuidFactory(),
      executeOperation,
      terminal: {
        interrupt,
        read: async () => ({
          terminalId: threadId,
          status: "running",
          transcript: { chunks: ["still running"], truncated: false, characters: 0 },
        }),
        terminate: vi.fn(),
      },
      wait: async () => {
        current = thread({ executionPolicy: "approval-gated" });
      },
    });

    const result = await tools.execute({
      name: CODE_TERMINAL_TOOL_NAME,
      inputJson: JSON.stringify({ operation: "run", command: "long-command" }),
    });

    expect(result).toEqual({ result: { error: "full-access-required" }, isError: true });
    expect(interrupt).toHaveBeenCalledOnce();
    expect(executeOperation).toHaveBeenCalledOnce();
  });

  it("interrupts a command before returning a terminal timeout", async () => {
    let now = 0;
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => now);
    let marker = "";
    const interrupt = vi.fn(async () => ({
      terminalId: threadId,
      status: "running" as const,
      transcript: {
        chunks: [`timed out\n\u001b]777;octant=${marker};exit=130\u0007`],
        truncated: false,
        characters: 0,
      },
    }));
    const tools = createCodeAppManagedTools({
      windowId,
      thread: thread(),
      readThread: () => thread(),
      uuid: uuidFactory(),
      executeOperation: vi.fn(async (_windowId, command) => {
        if (command.kind === "write-terminal") {
          marker = command.data.match(/octant=([^;]+);/)?.[1] ?? "";
        }
        return {
          kind: "terminal-state",
          operationId: command.operationId,
          terminalId: threadId,
          state: "running",
        } as never;
      }),
      terminal: {
        interrupt,
        read: async () => ({
          terminalId: threadId,
          status: "running",
          transcript: { chunks: ["still running"], truncated: false, characters: 0 },
        }),
        terminate: vi.fn(),
      },
      wait: async () => {
        now += 30_001;
      },
    });

    try {
      const result = await tools.execute({
        name: CODE_TERMINAL_TOOL_NAME,
        inputJson: JSON.stringify({ operation: "run", command: "long-command" }),
      });
      expect(result).toMatchObject({
        result: { error: "terminal-command-timeout", commandCompleted: false },
        isError: true,
      });
      expect(interrupt).toHaveBeenCalledOnce();
    } finally {
      nowSpy.mockRestore();
    }
  });

  it("reads an existing terminal without replacing the user-visible output observer", async () => {
    const executeOperation = vi.fn();
    const tools = createCodeAppManagedTools({
      windowId,
      thread: thread(),
      readThread: () => thread(),
      uuid: uuidFactory(),
      executeOperation: executeOperation as never,
      terminal: {
        read: async () => ({
          terminalId: threadId,
          status: "running",
          canRerun: false,
          transcript: {
            chunks: ["shared transcript"],
            byteLength: 17,
            truncated: false,
            characters: 0,
          },
        }),
      },
    });

    const result = await tools.execute({
      name: CODE_TERMINAL_TOOL_NAME,
      inputJson: JSON.stringify({ operation: "read" }),
    });

    expect(result).toMatchObject({ result: { transcript: "shared transcript" }, isError: false });
    expect(executeOperation).not.toHaveBeenCalled();
  });

  it("bounds terminal transcripts by UTF-8 bytes", async () => {
    const tools = createCodeAppManagedTools({
      windowId,
      thread: thread(),
      readThread: () => thread(),
      uuid: uuidFactory(),
      executeOperation: vi.fn(),
      terminal: {
        read: async () => ({
          terminalId: threadId,
          status: "running",
          canRerun: false,
          transcript: { chunks: ["界".repeat(40_000)], truncated: false, characters: 0 },
        }),
      },
    });

    const result = await tools.execute({
      name: CODE_TERMINAL_TOOL_NAME,
      inputJson: JSON.stringify({ operation: "read" }),
    });

    const terminalResult = result.result as { readonly transcript?: unknown };
    expect(Buffer.byteLength(String(terminalResult.transcript), "utf8")).toBeLessThanOrEqual(
      32 * 1024,
    );
    expect(result).toMatchObject({ result: { truncated: true }, isError: false });
    expect(Buffer.byteLength(JSON.stringify(result), "utf8")).toBeLessThan(64 * 1024);
  });

  it("creates and controls the same thread-owned browser context visible to the UI", async () => {
    const authority = browserAuthority();
    const active = browserSnapshot(authority);
    const create = vi.fn(async () => active);
    const act = vi.fn(async ({ request }) => ({
      ...active,
      observation: {
        contextId: active.context!.contextId,
        actionId: active.context!.actionId,
        correlationId: active.context!.correlationId,
        authority,
        url: request.target,
        title: "Example",
        extractedText: "Readable page text",
        contentHash: "a".repeat(64),
        observedAt: "2026-08-06T08:00:00.000Z",
        stale: false,
      },
    })) as never;
    const tools = createCodeAppManagedTools({
      windowId,
      thread: thread(),
      readThread: () => thread(),
      uuid: uuidFactory(),
      executeOperation: vi.fn(),
      terminal: { read: vi.fn() },
      browser: {
        resolveAuthority: () => authority,
        inspectThread: () => ({ status: "ready", threadId: threadId as never, evidence: [] }),
        create,
        act,
        releaseThread: vi.fn(async () => ({
          status: "ready" as const,
          threadId: threadId as never,
          evidence: [],
        })),
      },
    });

    const result = await tools.execute({
      name: CODE_BROWSER_TOOL_NAME,
      inputJson: JSON.stringify({ operation: "navigate", url: "https://example.com/docs" }),
    });

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        windowId,
        threadId,
        policy: expect.objectContaining({
          profileMode: "isolated",
          allowedOrigins: ["https://example.com"],
          credentialFieldProtection: true,
        }),
      }),
    );
    expect(act).toHaveBeenCalledWith(
      expect.objectContaining({
        windowId,
        request: expect.objectContaining({ kind: "navigate", target: "https://example.com/docs" }),
      }),
    );
    expect(result).toMatchObject({
      isError: false,
      result: { status: "running", page: { title: "Example", text: "Readable page text" } },
    });
  });

  it("rechecks effective Full access before every host tool call", async () => {
    let current = thread();
    const act = vi.fn(async () => browserSnapshot(browserAuthority()));
    const tools = createCodeAppManagedTools({
      windowId,
      thread: current,
      readThread: () => current,
      uuid: uuidFactory(),
      executeOperation: vi.fn(),
      terminal: { read: vi.fn() },
      browser: {
        resolveAuthority: () => browserAuthority(),
        inspectThread: () => browserSnapshot(browserAuthority()),
        create: vi.fn(),
        act,
        releaseThread: vi.fn(),
      },
    });
    current = thread({ executionPolicy: "approval-gated" });

    const result = await tools.execute({
      name: CODE_BROWSER_TOOL_NAME,
      inputJson: JSON.stringify({ operation: "read-page" }),
    });

    expect(result).toEqual({ result: { error: "full-access-required" }, isError: true });
    expect(act).not.toHaveBeenCalled();
  });

  it("releases an in-flight browser context when the provider turn is cancelled", async () => {
    let resolveAct!: (snapshot: BrowserAutomationSnapshot) => void;
    const active = browserSnapshot(browserAuthority());
    const releaseThread = vi.fn(async () => ({
      status: "ready" as const,
      threadId: threadId as never,
      evidence: [],
    }));
    const tools = createCodeAppManagedTools({
      windowId,
      thread: thread(),
      readThread: () => thread(),
      uuid: uuidFactory(),
      executeOperation: vi.fn(),
      terminal: { read: vi.fn() },
      browser: {
        resolveAuthority: () => browserAuthority(),
        inspectThread: () => active,
        create: vi.fn(),
        act: vi.fn(
          () =>
            new Promise<BrowserAutomationSnapshot>((resolve) => {
              resolveAct = resolve;
            }),
        ),
        releaseThread,
      },
    });
    const controller = new AbortController();
    const pending = tools.execute({
      name: CODE_BROWSER_TOOL_NAME,
      inputJson: JSON.stringify({ operation: "read-page" }),
      signal: controller.signal,
    });
    await vi.waitFor(() => expect(resolveAct).toBeTypeOf("function"));
    controller.abort();
    resolveAct(active);

    await expect(pending).resolves.toEqual({
      result: { error: "tool-interrupted" },
      isError: true,
    });
    expect(releaseThread).toHaveBeenCalledWith(windowId, threadId);
  });

  it("lets the agent stop its thread-owned Browser context", async () => {
    const releaseThread = vi.fn(async () => ({
      status: "ready" as const,
      threadId: threadId as never,
      evidence: [],
    }));
    const tools = createCodeAppManagedTools({
      windowId,
      thread: thread(),
      readThread: () => thread(),
      uuid: uuidFactory(),
      executeOperation: vi.fn(),
      terminal: { read: vi.fn() },
      browser: {
        resolveAuthority: () => browserAuthority(),
        inspectThread: () => browserSnapshot(browserAuthority()),
        create: vi.fn(),
        act: vi.fn(),
        releaseThread,
      },
    });

    const result = await tools.execute({
      name: CODE_BROWSER_TOOL_NAME,
      inputJson: JSON.stringify({ operation: "stop" }),
    });

    expect(result).toEqual({ result: { status: "ready" }, isError: false });
    expect(releaseThread).toHaveBeenCalledWith(windowId, threadId);
  });

  it("returns a bounded screenshot data URL to an agent that requests one", async () => {
    const authority = browserAuthority();
    const active = browserSnapshot(authority);
    const screenshotDataUrl = `data:image/jpeg;base64,${"A".repeat(52 * 1024)}`;
    const tools = createCodeAppManagedTools({
      windowId,
      thread: thread(),
      readThread: () => thread(),
      uuid: uuidFactory(),
      executeOperation: vi.fn(),
      terminal: { read: vi.fn() },
      browser: {
        resolveAuthority: () => authority,
        inspectThread: () => active,
        create: vi.fn(),
        act: vi.fn(async () => ({
          ...active,
          observation: {
            contextId: active.context!.contextId,
            actionId: active.context!.actionId,
            correlationId: active.context!.correlationId,
            authority,
            screenshotDataUrl,
            observedAt: "2026-08-06T08:00:00.000Z",
            stale: false,
          },
        })) as never,
        releaseThread: vi.fn(),
      },
    });

    const result = await tools.execute({
      name: CODE_BROWSER_TOOL_NAME,
      inputJson: JSON.stringify({ operation: "screenshot" }),
    });

    expect(result).toMatchObject({
      isError: false,
      result: { page: { screenshotDataUrl } },
    });
    expect(Buffer.byteLength(JSON.stringify(result), "utf8")).toBeLessThan(64 * 1024);
  });

  it("fails explicitly when a requested screenshot could not fit the runtime envelope", async () => {
    const authority = browserAuthority();
    const active = browserSnapshot(authority);
    const tools = createCodeAppManagedTools({
      windowId,
      thread: thread(),
      readThread: () => thread(),
      uuid: uuidFactory(),
      executeOperation: vi.fn(),
      terminal: { read: vi.fn() },
      browser: {
        resolveAuthority: () => authority,
        inspectThread: () => active,
        create: vi.fn(),
        act: vi.fn(async () => ({
          ...active,
          observation: {
            contextId: active.context!.contextId,
            actionId: active.context!.actionId,
            correlationId: active.context!.correlationId,
            authority,
            observedAt: "2026-08-06T08:00:00.000Z",
            stale: false,
          },
        })) as never,
        releaseThread: vi.fn(),
      },
    });

    await expect(
      tools.execute({
        name: CODE_BROWSER_TOOL_NAME,
        inputJson: JSON.stringify({ operation: "screenshot" }),
      }),
    ).resolves.toEqual({
      result: { error: "browser-screenshot-unavailable" },
      isError: true,
    });
  });

  it("keeps read-page within one provider envelope when text and a screenshot are present", async () => {
    const authority = browserAuthority();
    const active = browserSnapshot(authority);
    const screenshotDataUrl = `data:image/jpeg;base64,${"A".repeat(52 * 1024)}`;
    const tools = createCodeAppManagedTools({
      windowId,
      thread: thread(),
      readThread: () => thread(),
      uuid: uuidFactory(),
      executeOperation: vi.fn(),
      terminal: { read: vi.fn() },
      browser: {
        resolveAuthority: () => authority,
        inspectThread: () => active,
        create: vi.fn(),
        act: vi.fn(async () => ({
          ...active,
          observation: {
            contextId: active.context!.contextId,
            actionId: active.context!.actionId,
            correlationId: active.context!.correlationId,
            authority,
            extractedText: "Readable page text. ".repeat(1_500),
            screenshotDataUrl,
            observedAt: "2026-08-06T08:00:00.000Z",
            stale: false,
          },
        })) as never,
        releaseThread: vi.fn(),
      },
    });

    const result = await tools.execute({
      name: CODE_BROWSER_TOOL_NAME,
      inputJson: JSON.stringify({ operation: "read-page" }),
    });

    expect(result).toMatchObject({
      isError: false,
      result: { page: { text: expect.any(String) } },
    });
    expect(
      (result.result as { page?: { screenshotDataUrl?: string } }).page?.screenshotDataUrl,
    ).toBe(undefined);
    expect(Buffer.byteLength(JSON.stringify(result), "utf8")).toBeLessThan(64 * 1024);
  });

  it("bounds extracted page text by UTF-8 bytes before the provider answer envelope", async () => {
    const authority = browserAuthority();
    const active = browserSnapshot(authority);
    const tools = createCodeAppManagedTools({
      windowId,
      thread: thread(),
      readThread: () => thread(),
      uuid: uuidFactory(),
      executeOperation: vi.fn(),
      terminal: { read: vi.fn() },
      browser: {
        resolveAuthority: () => authority,
        inspectThread: () => active,
        create: vi.fn(),
        act: vi.fn(async () => ({
          ...active,
          observation: {
            contextId: active.context!.contextId,
            actionId: active.context!.actionId,
            correlationId: active.context!.correlationId,
            authority,
            extractedText: "å".repeat(40_000),
            observedAt: "2026-08-06T08:00:00.000Z",
            stale: false,
          },
        })) as never,
        releaseThread: vi.fn(),
      },
    });

    const result = await tools.execute({
      name: CODE_BROWSER_TOOL_NAME,
      inputJson: JSON.stringify({ operation: "read-page" }),
    });

    expect(Buffer.byteLength(JSON.stringify(result), "utf8")).toBeLessThan(32 * 1024);
    expect(result).toMatchObject({ isError: false, result: { status: "running" } });
  });

  it("fails closed when a Full-access thread is running a narrower turn", async () => {
    const executeOperation = vi.fn();
    const tools = createCodeAppManagedTools({
      windowId,
      thread: thread({ executionPolicy: "plan" }),
      readThread: () => thread({ executionPolicy: "full-access" }),
      uuid: uuidFactory(),
      executeOperation,
      terminal: { read: vi.fn() },
    });

    await expect(
      tools.execute({
        name: CODE_TERMINAL_TOOL_NAME,
        inputJson: JSON.stringify({ operation: "run", command: "pwd" }),
      }),
    ).resolves.toEqual({ result: { error: "full-access-required" }, isError: true });
    expect(executeOperation).not.toHaveBeenCalled();
  });

  it("fails closed outside Full access and never invokes a host tool", async () => {
    const executeOperation = vi.fn();
    const tools = createCodeAppManagedTools({
      windowId,
      thread: thread({ executionPolicy: "approval-gated" }),
      readThread: () => thread({ executionPolicy: "approval-gated" }),
      uuid: uuidFactory(),
      executeOperation,
      terminal: { read: vi.fn() },
    });

    await expect(
      tools.execute({
        name: CODE_TERMINAL_TOOL_NAME,
        inputJson: JSON.stringify({ operation: "run", command: "pwd" }),
      }),
    ).resolves.toEqual({ result: { error: "full-access-required" }, isError: true });
    expect(executeOperation).not.toHaveBeenCalled();
  });

  it("refuses a profile-excluded tool before any host side effect", async () => {
    const executeOperation = vi.fn();
    const tools = createCodeAppManagedTools({
      windowId,
      thread: thread({
        executionPolicy: "full-access",
        profileDisplayName: "Reviewer",
        toolConstraints: ["octant_browser"],
      }),
      readThread: () =>
        thread({
          executionPolicy: "full-access",
          profileDisplayName: "Reviewer",
          toolConstraints: ["octant_browser"],
        }),
      uuid: uuidFactory(),
      executeOperation,
      terminal: { read: vi.fn() },
    });

    await expect(
      tools.execute({
        name: CODE_TERMINAL_TOOL_NAME,
        inputJson: JSON.stringify({ operation: "run", command: "pwd" }),
      }),
    ).resolves.toEqual({
      result: {
        error: "profile-tool-refused",
        message: 'Profile "Reviewer" does not permit "octant_terminal".',
      },
      isError: true,
    });
    expect(executeOperation).not.toHaveBeenCalled();
  });

  it("still runs an ordinary posture-permitted tool when the snapshotted allowlist is empty", async () => {
    const executeOperation = vi.fn(
      async (_windowId: WindowId, command: CodeOperationCommand): Promise<CodeOperationResult> =>
        command.kind === "start-terminal"
          ? ({
              kind: "terminal-state",
              operationId: command.operationId,
              terminalId: command.terminalId,
              state: "running",
            } as never)
          : ({
              kind: "operation-failed",
              operationId: command.operationId,
              failure: { category: "invalid", message: "Unexpected operation." },
            } as never),
    );
    const tools = createCodeAppManagedTools({
      windowId,
      thread: thread({
        executionPolicy: "full-access",
        profileDisplayName: "Reviewer",
        toolConstraints: [],
      }),
      readThread: () =>
        thread({
          executionPolicy: "full-access",
          profileDisplayName: "Reviewer",
          toolConstraints: [],
        }),
      uuid: uuidFactory(),
      executeOperation,
      terminal: {
        read: async () => ({
          terminalId: threadId,
          status: "running",
          canRerun: false,
          transcript: { chunks: [], byteLength: 0, truncated: false, characters: 0 },
        }),
      },
      wait: async () => undefined,
    });

    await tools.execute({
      name: CODE_TERMINAL_TOOL_NAME,
      inputJson: JSON.stringify({ operation: "run", command: "pwd" }),
    });
    expect(executeOperation).toHaveBeenCalled();
  });
});

describe("the Apple capability as an agent tool", () => {
  function appleTools(
    apple: Partial<Parameters<typeof createCodeAppManagedTools>[0]["apple"]> = {},
    threadOverrides: Partial<CodeThread> = {},
  ) {
    const execute = vi.fn(async (..._args: ReadonlyArray<unknown>) => appleEvidence());
    const snapshot = vi.fn(async () => appleSnapshot());
    const discover = vi.fn(async () => appleDiscovery());
    const port = {
      resolveAuthority: () => appleAuthority,
      discover,
      execute,
      snapshot,
      ...apple,
    } as never;
    return {
      discover,
      execute,
      snapshot,
      tools: createCodeAppManagedTools({
        windowId,
        thread: thread(threadOverrides),
        readThread: () => thread(threadOverrides),
        uuid: uuidFactory(),
        executeOperation: async () => ({}) as never,
        terminal: { read: async () => ({}) as never },
        apple: port,
      }),
    };
  }

  it("offers the Apple tool only where the host has an Apple capability to lend", () => {
    expect(appleTools().tools.definitions.map((definition) => definition.name)).toContain(
      "octant_apple",
    );
    expect(
      createCodeAppManagedTools({
        windowId,
        thread: thread(),
        readThread: () => thread(),
        uuid: uuidFactory(),
        executeOperation: async () => ({}) as never,
        terminal: { read: async () => ({}) as never },
      }).definitions.map((definition) => definition.name),
    ).not.toContain("octant_apple");
  });

  it("captures the Simulator screen as a reference, never as bytes in the transcript", async () => {
    const { execute, tools } = appleTools();

    const outcome = await tools.execute({
      name: "octant_apple",
      inputJson: JSON.stringify({
        operation: "screenshot",
        simulatorId: "80000000-0000-4000-8000-000000000001",
      }),
    } as never);

    const request = execute.mock.calls[0]?.[1] as unknown as {
      readonly kind: string;
      readonly approval: { readonly kind: string };
      readonly threadId: string;
      readonly checkoutId: string;
    };
    expect(request.kind).toBe("screenshot");
    expect(request.threadId).toBe(threadId);
    expect(request.checkoutId).toBe(checkoutId);
    // The host decides; the tool never claims an approval of its own.
    expect(request.approval.kind).toBe("not-required");
    expect(outcome.result).toMatchObject({
      outcome: "succeeded",
      artifacts: [{ kind: "screenshot", reference: "apple-screenshot-1" }],
    });
    expect(JSON.stringify(outcome.result)).not.toContain("PNG");
  });

  it("attributes Simulator input to the agent actor on the workbench channel", async () => {
    const { execute, tools } = appleTools();
    await tools.execute({
      name: "octant_apple",
      inputJson: JSON.stringify({
        operation: "tap",
        simulatorId: "80000000-0000-4000-8000-000000000001",
        x: 40,
        y: 80,
      }),
    } as never);
    const request = execute.mock.calls[0]?.[1] as unknown as {
      readonly kind: string;
      readonly requestedBy: { readonly kind: string };
      readonly point: { readonly x: number; readonly y: number };
    };
    expect(request.kind).toBe("tap");
    expect(request.requestedBy.kind).toBe("agent");
    expect(request.point).toEqual({ x: 40, y: 80 });
  });

  it("refuses an action whose destination or project the caller did not name", async () => {
    const { execute, tools } = appleTools();

    expect(
      (
        await tools.execute({
          name: "octant_apple",
          inputJson: JSON.stringify({ operation: "run", projectPath: "App.xcodeproj" }),
        } as never)
      ).isError,
    ).toBe(true);
    expect(
      (
        await tools.execute({
          name: "octant_apple",
          inputJson: JSON.stringify({ operation: "build" }),
        } as never)
      ).isError,
    ).toBe(true);
    expect(execute).not.toHaveBeenCalled();
  });

  it("stays unavailable to a thread that is not on full access", async () => {
    const { execute, snapshot, tools } = appleTools({}, { executionPolicy: "plan" } as never);

    const outcome = await tools.execute({
      name: "octant_apple",
      inputJson: JSON.stringify({ operation: "status" }),
    } as never);

    expect(outcome.isError).toBe(true);
    expect(outcome.result).toMatchObject({ error: "full-access-required" });
    expect(snapshot).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  it("reports a refused action as an error rather than a silent success", async () => {
    const { tools } = appleTools({
      execute: vi.fn(async () => ({
        ...(appleEvidence() as unknown as Record<string, unknown>),
        outcome: "unauthorized",
      })) as never,
    });

    const outcome = await tools.execute({
      name: "octant_apple",
      inputJson: JSON.stringify({
        operation: "boot",
        simulatorId: "80000000-0000-4000-8000-000000000001",
      }),
    } as never);

    expect(outcome.isError).toBe(true);
    expect(outcome.result).toMatchObject({ outcome: "unauthorized" });
  });
});

const appleAuthority: ToolActionAuthority = {
  hostId: "4f70656e-4f72-4269-9474-4c6f63616c31" as never,
  mode: "code",
  projectId: "40000000-0000-4000-8000-000000000001" as never,
  providerInstanceId: "60000000-0000-4000-8000-000000000001" as never,
  extension: { kind: "core" },
};

function appleEvidence() {
  return {
    actionId: "90000000-0000-4000-8000-000000000001",
    correlationId: "90000000-0000-4000-8000-000000000002",
    authority: appleAuthority,
    kind: "screenshot",
    outcome: "succeeded",
    diagnostics: [],
    artifacts: [{ kind: "screenshot", reference: "apple-screenshot-1" }],
    cleanup: "not-required",
    durationMs: 90,
    completedAt: "2026-08-06T08:00:01.000Z",
  } as never;
}

function appleSnapshot() {
  return {
    sequence: 1,
    snapshotAt: "2026-08-06T08:00:01.000Z",
    toolchain: { toolchainId: "a", available: true, sdks: [], discoveredAt: "x" },
    simulators: [],
    active: [],
    recentEvidence: [],
  } as never;
}

function appleDiscovery() {
  return {
    kind: "discovered",
    toolchain: { toolchainId: "a", xcodeVersion: "16.4", available: true, sdks: [] },
    workspace: { schemes: ["App"], configurations: ["Debug"] },
    simulators: [],
  } as never;
}

function thread(overrides: Partial<CodeThread> = {}): CodeThread {
  return {
    id: threadId,
    checkoutId,
    projectId: "40000000-0000-4000-8000-000000000001",
    repositoryId: "50000000-0000-4000-8000-000000000001",
    providerInstanceId: "60000000-0000-4000-8000-000000000001",
    modelId: "test-model",
    bindingRevisionId: "70000000-0000-4000-8000-000000000001",
    lifecycle: "active",
    executionPolicy: "full-access",
    permissionPersistence: "current-session",
    title: "Managed tools",
    workingDirectory: ".",
    deliveryTarget: {
      branchIntent: "feature/tools",
      proposedBaseRepository: "octant/octant",
      proposedBaseBranch: "development",
    },
    version: 1,
    createdAt: "2026-08-06T08:00:00.000Z",
    updatedAt: "2026-08-06T08:00:00.000Z",
    ...overrides,
  } as unknown as CodeThread;
}

function browserAuthority(): ToolActionAuthority {
  return {
    hostId: "80000000-0000-4000-8000-000000000001" as never,
    mode: "code",
    projectId: "40000000-0000-4000-8000-000000000001" as never,
    rootId: "70000000-0000-4000-8000-000000000001" as never,
    worktreeId: checkoutId as never,
    providerInstanceId: "60000000-0000-4000-8000-000000000001" as never,
    extension: { kind: "core" },
  };
}

function browserSnapshot(authority: ToolActionAuthority): BrowserAutomationSnapshot {
  return {
    status: "running",
    threadId: threadId as never,
    context: {
      contextId: "90000000-0000-4000-8000-000000000001" as never,
      threadId: threadId as never,
      actionId: "a0000000-0000-4000-8000-000000000001" as never,
      correlationId: "b0000000-0000-4000-8000-000000000001" as never,
      authority,
      policy: {
        profileMode: "isolated",
        allowedOrigins: ["https://example.com"],
        credentialFieldProtection: true,
        maxConcurrentTabs: 1,
        sessionTimeoutMs: 600_000,
      },
      state: "active",
      createdAt: "2026-08-06T08:00:00.000Z" as never,
    },
    evidence: [],
  };
}

function uuidFactory() {
  let index = 1;
  return () => `c0000000-0000-4000-8000-${String(index++).padStart(12, "0")}`;
}
