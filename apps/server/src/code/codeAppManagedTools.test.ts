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
  CODE_BOARD_TOOL_NAME,
  CODE_BROWSER_TOOL_NAME,
  CODE_PROPOSE_THREAD_TOOL_NAME,
  CODE_PULL_REQUEST_TOOL_NAME,
  CODE_TERMINAL_TOOL_NAME,
  createCodeAppManagedTools,
} from "./codeAppManagedTools";

const windowId = "10000000-0000-4000-8000-000000000001" as WindowId;
const threadId = "20000000-0000-4000-8000-000000000001";
const checkoutId = "30000000-0000-4000-8000-000000000001";
const simulatorId = "80000000-0000-4000-8000-000000000001";

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

  it("journals taint for a successful terminal result before the next model turn", async () => {
    let terminalStarted = false;
    let completionMarker = "";
    const record = vi.fn(() => ({
      kind: "recorded" as const,
      taint: { externalContentIngested: true, ingestedSources: ["octant_terminal"] },
    }));
    const tools = createCodeAppManagedTools({
      windowId,
      thread: thread(),
      readThread: () => thread(),
      uuid: uuidFactory(),
      recordExternalContentIngestion: record,
      executeOperation: async (_windowId, command) => {
        if (command.kind === "start-terminal") {
          terminalStarted = true;
          return {
            kind: "terminal-state",
            operationId: command.operationId,
            terminalId: command.terminalId,
            state: "running",
          } as never;
        }
        if (command.kind === "write-terminal") {
          completionMarker = command.data.match(/octant=([^;]+);/)?.[1] ?? "";
          return {
            kind: "terminal-state",
            operationId: command.operationId,
            terminalId: command.terminalId,
            state: "running",
          } as never;
        }
        return {
          kind: "operation-failed",
          operationId: command.operationId,
          failure: { category: "invalid", message: "Unexpected operation." },
        } as never;
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

    const outcome = await tools.execute({
      name: CODE_TERMINAL_TOOL_NAME,
      inputJson: JSON.stringify({ operation: "run", command: "pwd" }),
    });

    expect(outcome.isError).toBe(false);
    expect(record).toHaveBeenCalledTimes(1);
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({
        threadId,
        provenance: { origin: "tool-result", sourceLabel: CODE_TERMINAL_TOOL_NAME },
        authorized: true,
      }),
    );
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

  it("interrupts through the owner-scoped cleanup path after the thread moves to Plan", async () => {
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
        current = thread({ executionPolicy: "plan" });
      },
    });

    const result = await tools.execute({
      name: CODE_TERMINAL_TOOL_NAME,
      inputJson: JSON.stringify({ operation: "run", command: "long-command" }),
    });

    expect(result).toEqual({
      result: {
        error: "plan-mode-read-only",
        message: "Plan mode is read-only; this tool cannot run.",
      },
      isError: true,
    });
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
    expect(JSON.stringify(result.result)).not.toContain("data:image");
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
        revision: 7,
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
      result: {
        status: "running",
        page: { title: "Example", text: "Readable page text", observationRevision: 7 },
      },
    });
  });

  it("asks for browser-session approval without raising the thread access posture", async () => {
    const approve = vi.fn(async () => "approved" as const);
    const remember = vi.fn();
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
      thread: thread({ executionPolicy: "approval-gated" }),
      readThread: () => thread({ executionPolicy: "approval-gated" }),
      uuid: uuidFactory(),
      executeOperation: vi.fn(),
      terminal: { read: vi.fn() },
      browserApproval: { isApproved: () => false, request: approve, remember, forget: vi.fn() },
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

    expect(approve).toHaveBeenCalledWith("https://example.com", undefined);
    expect(remember).toHaveBeenCalledWith(active.context?.contextId);
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

  it("opens a remembered browser origin in a new context without asking again", async () => {
    const approve = vi.fn(async () => "approved" as const);
    const remember = vi.fn();
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
      thread: thread({ executionPolicy: "approval-gated" }),
      readThread: () => thread({ executionPolicy: "approval-gated" }),
      uuid: uuidFactory(),
      executeOperation: vi.fn(),
      terminal: { read: vi.fn() },
      browserApproval: {
        isApproved: () => false,
        isOriginRemembered: () => true,
        request: approve,
        remember,
        forget: vi.fn(),
      },
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

    expect(approve).not.toHaveBeenCalled();
    expect(remember).toHaveBeenCalledWith(active.context?.contextId);
    expect(create).toHaveBeenCalledOnce();
    expect(result).toMatchObject({
      isError: false,
      result: { status: "running", page: { title: "Example", text: "Readable page text" } },
    });
  });

  it("passes a requested read selector to the browser without changing its authority", async () => {
    const current = thread();
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
    const result = await tools.execute({
      name: CODE_BROWSER_TOOL_NAME,
      inputJson: JSON.stringify({ operation: "read-page", selector: "h1" }),
    });
    expect(result.isError).toBe(false);
    expect(act).toHaveBeenCalledWith(
      expect.objectContaining({
        request: expect.objectContaining({
          kind: "extract-text",
          target: "h1",
          authority: browserAuthority(),
        }),
      }),
    );
  });

  it("refuses browser actions after the thread switches to Plan", async () => {
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
    current = thread({ executionPolicy: "plan" });

    const result = await tools.execute({
      name: CODE_BROWSER_TOOL_NAME,
      inputJson: JSON.stringify({ operation: "read-page" }),
    });

    expect(result).toEqual({ result: { error: "plan-mode-read-only" }, isError: true });
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

  it("lets the agent submit a form and scroll in either direction in its own browser", async () => {
    const active = browserSnapshot(browserAuthority());
    const act = vi.fn(async () => active);
    const tools = createCodeAppManagedTools({
      windowId,
      thread: thread(),
      readThread: () => thread(),
      uuid: uuidFactory(),
      executeOperation: vi.fn(),
      terminal: { read: vi.fn() },
      browser: {
        resolveAuthority: browserAuthority,
        inspectThread: () => active,
        create: vi.fn(),
        act,
        releaseThread: vi.fn(),
      },
    });
    expect(
      tools.definitions.find((tool) => tool.name === CODE_BROWSER_TOOL_NAME)?.description,
    ).toContain("built-in browser");
    const pressed = await tools.execute({
      name: CODE_BROWSER_TOOL_NAME,
      inputJson: JSON.stringify({
        operation: "press",
        key: "Enter",
        expectedObservationRevision: 7,
      }),
    });
    expect(pressed.isError).toBe(false);
    expect(act).toHaveBeenLastCalledWith({
      windowId,
      capturedBy: "agent",
      refuseStaleRevision: true,
      request: expect.objectContaining({
        kind: "press",
        value: "Enter",
        expectedObservationRevision: 7,
      }),
    });
    await tools.execute({
      name: CODE_BROWSER_TOOL_NAME,
      inputJson: JSON.stringify({ operation: "scroll", deltaX: 100, deltaY: -500 }),
    });
    expect(act).toHaveBeenLastCalledWith({
      windowId,
      capturedBy: "agent",
      refuseStaleRevision: true,
      request: expect.objectContaining({ kind: "scroll", deltaX: 100, deltaY: -500 }),
    });
    act.mockClear();
    const invalid = await tools.execute({
      name: CODE_BROWSER_TOOL_NAME,
      inputJson: JSON.stringify({ operation: "scroll", deltaY: 2001 }),
    });
    expect(invalid.isError).toBe(true);
    expect(act).not.toHaveBeenCalled();
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

  it("returns a bounded image block to an agent that requests a screenshot", async () => {
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
      images: [{ mimeType: "image/jpeg", data: "A".repeat(52 * 1024) }],
      result: { page: {} },
    });
    expect(JSON.stringify(result.result)).not.toContain("data:image");
    expect(Buffer.byteLength(JSON.stringify(result), "utf8")).toBeLessThan(64 * 1024);
  });

  it.each([
    ["kept", { status: "kept", captureId: "6f1c2f0e-8a58-4c53-9a1b-3a4f0f6f7a10" }],
    ["not kept", { status: "not-kept", reason: "unavailable" }],
  ] as const)("reports a %s capture of the screenshot to the agent", async (_name, capture) => {
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
            screenshotDataUrl: "data:image/png;base64,aGVsbG8=",
            capture,
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

    const page = (result.result as { page: Record<string, unknown> }).page;
    if (capture.status === "kept") {
      expect(page.captureId).toBe(capture.captureId);
      expect(page.captureNotKept).toBeUndefined();
    } else {
      expect(page.captureId).toBeUndefined();
      expect(page.captureNotKept).toBe("unavailable");
    }
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
    expect(JSON.stringify(result.result)).not.toContain("data:image");
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

  it("fails closed when a Full-access thread is running a Plan turn", async () => {
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
    ).resolves.toEqual({
      result: {
        error: "plan-mode-read-only",
        message: "Plan mode is read-only; this tool cannot run.",
      },
      isError: true,
    });
    expect(executeOperation).not.toHaveBeenCalled();
  });

  it("asks the person before each command below Full access and runs nothing they decline", async () => {
    const executeOperation = vi.fn(async (_windowId: WindowId, command: CodeOperationCommand) => ({
      kind: "terminal-state",
      operationId: command.operationId,
      terminalId: threadId,
      state: "running",
    }));
    const request = vi.fn(async () => "denied" as const);
    const tools = createCodeAppManagedTools({
      windowId,
      thread: thread({ executionPolicy: "approval-gated" }),
      readThread: () => thread({ executionPolicy: "approval-gated" }),
      uuid: uuidFactory(),
      executeOperation: executeOperation as never,
      terminal: { read: vi.fn() },
      terminalApproval: { request },
    });

    await expect(
      tools.execute({
        name: CODE_TERMINAL_TOOL_NAME,
        inputJson: JSON.stringify({ operation: "run", command: "pwd" }),
      }),
    ).resolves.toMatchObject({ result: { error: "terminal-approval-denied" }, isError: true });
    // The person saw the command, and the start it needs rode the same ask.
    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({
        text: "pwd",
        start: expect.objectContaining({ kind: "start-terminal" }),
      }),
      undefined,
    );
    expect(executeOperation).not.toHaveBeenCalled();

    request.mockResolvedValueOnce("approved" as never);
    await tools.execute({
      name: CODE_TERMINAL_TOOL_NAME,
      inputJson: JSON.stringify({ operation: "run", command: "pwd" }),
    });
    expect(executeOperation.mock.calls.map((call) => call[1].kind)).toContain("start-terminal");
  });

  it("refuses the agent terminal below Full access on a host that cannot ask", async () => {
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
    ).resolves.toMatchObject({ result: { error: "terminal-approval-required" }, isError: true });
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
    deviceApproval?: Parameters<typeof createCodeAppManagedTools>[0]["deviceApproval"],
  ) {
    const execute = vi.fn(async (..._args: ReadonlyArray<unknown>) => appleEvidence());
    const snapshot = vi.fn(async () => appleSnapshot());
    const discover = vi.fn(async () => appleDiscovery());
    const requestPaneOpen = vi.fn(async () => appleSnapshot());
    const port = {
      resolveAuthority: () => appleAuthority,
      discover,
      execute,
      snapshot,
      requestPaneOpen,
      inputGrantIsOpen: () => false,
      ...apple,
    } as never;
    return {
      discover,
      execute,
      snapshot,
      requestPaneOpen,
      tools: createCodeAppManagedTools({
        windowId,
        thread: thread(threadOverrides),
        readThread: () => thread(threadOverrides),
        uuid: uuidFactory(),
        executeOperation: async () => ({}) as never,
        terminal: { read: async () => ({}) as never },
        apple: port,
        ...(deviceApproval === undefined ? {} : { deviceApproval }),
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

  it("returns an explicitly requested Simulator screenshot through the provider image channel", async () => {
    const bytes = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);
    const readScreenshot = vi.fn(async () => bytes);
    const { execute, tools } = appleTools({ readScreenshot });

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
    expect(outcome.images).toEqual([
      { mimeType: "image/png", data: Buffer.from(bytes).toString("base64") },
    ]);
    expect(readScreenshot).toHaveBeenCalledWith(
      windowId,
      expect.objectContaining({ threadId, checkoutId }),
      "apple-screenshot-1",
    );
  });

  it.each([
    ["missing", undefined],
    ["invalid", Uint8Array.from([1, 2, 3])],
    ["oversized", new Uint8Array(1_572_865)],
  ])("reports %s screenshot images as unavailable", async (_name, bytes) => {
    const { tools } = appleTools({ readScreenshot: async () => bytes });
    const outcome = await tools.execute({
      name: "octant_apple",
      inputJson: JSON.stringify({
        operation: "screenshot",
        simulatorId: "80000000-0000-4000-8000-000000000001",
      }),
    });
    expect(outcome.isError).toBe(true);
    expect(outcome.images).toBeUndefined();
    expect(outcome.result).toMatchObject({ error: "screenshot-image-unavailable" });
  });

  it("does not send a screen when a device action returns screenshot evidence", async () => {
    const readScreenshot = vi.fn(async () => new Uint8Array());
    const { tools } = appleTools({ readScreenshot });
    const outcome = await tools.execute({
      name: "octant_apple",
      inputJson: JSON.stringify({
        operation: "tap",
        simulatorId: "80000000-0000-4000-8000-000000000001",
        x: 1,
        y: 2,
      }),
    });
    expect(readScreenshot).not.toHaveBeenCalled();
    expect(outcome.images).toBeUndefined();
  });

  it("does not deliver a screenshot after the turn is cancelled during its read", async () => {
    const controller = new AbortController();
    const { tools } = appleTools({
      readScreenshot: async () => {
        controller.abort();
        return Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);
      },
    });
    const outcome = await tools.execute({
      name: "octant_apple",
      signal: controller.signal,
      inputJson: JSON.stringify({
        operation: "screenshot",
        simulatorId: "80000000-0000-4000-8000-000000000001",
      }),
    });
    expect(outcome.isError).toBe(true);
    expect(outcome.images).toBeUndefined();
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

  it("sends an agent's swipe with both ends, and refuses one that names only where it starts", async () => {
    const { execute, tools } = appleTools();
    const simulatorId = "80000000-0000-4000-8000-000000000001";

    await tools.execute({
      name: "octant_apple",
      inputJson: JSON.stringify({
        operation: "swipe",
        simulatorId,
        x: 600,
        y: 2000,
        toX: 600,
        toY: 800,
        durationMs: 300,
      }),
    } as never);
    const oneEnded = await tools.execute({
      name: "octant_apple",
      inputJson: JSON.stringify({ operation: "swipe", simulatorId, x: 600, y: 2000 }),
    } as never);

    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls[0]?.[1]).toMatchObject({
      kind: "swipe",
      requestedBy: { kind: "agent" },
      point: { x: 600, y: 2000 },
      toPoint: { x: 600, y: 800 },
      durationMs: 300,
    });
    expect(oneEnded.isError).toBe(true);

    // A pace outside what the channel carries is the caller's mistake, and is
    // said so here rather than surfacing later as an unreachable desktop.
    for (const durationMs of [10, 6_000, Number.NaN]) {
      const refused = await tools.execute({
        name: "octant_apple",
        inputJson: JSON.stringify({
          operation: "swipe",
          simulatorId,
          x: 600,
          y: 2000,
          toX: 600,
          toY: 800,
          durationMs,
        }),
      } as never);
      expect(refused.isError).toBe(true);
    }
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("refuses a swipe or tap whose coordinate is no place on a screen", async () => {
    const { execute, tools } = appleTools();
    const simulatorId = "80000000-0000-4000-8000-000000000001";

    // JSON reads 1e400 as Infinity, which is a number and is not a place.
    const swipe = await tools.execute({
      name: "octant_apple",
      inputJson: `{"operation":"swipe","simulatorId":"${simulatorId}","x":600,"y":2000,"toX":1e400,"toY":800}`,
    } as never);
    const tap = await tools.execute({
      name: "octant_apple",
      inputJson: `{"operation":"tap","simulatorId":"${simulatorId}","x":-1e400,"y":80}`,
    } as never);

    // A point left of or above the screen is no place either.
    const negative = await tools.execute({
      name: "octant_apple",
      inputJson: JSON.stringify({ operation: "tap", simulatorId, x: -1, y: 80 }),
    } as never);

    expect(swipe.isError).toBe(true);
    expect(tap.isError).toBe(true);
    expect(negative.isError).toBe(true);
    expect(execute).not.toHaveBeenCalled();
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

  it("lets an approval-gated thread take a Simulator screenshot without asking", async () => {
    const request = vi.fn();
    const readScreenshot = vi.fn(async () => Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]));
    const { execute, tools } = appleTools(
      { readScreenshot },
      { executionPolicy: "approval-gated" } as never,
      { request },
    );

    const outcome = await tools.execute({
      name: "octant_apple",
      inputJson: JSON.stringify({ operation: "screenshot", simulatorId }),
    });

    expect(outcome.isError).toBe(false);
    expect(outcome.images).toHaveLength(1);
    expect(request).not.toHaveBeenCalled();
    expect(execute.mock.calls[0]?.[1]).toMatchObject({
      kind: "screenshot",
      approval: { kind: "not-required" },
    });
  });

  it("holds an approval-gated boot until the person answers, and refuses it when they deny", async () => {
    let answer: (outcome: { readonly status: "denied" }) => void = () => undefined;
    const request = vi.fn(
      (_effect: unknown) =>
        new Promise<{ readonly status: "denied" }>((resolve) => {
          answer = resolve;
        }),
    );
    const { execute, requestPaneOpen, tools } = appleTools(
      {},
      { executionPolicy: "approval-gated" } as never,
      { request },
    );

    const pending = tools.execute({
      name: "octant_apple",
      inputJson: JSON.stringify({ operation: "boot", simulatorId }),
    });
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1));
    expect(request.mock.calls[0]?.[0]).toMatchObject({
      kind: "apple-action",
      request: { kind: "boot", simulatorId, threadId, checkoutId },
    });
    expect(execute).not.toHaveBeenCalled();
    expect(requestPaneOpen).not.toHaveBeenCalled();

    answer({ status: "denied" });
    const outcome = await pending;

    expect(outcome).toMatchObject({ isError: true, result: { error: "device-approval-denied" } });
    expect(execute).not.toHaveBeenCalled();
    expect(requestPaneOpen).not.toHaveBeenCalled();
  });

  it("boots an approval-gated thread's Simulator with the one-use approval the person gave", async () => {
    const approvalId = "d0000000-0000-4000-8000-000000000001";
    const request = vi.fn(async () => ({
      status: "approved" as const,
      approvalId: approvalId as never,
    }));
    const { execute, tools } = appleTools({}, { executionPolicy: "approval-gated" } as never, {
      request,
    });

    await tools.execute({
      name: "octant_apple",
      inputJson: JSON.stringify({ operation: "boot", simulatorId }),
    });

    const asked = (request.mock.calls[0] as unknown as [{ readonly request: object }])[0].request;
    // The host receives the very request the person allowed, now carrying it.
    expect(execute.mock.calls[0]?.[1]).toEqual({
      ...asked,
      approval: { kind: "approved", approvalId },
    });
  });

  it("sends an approval-gated agent's tap on a live Allow input grant without asking again", async () => {
    const request = vi.fn();
    const inputGrantIsOpen = vi.fn(() => true);
    const { execute, tools } = appleTools(
      { inputGrantIsOpen },
      { executionPolicy: "approval-gated" } as never,
      { request },
    );

    await tools.execute({
      name: "octant_apple",
      inputJson: JSON.stringify({ operation: "tap", simulatorId, x: 10, y: 20 }),
    });

    expect(request).not.toHaveBeenCalled();
    expect(inputGrantIsOpen).toHaveBeenCalledWith(windowId, threadId, simulatorId);
    expect(execute.mock.calls[0]?.[1]).toMatchObject({
      kind: "tap",
      approval: { kind: "not-required" },
    });
  });

  it.each(["plan", "approval-gated"] as const)(
    "shows an already-booted Simulator's pane under %s without asking, since nothing on the device changes",
    async (executionPolicy) => {
      const request = vi.fn();
      const snapshot = vi.fn(async () => ({
        ...(appleSnapshot() as unknown as Record<string, unknown>),
        simulators: [{ simulatorId, name: "iPhone", platform: "ios", state: "booted" }],
      }));
      const { execute, requestPaneOpen, tools } = appleTools(
        { snapshot } as never,
        { executionPolicy } as never,
        { request },
      );

      const opened = await tools.execute({
        name: "octant_apple",
        inputJson: JSON.stringify({ operation: "open", simulatorId }),
      });

      expect(opened).toMatchObject({ isError: false, result: { opensInAppPane: true } });
      expect(requestPaneOpen).toHaveBeenCalledOnce();
      expect(request).not.toHaveBeenCalled();
      expect(execute).not.toHaveBeenCalled();
    },
  );

  it("refuses a boot in Plan mode while still reading the Simulator's status", async () => {
    const request = vi.fn();
    const { execute, requestPaneOpen, tools } = appleTools(
      {
        snapshot: vi.fn(async () => ({
          ...(appleSnapshot() as unknown as Record<string, unknown>),
          simulators: [{ simulatorId, name: "iPhone", platform: "ios", state: "shutdown" }],
        })) as never,
      },
      { executionPolicy: "plan" } as never,
      { request },
    );

    const booted = await tools.execute({
      name: "octant_apple",
      inputJson: JSON.stringify({ operation: "boot", simulatorId }),
    });
    const opened = await tools.execute({
      name: "octant_apple",
      inputJson: JSON.stringify({ operation: "open", simulatorId }),
    });
    const status = await tools.execute({
      name: "octant_apple",
      inputJson: JSON.stringify({ operation: "status" }),
    });

    expect(booted.result).toMatchObject({ error: "plan-mode-read-only" });
    // Opening a shut-down Simulator would boot it.
    expect(opened.result).toMatchObject({ error: "plan-mode-read-only" });
    expect(status.isError).toBe(false);
    expect(request).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
    expect(requestPaneOpen).not.toHaveBeenCalled();
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

  it("opens the in-app Simulator pane instead of launching Apple's Simulator application", async () => {
    const simulatorId = "80000000-0000-4000-8000-000000000001";
    const snapshot = vi.fn(async () => ({
      ...(appleSnapshot() as Record<string, unknown>),
      simulators: [
        {
          simulatorId,
          name: "iPhone 16",
          platform: "ios",
          runtimeVersion: "18.5",
          state: "booted",
        },
      ],
    }));
    const requestPaneOpen = vi.fn(async () => snapshot());
    const { execute, tools } = appleTools({ snapshot, requestPaneOpen } as never);

    const opened = await tools.execute({
      name: "octant_apple",
      inputJson: JSON.stringify({ operation: "open", simulatorId }),
    } as never);
    const booted = await tools.execute({
      name: "octant_apple",
      inputJson: JSON.stringify({ operation: "boot", simulatorId }),
    } as never);

    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls[0]?.[1]).toMatchObject({ kind: "boot" });
    expect(requestPaneOpen).toHaveBeenCalled();
    expect(opened.isError).toBe(false);
    expect(opened.result).toMatchObject({
      kind: "open",
      outcome: "succeeded",
      opensInAppPane: true,
    });
    expect(JSON.stringify(opened.result)).toContain("iOS Simulator pane");
    expect(JSON.stringify(opened.result)).toContain("Do not launch Simulator.app");
    expect(booted.result).toMatchObject({ opensInAppPane: true });
  });

  it("boots a shut-down Simulator when opening the in-app pane, and still does not launch Simulator.app", async () => {
    const simulatorId = "80000000-0000-4000-8000-000000000001";
    const snapshot = vi.fn(async () => ({
      ...(appleSnapshot() as Record<string, unknown>),
      simulators: [
        {
          simulatorId,
          name: "iPhone 16",
          platform: "ios",
          runtimeVersion: "18.5",
          state: "shutdown",
        },
      ],
    }));
    const requestPaneOpen = vi.fn(async () => snapshot());
    const execute = vi.fn(async (..._args: ReadonlyArray<unknown>) => ({
      ...(appleEvidence() as unknown as Record<string, unknown>),
      kind: "boot",
      outcome: "succeeded",
    }));
    const { tools } = appleTools({ snapshot, requestPaneOpen, execute } as never);

    const outcome = await tools.execute({
      name: "octant_apple",
      inputJson: JSON.stringify({ operation: "open", simulatorId }),
    } as never);

    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls[0]?.[1]).toMatchObject({ kind: "boot", simulatorId });
    expect(requestPaneOpen).toHaveBeenCalled();
    expect(outcome.isError).toBe(false);
    expect(outcome.result).toMatchObject({
      kind: "boot",
      outcome: "succeeded",
      opensInAppPane: true,
    });
  });

  it("names the in-app pane in the tool description so an agent does not launch Simulator.app", () => {
    const definition = appleTools().tools.definitions.find(
      (entry) => entry.name === "octant_apple",
    );
    expect(definition?.description).toContain("iOS Simulator pane");
    expect(definition?.description).toContain("never launch Simulator.app");
    expect(definition?.inputSchema).toEqual(
      expect.objectContaining({
        properties: expect.objectContaining({
          operation: expect.objectContaining({
            enum: expect.arrayContaining(["open", "boot", "run"]),
          }),
        }),
      }),
    );
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

describe("the Android capability as an agent tool", () => {
  function androidTools(
    android: Partial<Parameters<typeof createCodeAppManagedTools>[0]["android"]> = {},
    threadOverrides: Partial<CodeThread> = {},
    deviceApproval?: Parameters<typeof createCodeAppManagedTools>[0]["deviceApproval"],
  ) {
    const execute = vi.fn(async (..._args: ReadonlyArray<unknown>) => androidEvidence());
    const snapshot = vi.fn(async () => androidSnapshot());
    const discover = vi.fn(async () => androidDiscovery());
    const requestPaneOpen = vi.fn(async () => androidSnapshot());
    const port = {
      resolveAuthority: () => appleAuthority,
      discover,
      execute,
      snapshot,
      requestPaneOpen,
      inputGrantIsOpen: () => false,
      ...android,
    } as never;
    return {
      discover,
      execute,
      snapshot,
      requestPaneOpen,
      tools: createCodeAppManagedTools({
        windowId,
        thread: thread(threadOverrides),
        readThread: () => thread(threadOverrides),
        uuid: uuidFactory(),
        executeOperation: async () => ({}) as never,
        terminal: { read: async () => ({}) as never },
        android: port,
        ...(deviceApproval === undefined ? {} : { deviceApproval }),
      }),
    };
  }

  it("delivers an explicitly requested Android screenshot through the image channel", async () => {
    const bytes = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);
    const readScreenshot = vi.fn(async () => bytes);
    const { tools } = androidTools({ readScreenshot });
    const outcome = await tools.execute({
      name: "octant_android",
      inputJson: JSON.stringify({
        operation: "screenshot",
        emulatorId: "Pixel_Test",
      }),
    });
    expect(outcome.images).toEqual([
      { mimeType: "image/png", data: Buffer.from(bytes).toString("base64") },
    ]);
    expect(readScreenshot).toHaveBeenCalledWith(
      windowId,
      expect.objectContaining({ threadId, checkoutId }),
      "android-screenshot-1",
    );
  });

  it("offers the Android tool only where the host has an Android capability to lend", () => {
    expect(androidTools().tools.definitions.map((definition) => definition.name)).toContain(
      "octant_android",
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
    ).not.toContain("octant_android");
  });

  it("refuses a boot in Plan mode while still reading the emulator's status", async () => {
    const { execute, snapshot, tools } = androidTools({}, { executionPolicy: "plan" } as never);
    const booted = await tools.execute({
      name: "octant_android",
      inputJson: JSON.stringify({ operation: "boot", emulatorId: "Pixel_Test" }),
    });
    const status = await tools.execute({
      name: "octant_android",
      inputJson: JSON.stringify({ operation: "status" }),
    });
    expect(booted.result).toMatchObject({ error: "plan-mode-read-only" });
    expect(status.isError).toBe(false);
    expect(snapshot).toHaveBeenCalledTimes(1);
    expect(execute).not.toHaveBeenCalled();
  });

  it("holds an approval-gated emulator boot for the person and refuses it when they deny", async () => {
    const request = vi.fn(async (_effect: unknown) => ({ status: "denied" as const }));
    const { execute, tools } = androidTools({}, { executionPolicy: "approval-gated" } as never, {
      request,
    });
    const outcome = await tools.execute({
      name: "octant_android",
      inputJson: JSON.stringify({ operation: "boot", emulatorId: "Pixel_Test" }),
    });
    expect(request.mock.calls[0]?.[0]).toMatchObject({
      kind: "android-action",
      request: { kind: "boot", emulatorId: "Pixel_Test" },
    });
    expect(outcome.result).toMatchObject({ error: "device-approval-denied" });
    expect(execute).not.toHaveBeenCalled();
  });

  it("opens the in-app Android emulator pane instead of an external emulator window", async () => {
    const emulatorId = "Pixel_8_API_34";
    const snapshot = vi.fn(async () => ({
      ...(androidSnapshot() as unknown as Record<string, unknown>),
      emulators: [{ emulatorId, name: "Pixel 8", state: "booted" }],
    }));
    const requestPaneOpen = vi.fn(async () => snapshot());
    const { execute, tools } = androidTools({ snapshot, requestPaneOpen } as never);
    const opened = await tools.execute({
      name: "octant_android",
      inputJson: JSON.stringify({ operation: "open", emulatorId }),
    } as never);
    const booted = await tools.execute({
      name: "octant_android",
      inputJson: JSON.stringify({ operation: "boot", emulatorId }),
    } as never);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls[0]?.[1]).toMatchObject({ kind: "boot" });
    expect(requestPaneOpen).toHaveBeenCalled();
    expect(opened.isError).toBe(false);
    expect(opened.result).toMatchObject({
      kind: "open",
      outcome: "succeeded",
      opensInAppPane: true,
    });
    expect(JSON.stringify(opened.result)).toContain("Android emulator pane");
    expect(JSON.stringify(booted.result)).toContain("Do not start an external emulator window");
  });

  it("names the in-app pane in the tool description", () => {
    const definition = androidTools().tools.definitions.find(
      (entry) => entry.name === "octant_android",
    );
    expect(definition?.description).toContain("Android emulator pane");
    expect(definition?.description).toContain("never start an external emulator window");
  });
});

function androidEvidence() {
  return {
    actionId: "90000000-0000-4000-8000-000000000001",
    correlationId: "90000000-0000-4000-8000-000000000002",
    authority: appleAuthority,
    kind: "screenshot",
    outcome: "succeeded",
    diagnostics: [],
    artifacts: [{ kind: "screenshot", reference: "android-screenshot-1" }],
    cleanup: "not-required",
    durationMs: 90,
    completedAt: "2026-08-06T08:00:01.000Z",
  } as never;
}

function androidSnapshot() {
  return {
    sequence: 1,
    snapshotAt: "2026-08-06T08:00:01.000Z",
    sdk: { sdkId: "a", available: true, discoveredAt: "x" },
    emulators: [],
    active: [],
    recentEvidence: [],
  } as never;
}

function androidDiscovery() {
  return {
    kind: "discovered",
    sdk: { sdkId: "a", available: true, discoveredAt: "x" },
    emulators: [],
  } as never;
}

describe("the planner board and proposal as agent tools", () => {
  function plannerTools(
    planner: NonNullable<Parameters<typeof createCodeAppManagedTools>[0]["planner"]>,
    overrides: Partial<CodeThread> = {},
  ) {
    return createCodeAppManagedTools({
      windowId,
      thread: thread(overrides),
      readThread: () => thread(overrides),
      uuid: uuidFactory(),
      executeOperation: async () => {
        throw new Error("The planner tools must not reach the operation runtime.");
      },
      terminal: {
        read: async () => {
          throw new Error("The planner tools must not read the terminal.");
        },
      },
      planner,
    });
  }

  function boardCard(index: number): Record<string, unknown> {
    return {
      threadId: `90000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
      title: `Card ${String(index)}`,
      status: "ready",
      statusReason: "idle",
      outcomeKind: "opened-pr",
      deliverySatisfaction: "pending",
      executing: false,
      changedFiles: { kind: "none" },
      linkedPullRequest: { kind: "none" },
      checks: { state: "unknown" },
      reviewState: { state: "none" },
      childAgents: { active: 0 },
      planProgress: { kind: "none" },
      followUp: false,
      lastMeaningfulActivityAt: null,
    };
  }

  function boardView(cardCount: number) {
    return {
      version: 1,
      query: { version: 1 },
      cards: Array.from({ length: cardCount }, (_unused, index) => boardCard(index)),
      generatedAt: "2026-08-29T12:00:00.000Z",
    } as never;
  }

  it("offers the planner tools only in the designated planner thread", () => {
    const port = {
      isPlannerThread: (id: CodeThread["id"]) => String(id) === threadId,
      board: async () => ({ status: "ok" as const, board: boardView(0) }),
      propose: async () => ({
        status: "refused" as const,
        reason: "no-planner-designated",
        message: "No planner.",
      }),
    };
    const designated = plannerTools(port);
    expect(designated.definitions.map((definition) => definition.name)).toContain(
      CODE_BOARD_TOOL_NAME,
    );
    const undesignated = createCodeAppManagedTools({
      windowId,
      thread: thread(),
      readThread: () => thread(),
      uuid: uuidFactory(),
      executeOperation: async () => ({ kind: "operation-failed" }) as never,
      terminal: { read: async () => ({ status: "exited" }) as never },
      planner: { ...port, isPlannerThread: () => false },
    });
    expect(undesignated.definitions.map((definition) => definition.name)).not.toContain(
      CODE_BOARD_TOOL_NAME,
    );
    expect(undesignated.definitions.map((definition) => definition.name)).not.toContain(
      CODE_PROPOSE_THREAD_TOOL_NAME,
    );
  });

  it("refuses the board tool from a thread that is not the Project's planner", async () => {
    const tools = plannerTools({
      isPlannerThread: () => false,
      board: async () => ({
        status: "refused",
        reason: "not-the-planner-thread",
        message: "Only the Project's designated planner thread may read the board.",
      }),
      propose: async () => {
        throw new Error("unused");
      },
    });
    const result = await tools.execute({
      name: CODE_BOARD_TOOL_NAME,
      inputJson: JSON.stringify({ operation: "read" }),
    });
    expect(result).toEqual({
      result: {
        error: "not-the-planner-thread",
        message: "Only the Project's designated planner thread may read the board.",
      },
      isError: true,
    });
  });

  it("reads the Project board for the planner even under an approval-gated posture", async () => {
    const tools = plannerTools(
      {
        isPlannerThread: () => true,
        board: async () => ({ status: "ok", board: boardView(2) }),
        propose: async () => {
          throw new Error("unused");
        },
      },
      { executionPolicy: "approval-gated" as never },
    );
    const result = await tools.execute({
      name: CODE_BOARD_TOOL_NAME,
      inputJson: JSON.stringify({ operation: "read" }),
    });
    expect(result.isError).toBe(false);
    expect((result.result as { cards: unknown[] }).cards).toHaveLength(2);
  });

  it("bounds the cards a single board read hands the provider", async () => {
    const tools = plannerTools({
      isPlannerThread: () => true,
      board: async () => ({ status: "ok", board: boardView(150) }),
      propose: async () => {
        throw new Error("unused");
      },
    });
    const result = await tools.execute({
      name: CODE_BOARD_TOOL_NAME,
      inputJson: JSON.stringify({ operation: "read" }),
    });
    const payload = result.result as { cards: unknown[]; truncated?: boolean };
    expect(payload.cards).toHaveLength(100);
    expect(payload.truncated).toBe(true);
  });

  it("keeps a proposal advisory: the tool result names a pending proposal, not a thread", async () => {
    const tools = plannerTools({
      isPlannerThread: () => true,
      board: async () => {
        throw new Error("unused");
      },
      propose: async (_windowId, _threadId, draft) => ({
        status: "proposed",
        proposal: {
          id: "a0000000-0000-4000-8000-000000000001",
          title: draft.title,
          status: "pending",
        } as never,
      }),
    });
    const result = await tools.execute({
      name: CODE_PROPOSE_THREAD_TOOL_NAME,
      inputJson: JSON.stringify({ title: "Fix the flake", intent: "Find and fix the root cause." }),
    });
    expect(result.isError).toBe(false);
    expect(result.result).toMatchObject({
      status: "pending-user-confirmation",
      proposalId: "a0000000-0000-4000-8000-000000000001",
    });
  });
  it("passes what the page logged and failed to load through to the Code tool result", async () => {
    // The same conversion as the browser app-managed tools, reached through a
    // separate code path. Dropping the fields here fails nothing downstream:
    // the agent still gets a valid observation, just without the evidence, so
    // the assertion is on the provider-facing result rather than the call.
    const authority = browserAuthority();
    const active = browserSnapshot(authority);
    const act = vi.fn(async () => ({
      ...active,
      observation: {
        contextId: active.context!.contextId,
        actionId: active.context!.actionId,
        correlationId: active.context!.correlationId,
        authority,
        url: "https://example.com/driven",
        observedAt: "2026-08-06T08:00:00.000Z",
        revision: 11,
        stale: false,
        consoleErrors: [{ text: "Uncaught TypeError", url: "https://example.com/app.js" }],
        failedRequests: [
          { url: "https://example.com/api", method: "POST", failure: "net::ERR_FAILED" },
        ],
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
        inspectThread: () => active,
        create: vi.fn(async () => active),
        act,
        releaseThread: vi.fn(async () => active),
      },
    });

    const result = await tools.execute({
      name: CODE_BROWSER_TOOL_NAME,
      inputJson: JSON.stringify({ operation: "diagnostics" }),
    });

    expect(result).toMatchObject({
      isError: false,
      result: {
        page: {
          consoleErrors: [{ text: "Uncaught TypeError", url: "https://example.com/app.js" }],
          failedRequests: [
            { url: "https://example.com/api", method: "POST", failure: "net::ERR_FAILED" },
          ],
        },
      },
    });
  });
});

describe("Code tool families", () => {
  function familyTools(threadOverrides: Partial<CodeThread> = {}) {
    const ports = {
      executeOperation: vi.fn(async () => ({}) as never),
      terminalRead: vi.fn(async () => ({}) as never),
      browserAct: vi.fn(async () => browserSnapshot(browserAuthority())),
      browserCreate: vi.fn(async () => browserSnapshot(browserAuthority())),
      appleExecute: vi.fn(async () => appleEvidence()),
      appleDiscover: vi.fn(async () => appleDiscovery()),
      androidExecute: vi.fn(async () => androidEvidence()),
      androidDiscover: vi.fn(async () => androidDiscovery()),
    };
    const device = (execute: unknown, discover: unknown, snapshot: unknown) =>
      ({
        resolveAuthority: () => appleAuthority,
        discover,
        execute,
        snapshot: async () => snapshot,
        requestPaneOpen: async () => snapshot,
        inputGrantIsOpen: () => false,
      }) as never;
    const tools = createCodeAppManagedTools({
      windowId,
      thread: thread(threadOverrides),
      readThread: () => thread(threadOverrides),
      uuid: uuidFactory(),
      executeOperation: ports.executeOperation,
      terminal: { read: ports.terminalRead },
      browser: {
        resolveAuthority: () => browserAuthority(),
        inspectThread: () => browserSnapshot(browserAuthority()),
        create: ports.browserCreate,
        act: ports.browserAct,
        releaseThread: vi.fn(),
      },
      apple: device(ports.appleExecute, ports.appleDiscover, appleSnapshot()),
      android: device(ports.androidExecute, ports.androidDiscover, androidSnapshot()),
    });
    return { tools, ports };
  }

  it("keeps the always-visible Code tool prefix smaller than the catalogue it replaced", () => {
    const { tools } = familyTools();
    const families = tools.definitions.filter((definition) =>
      ["octant_browser", "octant_terminal", "octant_apple", "octant_android"].includes(
        definition.name,
      ),
    );
    expect(families).toHaveLength(4);
    // These four definitions serialized to 6,580 bytes before their detailed
    // usage moved behind help. The budget catches a description growing back.
    // A paired device as an Apple destination added its own operations and
    // parameters (about 250 bytes of schema); its usage lives behind help.
    // The upload, submit-for-review, and release-version operations added
    // their names to the enum; their usage is in help too. The Browser's
    // snapshot operation and its ref argument added about 35 bytes after the
    // description was shortened to pay for most of them. Its include
    // argument, which lets an action return a snapshot, text, or picture in
    // the same answer, added about 85 bytes; its usage is in help.
    // Hover, select, drag, upload, and the four tab operations added their
    // names and five short arguments (about 305 bytes); their usage is in help.
    // The steps operation and its list argument added about 70 bytes.
    expect(JSON.stringify(families).length).toBeLessThanOrEqual(5_170);
  });

  it.each(["octant_browser", "octant_terminal", "octant_apple", "octant_android"])(
    "returns %s's full usage from help without touching the host",
    async (name) => {
      const { tools, ports } = familyTools({ executionPolicy: "plan" });
      const definition = tools.definitions.find((candidate) => candidate.name === name);
      if (definition === undefined) throw new Error(`Expected ${name} to be offered.`);
      const operations = (
        definition.inputSchema as { properties: { operation: { enum: ReadonlyArray<string> } } }
      ).properties.operation.enum;
      expect(operations).toContain("help");

      const outcome = await tools.execute({ name, inputJson: '{"operation":"help"}' });

      expect(outcome.isError).toBe(false);
      const help = (outcome.result as { help: string }).help;
      expect(help.length).toBeGreaterThan(definition.description?.length ?? 0);
      for (const port of Object.values(ports)) expect(port).not.toHaveBeenCalled();
    },
  );

  it("still refuses an effect under a denied posture after help answered", async () => {
    const { tools, ports } = familyTools({ executionPolicy: "plan" });

    await tools.execute({ name: "octant_browser", inputJson: '{"operation":"help"}' });
    const navigated = await tools.execute({
      name: "octant_browser",
      inputJson: JSON.stringify({ operation: "navigate", url: "https://example.com" }),
    });
    const booted = await tools.execute({
      name: "octant_apple",
      inputJson: JSON.stringify({ operation: "boot", simulatorId }),
    });
    const ran = await tools.execute({
      name: CODE_TERMINAL_TOOL_NAME,
      inputJson: JSON.stringify({ operation: "run", command: "ls" }),
    });

    expect(navigated).toEqual({ result: { error: "plan-mode-read-only" }, isError: true });
    expect(booted.result).toMatchObject({ error: "plan-mode-read-only" });
    expect(ran.isError).toBe(true);
    expect(ports.browserCreate).not.toHaveBeenCalled();
    expect(ports.browserAct).not.toHaveBeenCalled();
    expect(ports.appleExecute).not.toHaveBeenCalled();
    expect(ports.executeOperation).not.toHaveBeenCalled();
  });

  it("records no external content when help answers on a tainting thread", async () => {
    const record = vi.fn();
    const tools = createCodeAppManagedTools({
      windowId,
      thread: thread(),
      readThread: () => thread(),
      uuid: uuidFactory(),
      executeOperation: vi.fn(),
      terminal: { read: vi.fn() },
      recordExternalContentIngestion: record,
    });

    const outcome = await tools.execute({
      name: CODE_TERMINAL_TOOL_NAME,
      inputJson: '{"operation":"help"}',
    });

    expect(outcome.isError).toBe(false);
    expect(record).not.toHaveBeenCalled();
  });

  it("omits the browser family when the host lends no browser", async () => {
    const tools = createCodeAppManagedTools({
      windowId,
      thread: thread(),
      readThread: () => thread(),
      uuid: uuidFactory(),
      executeOperation: vi.fn(),
      terminal: { read: vi.fn() },
    });

    expect(tools.definitions.map((definition) => definition.name)).not.toContain(
      CODE_BROWSER_TOOL_NAME,
    );
    const outcome = await tools.execute({
      name: CODE_BROWSER_TOOL_NAME,
      inputJson: '{"operation":"help"}',
    });
    expect(outcome.isError).toBe(true);
  });
});

describe("the pull request as an agent tool", () => {
  const approvalId = "d0000000-0000-4000-8000-000000000001";

  function pullRequestTools(
    threadOverrides: Partial<CodeThread> = {},
    answer: "approved" | "denied" = "approved",
    standingMerge?: () => "project" | "routine" | undefined,
  ) {
    const request = vi.fn(async () =>
      answer === "approved"
        ? ({ status: "approved", approvalId } as never)
        : ({ status: "denied" } as const),
    );
    const executeOperation = vi.fn(
      async (_windowId: WindowId, command: CodeOperationCommand): Promise<CodeOperationResult> =>
        ({
          kind: "pull-request-state",
          operationId: command.operationId,
          state: command.kind === "create-pull-request" ? "created" : "existing",
          number: 42,
          url: "https://github.com/octant/octant/pull/42",
          headRepository: "octant",
          headBranch: "feature/tools",
          baseRepository: "octant/octant",
          baseBranch:
            command.kind === "create-pull-request"
              ? (command.baseBranch ?? "development")
              : "development",
          ...("draft" in command && command.draft !== undefined ? { draft: command.draft } : {}),
        }) as never,
    );
    const tools = createCodeAppManagedTools({
      windowId,
      thread: thread(threadOverrides),
      readThread: () => thread(threadOverrides),
      uuid: uuidFactory(),
      executeOperation,
      terminal: { read: async () => ({}) as never },
      pullRequestApproval: { request },
      ...(standingMerge === undefined ? {} : { standingMerge }),
    });
    return { tools, request, executeOperation };
  }

  it("opens a stacked draft in a Full-access thread without asking", async () => {
    const { tools, request, executeOperation } = pullRequestTools();

    const result = await tools.execute({
      name: CODE_PULL_REQUEST_TOOL_NAME,
      inputJson: JSON.stringify({
        operation: "create",
        title: "Add the parser",
        body: "Second layer.",
        draft: true,
        base: "feature/lexer",
      }),
    });

    expect(request).not.toHaveBeenCalled();
    expect(executeOperation).toHaveBeenCalledWith(
      windowId,
      expect.objectContaining({
        kind: "create-pull-request",
        threadId,
        checkoutId,
        title: "Add the parser",
        body: "Second layer.",
        draft: true,
        baseBranch: "feature/lexer",
        authorization: { kind: "full-access" },
      }),
    );
    expect(result).toEqual({
      result: {
        status: "created",
        number: 42,
        url: "https://github.com/octant/octant/pull/42",
        baseBranch: "feature/lexer",
        headBranch: "feature/tools",
        draft: true,
      },
      isError: false,
    });
  });

  it("asks the person in an approval-gated thread and sends their one-use approval", async () => {
    const { tools, request, executeOperation } = pullRequestTools({
      executionPolicy: "approval-gated",
    });

    const result = await tools.execute({
      name: CODE_PULL_REQUEST_TOOL_NAME,
      inputJson: JSON.stringify({ operation: "update", draft: false }),
    });

    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "update-pull-request", draft: false }),
      undefined,
    );
    expect(executeOperation).toHaveBeenCalledWith(
      windowId,
      expect.objectContaining({
        kind: "update-pull-request",
        draft: false,
        authorization: { kind: "approved", approvalId },
      }),
    );
    expect(result).toMatchObject({ result: { status: "updated", draft: false }, isError: false });
  });

  it("asks for each comment and each merge even in a Full-access thread, but not for a label", async () => {
    const { tools, request, executeOperation } = pullRequestTools();

    await tools.execute({
      name: CODE_PULL_REQUEST_TOOL_NAME,
      inputJson: JSON.stringify({ operation: "update", addLabels: ["bug"] }),
    });
    expect(request).not.toHaveBeenCalled();
    expect(executeOperation).toHaveBeenLastCalledWith(
      windowId,
      expect.objectContaining({
        kind: "update-pull-request",
        addLabels: ["bug"],
        authorization: { kind: "full-access" },
      }),
    );

    const commented = await tools.execute({
      name: CODE_PULL_REQUEST_TOOL_NAME,
      inputJson: JSON.stringify({ operation: "comment", body: "Fixed.", reviewThreadId: "PRRT_1" }),
    });
    expect(request).toHaveBeenLastCalledWith(
      expect.objectContaining({ kind: "comment-pull-request", body: "Fixed." }),
      undefined,
    );
    expect(executeOperation).toHaveBeenLastCalledWith(
      windowId,
      expect.objectContaining({
        kind: "comment-pull-request",
        reviewThreadId: "PRRT_1",
        authorization: { kind: "approved", approvalId },
      }),
    );
    expect(commented).toMatchObject({ result: { status: "commented" }, isError: false });

    const merged = await tools.execute({
      name: CODE_PULL_REQUEST_TOOL_NAME,
      inputJson: JSON.stringify({ operation: "merge", method: "squash", headSha: "a".repeat(40) }),
    });
    expect(request).toHaveBeenCalledTimes(2);
    expect(executeOperation).toHaveBeenLastCalledWith(
      windowId,
      expect.objectContaining({
        kind: "merge-pull-request",
        method: "squash",
        authorization: { kind: "approved", approvalId },
      }),
    );
    expect(merged).toMatchObject({ result: { status: "merged" }, isError: false });
  });

  it("merges without asking when a stored choice allows it, but still asks for a comment", async () => {
    const { tools, request, executeOperation } = pullRequestTools({}, "approved", () => "project");
    const merged = await tools.execute({
      name: CODE_PULL_REQUEST_TOOL_NAME,
      inputJson: JSON.stringify({ operation: "merge", method: "squash", headSha: "a".repeat(40) }),
    });
    expect(request).not.toHaveBeenCalled();
    expect(executeOperation).toHaveBeenLastCalledWith(
      windowId,
      expect.objectContaining({
        kind: "merge-pull-request",
        authorization: { kind: "standing", allowedBy: "project" },
      }),
    );
    expect(merged).toMatchObject({ result: { status: "merged" }, isError: false });

    await tools.execute({
      name: CODE_PULL_REQUEST_TOOL_NAME,
      inputJson: JSON.stringify({ operation: "comment", body: "Fixed." }),
    });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("sends nothing to GitHub when the person declines a merge or a comment", async () => {
    const { tools, executeOperation } = pullRequestTools({}, "denied");
    for (const input of [
      { operation: "comment", body: "Hello." },
      { operation: "merge", method: "merge", headSha: "a".repeat(40) },
    ]) {
      const result = await tools.execute({
        name: CODE_PULL_REQUEST_TOOL_NAME,
        inputJson: JSON.stringify(input),
      });
      expect(result).toMatchObject({
        result: { error: "pull-request-approval-denied" },
        isError: true,
      });
    }
    expect(executeOperation).not.toHaveBeenCalled();
  });

  it("rejects malformed label, close, comment, and merge input before anything runs", async () => {
    const { tools, request, executeOperation } = pullRequestTools();
    for (const input of [
      { operation: "update", state: "closed", title: "also rename" },
      { operation: "update", state: "deleted" },
      { operation: "update", addLabels: [3] },
      { operation: "update", addLabels: [] },
      { operation: "comment" },
      { operation: "comment", body: "   " },
      { operation: "merge", method: "fast-forward", headSha: "a" },
      { operation: "merge", method: "merge" },
      { operation: "create", title: "x", addLabels: ["bug"] },
    ]) {
      const result = await tools.execute({
        name: CODE_PULL_REQUEST_TOOL_NAME,
        inputJson: JSON.stringify(input),
      });
      expect(result).toMatchObject({ isError: true });
    }
    expect(request).not.toHaveBeenCalled();
    expect(executeOperation).not.toHaveBeenCalled();
  });

  it("refuses a comment or merge in Plan mode", async () => {
    const { tools, request, executeOperation } = pullRequestTools({ executionPolicy: "plan" });
    const result = await tools.execute({
      name: CODE_PULL_REQUEST_TOOL_NAME,
      inputJson: JSON.stringify({ operation: "comment", body: "Hello." }),
    });
    expect(result).toMatchObject({ result: { error: "plan-mode-read-only" }, isError: true });
    expect(request).not.toHaveBeenCalled();
    expect(executeOperation).not.toHaveBeenCalled();
  });

  it("reaches GitHub with nothing when the person declines", async () => {
    const { tools, executeOperation } = pullRequestTools(
      { executionPolicy: "approval-gated" },
      "denied",
    );

    const result = await tools.execute({
      name: CODE_PULL_REQUEST_TOOL_NAME,
      inputJson: JSON.stringify({ operation: "create", title: "Add the parser" }),
    });

    expect(executeOperation).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      result: { error: "pull-request-approval-denied" },
      isError: true,
    });
  });

  it("refuses in Plan mode without asking", async () => {
    const { tools, request, executeOperation } = pullRequestTools({ executionPolicy: "plan" });

    const result = await tools.execute({
      name: CODE_PULL_REQUEST_TOOL_NAME,
      inputJson: JSON.stringify({ operation: "create", title: "Add the parser" }),
    });

    expect(request).not.toHaveBeenCalled();
    expect(executeOperation).not.toHaveBeenCalled();
    expect(result).toMatchObject({ result: { error: "plan-mode-read-only" }, isError: true });
  });

  it("refuses to name a head, so only the thread's own branch can get a pull request", async () => {
    const { tools, executeOperation } = pullRequestTools();

    const result = await tools.execute({
      name: CODE_PULL_REQUEST_TOOL_NAME,
      inputJson: JSON.stringify({ operation: "create", title: "Other", head: "someone-else" }),
    });

    expect(executeOperation).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      result: { error: "invalid-pull-request-input" },
      isError: true,
    });
  });
});

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
