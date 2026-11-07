import { browserAgentAvailability } from "@octant/domain";
import type { BrowserProfileChoice } from "@octant/contracts/project-browser";
import { describe, expect, it, vi } from "vitest";
import {
  decodeToolActionAuthority,
  type BrowserAutomationSnapshot,
  type ToolActionAuthority,
} from "@octant/contracts";
import { createBrowserAppManagedTools, type BrowserModelBinding } from "./browserAppManagedTools";
import { BROWSER_TOOL_DEFINITION } from "./browserToolDefinition";
import { BrowserFlowRecorder, browserToolInputRecord, flowDecision } from "./browserFlows";
import {
  BROWSER_OPERATION_EFFECT,
  parseBrowserToolInput,
  runBrowserToolSteps,
} from "./browserToolOperations";
import { BROWSER_CALL_OF_EACH_OPERATION } from "./browserToolPlanCalls.test-support";

const windowId = "10000000-0000-4000-8000-000000000001" as never;
const threadId = "20000000-0000-4000-8000-000000000001" as never;
const modelId = "model-a";
const authority = {
  hostId: "30000000-0000-4000-8000-000000000001",
  mode: "chat",
  providerInstanceId: "40000000-0000-4000-8000-000000000001",
  extension: { kind: "core" },
} as unknown as ToolActionAuthority;

function snapshot(overrides: Partial<BrowserAutomationSnapshot> = {}): BrowserAutomationSnapshot {
  return { status: "ready", threadId, evidence: [], ...overrides } as BrowserAutomationSnapshot;
}

describe("createBrowserAppManagedTools", () => {
  it.each([[], ["octant_browser"], ["octant_terminal"]])(
    "offers Browser exactly when its reported constraints admit it: %j",
    (...toolConstraints) => {
      const tools = createBrowserAppManagedTools({
        windowId,
        threadId,
        mode: "work",
        modelId,
        resolveModelId: () => modelId,
        modelBindings: new Map(),
        executionPolicy: "approval-gated",
        toolConstraints,
        resolveAuthority: () => authority,
        browser: {
          inspectThread: () => snapshot(),
          create: vi.fn(),
          act: vi.fn(),
          releaseThread: vi.fn(),
        },
        uuid: () => "80000000-0000-4000-8000-000000000001",
      });
      const reported = browserAgentAvailability({
        toolTransport: true,
        hostLendsBrowser: true,
        toolConstraints,
        readOnly: false,
      });
      expect(tools.definitions.some((definition) => definition.name === "octant_browser")).toBe(
        reported.status === "available",
      );
    },
  );
  it("offers Chat browser on demand and keeps approval separate from filesystem tools", async () => {
    const create = vi.fn(async () =>
      snapshot({
        status: "running",
        context: {
          contextId: "50000000-0000-4000-8000-000000000001" as never,
          threadId,
          actionId: "60000000-0000-4000-8000-000000000001" as never,
          correlationId: "70000000-0000-4000-8000-000000000001" as never,
          authority,
          policy: {
            profileMode: "isolated",
            allowedOrigins: ["https://example.com"],
            credentialFieldProtection: true,
            maxConcurrentTabs: 8,
            sessionTimeoutMs: 600_000,
          },
          state: "active",
          createdAt: "2026-09-09T10:00:00.000Z" as never,
        },
      }),
    );
    const act = vi.fn(async () =>
      snapshot({ status: "running", observation: { revision: 7 } as never }),
    );
    const approval = vi.fn(async () => "approved" as const);
    const tools = createBrowserAppManagedTools({
      windowId,
      threadId,
      mode: "chat",
      modelId,
      resolveModelId: () => modelId,
      modelBindings: new Map(),
      executionPolicy: "approval-gated",
      resolveAuthority: () => authority,
      browser: {
        inspectThread: () => snapshot(),
        create,
        act,
        releaseThread: vi.fn(async () => snapshot()),
      },
      approvals: { request: approval } as never,
      uuid: () => "80000000-0000-4000-8000-000000000001",
    });
    expect(tools.definitions.map((definition) => definition.name)).toEqual(["octant_browser"]);
    const result = await tools.execute({
      name: "octant_browser",
      inputJson: JSON.stringify({ operation: "navigate", url: "https://example.com/path" }),
    });
    expect(result).toMatchObject({
      isError: false,
      result: { page: { observationRevision: 7 } },
    });
    expect(approval).toHaveBeenCalledWith(
      expect.objectContaining({ origin: "https://example.com" }),
    );
    expect(create).toHaveBeenCalledOnce();
  });

  it("opens a remembered origin in a new context without asking again", async () => {
    const create = vi.fn(async () =>
      snapshot({
        status: "running",
        context: {
          contextId: "50000000-0000-4000-8000-000000000001" as never,
          threadId,
          actionId: "60000000-0000-4000-8000-000000000001" as never,
          correlationId: "70000000-0000-4000-8000-000000000001" as never,
          authority,
          policy: {
            profileMode: "isolated",
            allowedOrigins: ["https://example.com"],
            credentialFieldProtection: true,
            maxConcurrentTabs: 8,
            sessionTimeoutMs: 600_000,
          },
          state: "active",
          createdAt: "2026-09-09T10:00:00.000Z" as never,
        },
      }),
    );
    const act = vi.fn(async () =>
      snapshot({ status: "running", observation: { revision: 7 } as never }),
    );
    const approval = vi.fn(async () => "approved" as const);
    const tools = createBrowserAppManagedTools({
      windowId,
      threadId,
      mode: "chat",
      modelId,
      resolveModelId: () => modelId,
      modelBindings: new Map(),
      executionPolicy: "approval-gated",
      resolveAuthority: () => authority,
      browser: {
        inspectThread: () => snapshot(),
        create,
        act,
        releaseThread: vi.fn(async () => snapshot()),
      },
      approvals: { request: approval, isRemembered: () => true } as never,
      uuid: () => "80000000-0000-4000-8000-000000000001",
    });
    const result = await tools.execute({
      name: "octant_browser",
      inputJson: JSON.stringify({ operation: "navigate", url: "https://example.com/path" }),
    });
    expect(result).toMatchObject({
      isError: false,
      result: { page: { observationRevision: 7 } },
    });
    expect(approval).not.toHaveBeenCalled();
    expect(create).toHaveBeenCalledOnce();
  });

  it("keeps the active context's approved model binding across turn tool sets", async () => {
    const contextId = "50000000-0000-4000-8000-000000000009";
    const modelBindings = new Map<string, BrowserModelBinding>([
      [contextId, { modelId, authority }],
    ]);
    const approval = vi.fn(async () => "approved" as const);
    const observed = snapshot({
      context: {
        contextId,
        threadId,
        authority,
        state: "active",
        policy: {
          profileMode: "isolated",
          allowedOrigins: ["https://example.com"],
          credentialFieldProtection: true,
          maxConcurrentTabs: 8,
          sessionTimeoutMs: 600_000,
        },
      } as never,
    });
    const act = vi.fn(async () => observed);
    const make = () =>
      createBrowserAppManagedTools({
        windowId,
        threadId,
        mode: "chat",
        modelId,
        resolveModelId: () => modelId,
        modelBindings,
        executionPolicy: "approval-gated",
        resolveAuthority: () => authority,
        browser: {
          inspectThread: () => observed,
          create: vi.fn(async () => snapshot()),
          act,
          releaseThread: vi.fn(async () => snapshot()),
        },
        approvals: { request: approval } as never,
        uuid: () => crypto.randomUUID(),
      });
    for (const tools of [make(), make()]) {
      expect(
        await tools.execute({ name: "octant_browser", inputJson: '{"operation":"read-page"}' }),
      ).toMatchObject({ isError: false });
    }
    expect(act).toHaveBeenCalledTimes(2);
    expect(approval).not.toHaveBeenCalled();
  });

  it("does not start a context when approval is unavailable or Chat is in Plan", async () => {
    const create = vi.fn(async () => snapshot());
    const make = (executionPolicy: "approval-gated" | "plan" = "approval-gated") =>
      createBrowserAppManagedTools({
        windowId,
        threadId,
        mode: "chat",
        modelId,
        resolveModelId: () => modelId,
        modelBindings: new Map(),
        executionPolicy,
        resolveAuthority: () => authority,
        browser: {
          inspectThread: () => snapshot(),
          create,
          act: vi.fn(async () => snapshot()),
          releaseThread: vi.fn(async () => snapshot()),
        },
        uuid: crypto.randomUUID,
      });
    const missing = await make().execute({
      name: "octant_browser",
      inputJson: JSON.stringify({ operation: "navigate", url: "https://example.com" }),
    });
    expect(missing.result).toEqual({ error: "browser-approval-required" });
    const planned = await make("plan").execute({
      name: "octant_browser",
      inputJson: JSON.stringify({ operation: "navigate", url: "https://example.com" }),
    });
    expect(planned.result).toEqual({ error: "plan-mode-read-only" });
    expect(create).not.toHaveBeenCalled();

    const restricted = createBrowserAppManagedTools({
      windowId,
      threadId,
      mode: "chat",
      modelId,
      resolveModelId: () => modelId,
      modelBindings: new Map(),
      executionPolicy: "approval-gated",
      toolConstraints: ["web-search"],
      resolveAuthority: () => authority,
      browser: {
        inspectThread: () => snapshot(),
        create,
        act: vi.fn(async () => snapshot()),
        releaseThread: vi.fn(async () => snapshot()),
      },
      uuid: () => crypto.randomUUID(),
    });
    expect(restricted.definitions).toEqual([]);
    await expect(
      restricted.execute({
        name: "octant_browser",
        inputJson: JSON.stringify({ operation: "navigate", url: "https://example.com" }),
      }),
    ).resolves.toEqual({ result: { error: "tool-unavailable" }, isError: true });
    expect(create).not.toHaveBeenCalled();
  });

  it("answers help only where Browser is offered and keeps refusing effects Plan denies", async () => {
    const create = vi.fn(async () => snapshot());
    const make = (toolConstraints: ReadonlyArray<string> = []) =>
      createBrowserAppManagedTools({
        windowId,
        threadId,
        mode: "work",
        modelId,
        resolveModelId: () => modelId,
        modelBindings: new Map(),
        executionPolicy: "plan",
        toolConstraints,
        resolveAuthority: () => authority,
        browser: {
          inspectThread: () => snapshot(),
          create,
          act: vi.fn(async () => snapshot()),
          releaseThread: vi.fn(async () => snapshot()),
        },
        uuid: crypto.randomUUID,
      });
    const help = await make().execute({
      name: "octant_browser",
      inputJson: JSON.stringify({ operation: "help" }),
    });
    expect(help.isError).toBe(false);
    expect((help.result as { help: string }).help).toContain("observationRevision");
    const planned = await make().execute({
      name: "octant_browser",
      inputJson: JSON.stringify({ operation: "navigate", url: "https://example.com" }),
    });
    expect(planned.result).toEqual({ error: "plan-mode-read-only" });
    const denied = await make(["web-search"]).execute({
      name: "octant_browser",
      inputJson: JSON.stringify({ operation: "help" }),
    });
    expect(denied).toEqual({ result: { error: "tool-unavailable" }, isError: true });
    expect(create).not.toHaveBeenCalled();
  });

  it("cancels a queued browser approval when the selected model changes", async () => {
    let currentModel = modelId;
    let resolveApproval: ((decision: "approved") => void) | undefined;
    const approval = vi.fn(
      () =>
        new Promise<"approved">((resolve) => {
          resolveApproval = resolve;
        }),
    );
    const tools = createBrowserAppManagedTools({
      windowId,
      threadId,
      mode: "chat",
      modelId,
      resolveModelId: () => currentModel,
      modelBindings: new Map(),
      executionPolicy: "approval-gated",
      resolveAuthority: () => authority,
      browser: {
        inspectThread: () => snapshot(),
        create: vi.fn(async () => snapshot()),
        act: vi.fn(async () => snapshot()),
        releaseThread: vi.fn(async () => snapshot()),
      },
      approvals: { request: approval } as never,
      uuid: () => crypto.randomUUID(),
    });

    const pending = tools.execute({
      name: "octant_browser",
      inputJson: JSON.stringify({ operation: "navigate", url: "https://example.com" }),
    });
    await vi.waitFor(() => expect(approval).toHaveBeenCalledOnce());
    currentModel = "model-b";
    resolveApproval?.("approved");

    await expect(pending).resolves.toEqual({
      result: { error: "browser-model-stale" },
      isError: true,
    });
  });

  it("refuses an existing browser context after a provider model switch", async () => {
    let currentModel = modelId;
    const modelBindings = new Map<string, BrowserModelBinding>();
    let observed = snapshot();
    const create = vi.fn(async () => {
      observed = snapshot({
        status: "running",
        context: {
          contextId: "50000000-0000-4000-8000-000000000002" as never,
          threadId,
          actionId: "60000000-0000-4000-8000-000000000002" as never,
          correlationId: "70000000-0000-4000-8000-000000000002" as never,
          authority,
          policy: {
            profileMode: "isolated",
            allowedOrigins: ["https://example.com"],
            credentialFieldProtection: true,
            maxConcurrentTabs: 8,
            sessionTimeoutMs: 600_000,
          },
          state: "active",
          createdAt: "2026-09-09T10:00:00.000Z" as never,
        },
      });
      return observed;
    });
    const act = vi.fn(async () => observed);
    const tools = createBrowserAppManagedTools({
      windowId,
      threadId,
      mode: "chat",
      modelId,
      resolveModelId: () => currentModel,
      modelBindings,
      executionPolicy: "approval-gated",
      resolveAuthority: () => authority,
      browser: {
        inspectThread: () => observed,
        create,
        act,
        releaseThread: vi.fn(async () => snapshot()),
      },
      approvals: { request: vi.fn(async () => "approved" as const) } as never,
      uuid: () => crypto.randomUUID(),
    });

    await expect(
      tools.execute({
        name: "octant_browser",
        inputJson: JSON.stringify({ operation: "navigate", url: "https://example.com" }),
      }),
    ).resolves.toMatchObject({ isError: false });
    currentModel = "model-b";

    await expect(
      tools.execute({
        name: "octant_browser",
        inputJson: JSON.stringify({ operation: "read-page" }),
      }),
    ).resolves.toEqual({ result: { error: "browser-model-stale" }, isError: true });
    expect(act).toHaveBeenCalledOnce();
    const freshApproval = vi.fn(async () => "approved" as const);
    const freshTools = createBrowserAppManagedTools({
      windowId,
      threadId,
      mode: "chat",
      modelId: "model-b",
      resolveModelId: () => currentModel,
      modelBindings,
      executionPolicy: "approval-gated",
      resolveAuthority: () => authority,
      browser: {
        inspectThread: () => observed,
        create,
        act,
        releaseThread: vi.fn(async () => snapshot()),
      },
      approvals: { request: freshApproval } as never,
      uuid: () => crypto.randomUUID(),
    });
    await expect(
      freshTools.execute({
        name: "octant_browser",
        inputJson: JSON.stringify({ operation: "read-page" }),
      }),
    ).resolves.toMatchObject({ isError: false });
    expect(freshApproval).toHaveBeenCalledOnce();
    expect(act).toHaveBeenCalledTimes(2);
    await expect(
      tools.execute({
        name: "octant_browser",
        inputJson: JSON.stringify({ operation: "stop" }),
      }),
    ).resolves.toMatchObject({ isError: false });
  });

  it("refuses an old factory when the provider changes under the same model name", async () => {
    let currentAuthority = authority;
    const approval = vi.fn(async () => "approved" as const);
    const create = vi.fn(async () => snapshot());
    const tools = createBrowserAppManagedTools({
      windowId,
      threadId,
      mode: "chat",
      modelId,
      resolveModelId: () => modelId,
      modelBindings: new Map<string, BrowserModelBinding>(),
      executionPolicy: "approval-gated",
      resolveAuthority: () => currentAuthority,
      browser: {
        inspectThread: () => snapshot(),
        create,
        act: vi.fn(async () => snapshot()),
        releaseThread: vi.fn(async () => snapshot()),
      },
      approvals: { request: approval } as never,
      uuid: () => crypto.randomUUID(),
    });
    currentAuthority = {
      ...authority,
      providerInstanceId: "40000000-0000-0000-0000-000000000002",
    } as ToolActionAuthority;

    await expect(
      tools.execute({
        name: "octant_browser",
        inputJson: JSON.stringify({ operation: "navigate", url: "https://example.com" }),
      }),
    ).resolves.toEqual({ result: { error: "browser-authority-stale" }, isError: true });
    expect(approval).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });
});

describe("browser diagnostics reach the provider-facing result", () => {
  // The fields travel runtime -> observation -> automation service -> this
  // conversion -> provider, and every one of those is a place they can be
  // dropped. A drop here is invisible downstream: the provider receives a
  // perfectly valid observation that simply carries no diagnostic evidence,
  // so nothing fails and the agent answers from a blank. The automation
  // service boundary had exactly this defect and no test covered it.
  const diagnosticsObservation = {
    revision: 11,
    consoleErrors: [{ text: "Uncaught TypeError", url: "https://example.com/app.js" }],
    failedRequests: [
      { url: "https://example.com/api", method: "POST", failure: "net::ERR_FAILED" },
    ],
  };

  // A non-navigate operation only proceeds against an existing active context,
  // so the inspection has to describe one rather than an empty thread.
  function activeContext() {
    return {
      contextId: "50000000-0000-4000-8000-000000000001" as never,
      threadId,
      actionId: "60000000-0000-4000-8000-000000000001" as never,
      correlationId: "70000000-0000-4000-8000-000000000001" as never,
      authority,
      policy: {
        profileMode: "isolated" as const,
        allowedOrigins: ["https://example.com"],
        credentialFieldProtection: true,
        maxConcurrentTabs: 8,
        sessionTimeoutMs: 600_000,
      },
      state: "active" as const,
      createdAt: "2026-09-09T10:00:00.000Z" as never,
    };
  }

  function toolsFor(
    observation: unknown,
    act?: Parameters<typeof createBrowserAppManagedTools>[0]["browser"]["act"],
  ) {
    const running = snapshot({
      status: "running",
      context: activeContext(),
      observation: observation as never,
    });
    return createBrowserAppManagedTools({
      windowId,
      threadId,
      mode: "chat",
      modelId,
      resolveModelId: () => modelId,
      modelBindings: new Map(),
      executionPolicy: "approval-gated",
      resolveAuthority: () => authority,
      browser: {
        inspectThread: () => running,
        create: vi.fn(async () => running),
        act: act ?? vi.fn(async () => running),
        releaseThread: vi.fn(async () => running),
      },
      approvals: { request: vi.fn(async () => "approved" as const) } as never,
      uuid: () => "80000000-0000-4000-8000-000000000001",
    });
  }

  it("keeps the Work turn cancellation signal through the download port", async () => {
    const workAuthority = decodeToolActionAuthority({
      ...authority,
      mode: "work",
      projectId: "80000000-0000-4000-8000-000000000022",
    });
    const context = { ...activeContext(), authority: workAuthority };
    const running = snapshot({ status: "running", context });
    const saveDownload = vi.fn(async () => ({
      status: "saved" as const,
      path: "downloads/report.txt",
      sizeBytes: 4,
      mediaType: "text/plain",
    }));
    const tools = createBrowserAppManagedTools({
      windowId,
      threadId,
      mode: "work",
      modelId,
      resolveModelId: () => modelId,
      modelBindings: new Map([[String(context.contextId), { modelId, authority: workAuthority }]]),
      executionPolicy: "approval-gated",
      resolveAuthority: () => workAuthority,
      uploadRoot: () => "/workspace",
      browser: {
        inspectThread: () => running,
        create: vi.fn(async () => running),
        act: vi.fn(async () => running),
        releaseThread: vi.fn(async () => running),
        saveDownload,
      },
      approvals: { request: vi.fn(async () => "approved" as const) } as never,
      uuid: () => "80000000-0000-4000-8000-000000000001",
    });
    const abort = new AbortController();
    expect(
      await tools.execute({
        name: "octant_browser",
        inputJson: JSON.stringify({ operation: "download-save", downloadId: "d1" }),
        signal: abort.signal,
      }),
    ).toMatchObject({ isError: false });
    expect(saveDownload).toHaveBeenCalledWith(
      expect.objectContaining({
        signal: abort.signal,
        workspaceRoot: "/workspace",
        downloadId: "d1",
      }),
    );
  });

  it("refuses every call while the person has the page, but still lets stop release it", async () => {
    const act = vi.fn(async () => snapshot());
    const releaseThread = vi.fn(async () => snapshot());
    const tools = createBrowserAppManagedTools({
      windowId,
      threadId,
      mode: "chat",
      modelId,
      resolveModelId: () => modelId,
      modelBindings: new Map(),
      executionPolicy: "approval-gated",
      resolveAuthority: () => authority,
      browser: {
        inspectThread: () => snapshot({ context: activeContext(), waitingForPerson: "take-over" }),
        create: vi.fn(),
        act,
        releaseThread,
      },
      approvals: { request: vi.fn(async () => "approved" as const) } as never,
      uuid: () => "80000000-0000-4000-8000-000000000001",
    });
    for (const input of [{ operation: "snapshot" }, { operation: "click", selector: "#go" }]) {
      const held = await tools.execute({
        name: "octant_browser",
        inputJson: JSON.stringify(input),
      });
      expect(held.isError).toBe(true);
      expect(held.result).toMatchObject({
        error: "browser-person-took-over",
        message: expect.stringMatching(/took over/),
      });
    }
    expect(act).not.toHaveBeenCalled();
    await tools.execute({ name: "octant_browser", inputJson: '{"operation":"stop"}' });
    expect(releaseThread).toHaveBeenCalledOnce();
  });

  it("answers a call the service refused because the person took over while it was queued as the hold", async () => {
    const held = vi.fn(async () =>
      snapshot({
        status: "running",
        context: activeContext(),
        waitingForPerson: "take-over",
        failure: {
          category: "unavailable",
          message: "The person took over the page, so this call did not run.",
        },
      }),
    );
    const tools = toolsFor({ revision: 1 }, held);
    const result = await tools.execute({
      name: "octant_browser",
      inputJson: '{"operation":"click","selector":"#go"}',
    });
    expect(result.isError).toBe(true);
    expect(result.result).toMatchObject({ error: "browser-person-took-over" });
  });

  it("stops a batch at the step that hand-back answered with a fresh snapshot", async () => {
    const note =
      "The person took the page and handed it back, so your call did not run. This is a fresh snapshot of the page now.";
    const run = vi.fn(async (step: { operation: string }) =>
      step.operation === "click"
        ? { result: { status: "running", note, page: { snapshot: "- button" } }, isError: false }
        : { result: { status: "running", page: { changed: "ok" } }, isError: false },
    );
    const answer = await runBrowserToolSteps(
      [{ operation: "type" }, { operation: "click" }, { operation: "type" }] as never,
      run as never,
    );
    expect(run).toHaveBeenCalledTimes(2);
    expect(answer.isError).toBe(false);
    expect(answer.result).toMatchObject({
      note,
      stoppedAtStep: 2,
      steps: [
        { step: 1, operation: "type" },
        { step: 2, operation: "click" },
      ],
    });
  });

  it("says in one line that the person used the page, and in the handed-back case that the call did not run", async () => {
    for (const [used, text] of [
      ["used", /person used the page since you last looked/],
      ["handed-back", /handed it back, so your call did not run/],
    ] as const) {
      const tools = toolsFor(
        { revision: 3 },
        vi.fn(async () =>
          snapshot({
            status: "running",
            context: activeContext(),
            observation: { revision: 3 } as never,
            personUsedPage: used,
          }),
        ),
      );
      const result = await tools.execute({
        name: "octant_browser",
        inputJson: '{"operation":"read-page"}',
      });
      expect(result.result).toMatchObject({ note: expect.stringMatching(text) });
    }
  });

  it.each([
    "data:text/html;base64,aGVsbG8=",
    "data:image/png;base64,%%%",
    `data:image/png;base64,${"A".repeat(55 * 1024)}`,
  ])(
    "refuses an invalid or oversized screenshot without returning image bytes",
    async (screenshotDataUrl) => {
      const tools = toolsFor({ revision: 12, screenshotDataUrl });
      const result = await tools.execute({
        name: "octant_browser",
        inputJson: '{"operation":"screenshot"}',
      });
      expect(result).toMatchObject({
        isError: true,
        result: { error: "browser-screenshot-unavailable" },
      });
      expect(result.images).toBeUndefined();
    },
  );

  it("returns screenshots as image blocks without duplicating bytes in text", async () => {
    const tools = toolsFor({ revision: 12, screenshotDataUrl: "data:image/png;base64,aGVsbG8=" });
    const result = await tools.execute({
      name: "octant_browser",
      inputJson: '{"operation":"screenshot"}',
    });
    expect(result).toMatchObject({
      images: [{ mimeType: "image/png", data: "aGVsbG8=" }],
      isError: false,
    });
    expect(JSON.stringify(result.result)).not.toContain("aGVsbG8=");
  });

  it("names the agent as the one asking for the screenshot the host may keep", async () => {
    const act = vi.fn(async () =>
      snapshot({
        status: "running",
        context: activeContext(),
        observation: { revision: 12, screenshotDataUrl: "data:image/png;base64,aGVsbG8=" } as never,
      }),
    );
    const tools = toolsFor({ revision: 11 }, act);
    await tools.execute({ name: "octant_browser", inputJson: '{"operation":"screenshot"}' });
    expect(act).toHaveBeenCalledWith(expect.objectContaining({ capturedBy: "agent" }));
  });

  it("returns the screenshot and says when the thread did not keep a capture of it", async () => {
    const tools = toolsFor({
      revision: 12,
      screenshotDataUrl: "data:image/png;base64,aGVsbG8=",
      capture: { status: "not-kept", reason: "unavailable" },
    });
    const result = await tools.execute({
      name: "octant_browser",
      inputJson: '{"operation":"screenshot"}',
    });
    expect(result).toMatchObject({
      images: [{ mimeType: "image/png", data: "aGVsbG8=" }],
      isError: false,
      result: { page: { captureNotKept: "unavailable" } },
    });
    expect(JSON.stringify(result.result)).not.toContain("captureId");
  });

  it("returns the id of the capture the thread kept so a Canvas design can name it", async () => {
    const captureId = "6f1c2f0e-8a58-4c53-9a1b-3a4f0f6f7a10";
    const tools = toolsFor({
      revision: 12,
      screenshotDataUrl: "data:image/png;base64,aGVsbG8=",
      capture: { status: "kept", captureId },
    } as never);
    const result = await tools.execute({
      name: "octant_browser",
      inputJson: '{"operation":"screenshot"}',
    });
    expect(result).toMatchObject({ isError: false, result: { page: { captureId } } });
    expect(JSON.stringify(result.result)).not.toContain("captureNotKept");
  });

  it("passes what the page logged and failed to load through to the result", async () => {
    const tools = toolsFor(diagnosticsObservation);
    const result = await tools.execute({
      name: "octant_browser",
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

  it("advertises exactly the operations it accepts", async () => {
    // An operation in the advertised enum with no parser case is an
    // agent-visible trap: the model is told it may ask for something and the
    // call comes back as an input refusal it cannot tell apart from its own
    // typo. Diagnostics changed both sides together, and nothing held them
    // together, so this asserts the agreement rather than the two lists.
    const advertised = (
      BROWSER_TOOL_DEFINITION.inputSchema as {
        properties: { operation: { enum: ReadonlyArray<string> } };
      }
    ).properties.operation.enum;
    expect(advertised.length).toBeGreaterThan(0);

    // The least input each operation accepts, so a refusal can only come from
    // the operation itself rather than a missing field.
    const minimalInput: Readonly<Record<string, unknown>> = {
      navigate: { url: "https://example.com/" },
      snapshot: {},
      hover: { selector: "#go" },
      select: { selector: "#size", value: "L" },
      drag: { selector: "#card", toSelector: "#done" },
      upload: { selector: "#file", files: ["report.pdf"] },
      "tab-list": {},
      "tab-open": {},
      "tab-switch": { tabId: "t1" },
      "tab-close": { tabId: "t2" },
      steps: { steps: [{ operation: "snapshot" }] },
      "flow-save": { name: "Check the form" },
      "flow-list": {},
      "flow-run": { name: "Check the form" },
      resize: { width: 390, height: 844 },
      "sign-in": { reason: "The dashboard needs your account." },
      "run-script": { source: "42", expectedObservationRevision: 1 },
      "download-save": { downloadId: "d1" },
      "read-page": {},
      click: { selector: "#go" },
      type: { selector: "#name", text: "octant" },
      press: { key: "Enter" },
      scroll: {},
      wait: { selector: "#go" },
      screenshot: {},
      diagnostics: {},
      audit: { kind: "accessibility" },
      stop: {},
      help: {},
    };

    const tools = toolsFor({ revision: 1 });
    for (const operation of advertised) {
      const required = minimalInput[operation];
      expect(required, `no minimal input for advertised operation ${operation}`).toBeDefined();
      const result = await tools.execute({
        name: "octant_browser",
        inputJson: JSON.stringify({ operation, ...(required as object) }),
      });
      expect(result, `advertised operation ${operation} was refused as input`).not.toMatchObject({
        result: { error: "invalid-browser-input" },
      });
    }
  });

  it("asks the page for the audit it names and passes the shaped answer through", async () => {
    const audit = {
      kind: "accessibility",
      findings: [
        {
          rule: "field-name",
          severity: "serious",
          message: "Form field has no label.",
          ref: "e3",
          role: "textbox",
        },
      ],
      found: [{ rule: "field-name", count: 1 }],
      notRun: [],
      contrastNotMeasured: 0,
      framesNotAudited: 0,
      truncated: false,
    };
    const running = snapshot({
      status: "running",
      context: activeContext(),
      observation: { revision: 4, audit } as never,
    });
    const act = vi.fn(async () => running);
    const result = await toolsFor({ revision: 4, audit }, act).execute({
      name: "octant_browser",
      inputJson: JSON.stringify({ operation: "audit", kind: "accessibility" }),
    });
    expect(act).toHaveBeenCalledWith(
      expect.objectContaining({
        request: expect.objectContaining({ kind: "audit", auditKind: "accessibility" }),
      }),
    );
    expect(result).toMatchObject({ isError: false, result: { page: { audit } } });
  });

  it("refuses an audit that names no known audit or asks for more than the audit", async () => {
    const act = vi.fn();
    const tools = toolsFor({ revision: 1 }, act);
    for (const input of [
      { operation: "audit" },
      { operation: "audit", kind: "seo" },
      { operation: "audit", kind: "performance", include: ["snapshot"] },
      { operation: "audit", kind: "performance", reload: true },
    ]) {
      const result = await tools.execute({
        name: "octant_browser",
        inputJson: JSON.stringify(input),
      });
      expect(result.result).toEqual({ error: "invalid-browser-input" });
    }
    expect(act).not.toHaveBeenCalled();
  });

  it("admits an audit in Plan exactly as it admits diagnostics, since both only read the open page", async () => {
    const act = vi.fn(async () => snapshot());
    const running = snapshot({ status: "running", context: activeContext() });
    const tools = createBrowserAppManagedTools({
      windowId,
      threadId,
      mode: "work",
      modelId,
      resolveModelId: () => modelId,
      modelBindings: new Map(),
      executionPolicy: "plan",
      resolveAuthority: () => authority,
      browser: {
        inspectThread: () => running,
        create: vi.fn(async () => running),
        act,
        releaseThread: vi.fn(async () => running),
      },
      approvals: { request: vi.fn(async () => "approved" as const) } as never,
      uuid: () => "80000000-0000-4000-8000-000000000001",
    });
    for (const input of [
      { operation: "diagnostics" },
      { operation: "audit", kind: "performance" },
    ]) {
      const result = await tools.execute({
        name: "octant_browser",
        inputJson: JSON.stringify(input),
      });
      expect(result.isError).toBe(false);
    }
    expect(act.mock.calls.map((call) => (call as unknown[])[0])).toMatchObject([
      { request: { kind: "observe-diagnostics" } },
      { request: { kind: "audit", auditKind: "performance" } },
    ]);
  });

  it("omits the diagnostics rather than inventing an empty list", async () => {
    // Absent and empty are different claims: an empty array tells the agent the
    // page was clean, which an ordinary observation never asserted.
    const tools = toolsFor({ revision: 12 });
    const result = await tools.execute({
      name: "octant_browser",
      inputJson: JSON.stringify({ operation: "diagnostics" }),
    });
    const page = (result as { result?: { page?: Record<string, unknown> } }).result?.page;
    expect(page).toBeDefined();
    expect(page?.consoleErrors).toBeUndefined();
    expect(page?.failedRequests).toBeUndefined();
  });
});

describe("octant_browser profile argument", () => {
  const projectId = "90000000-0000-4000-8000-000000000001";
  const workAuthority = {
    hostId: "30000000-0000-4000-8000-000000000001",
    mode: "work",
    projectId,
    rootId: "31000000-0000-4000-8000-000000000001",
    providerInstanceId: "40000000-0000-4000-8000-000000000001",
    extension: { kind: "core" },
  } as unknown as ToolActionAuthority;
  const activeContext = (profile?: unknown) =>
    snapshot({
      status: "running",
      context: {
        contextId: "50000000-0000-4000-8000-000000000001" as never,
        threadId,
        actionId: "60000000-0000-4000-8000-000000000001" as never,
        correlationId: "70000000-0000-4000-8000-000000000001" as never,
        authority: workAuthority,
        policy: {
          profileMode: "isolated",
          ...(profile === undefined ? {} : { profile }),
          allowedOrigins: ["https://example.com"],
          credentialFieldProtection: true,
          maxConcurrentTabs: 8,
          sessionTimeoutMs: 600_000,
        },
        state: "active",
        createdAt: "2026-10-31T10:00:00.000Z" as never,
      } as never,
    });

  function fixture(
    options: {
      readonly defaultProfile?: BrowserProfileChoice;
      readonly paired?: boolean;
      readonly remembered?: (origin: string, profile: unknown) => boolean;
      readonly unattended?: boolean;
      readonly profileCaller?: "terminal-grant";
      readonly inspect?: BrowserAutomationSnapshot;
      readonly modelBindings?: Map<string, BrowserModelBinding>;
    } = {},
  ) {
    const create = vi.fn(async (input: { policy: { profile?: unknown } }) =>
      activeContext(input.policy.profile),
    );
    const act = vi.fn(async () =>
      snapshot({ status: "running", observation: { revision: 3 } as never }),
    );
    const request = vi.fn(async (_input: unknown) => "approved" as const);
    const tools = createBrowserAppManagedTools({
      windowId,
      threadId,
      mode: "work",
      modelId,
      resolveModelId: () => modelId,
      modelBindings: options.modelBindings ?? new Map(),
      resolveTaskProfile: () => options.defaultProfile,
      executionPolicy: "approval-gated",
      resolveAuthority: () => workAuthority,
      browser: {
        inspectThread: () => options.inspect ?? snapshot(),
        create: create as never,
        act,
        releaseThread: vi.fn(async () => snapshot()),
      },
      approvals: {
        request,
        isRemembered: (origin: string, profile: unknown) =>
          options.remembered?.(origin, profile) === true,
        isUnattendedScope: () => options.unattended === true,
        isPairedDevice: () => options.paired === true,
      } as never,
      ...(options.profileCaller === undefined ? {} : { profileCaller: options.profileCaller }),
      uuid: () => "80000000-0000-4000-8000-000000000001",
    });
    const run = (input: Record<string, unknown>) =>
      tools.execute({ name: "octant_browser", inputJson: JSON.stringify(input) });
    return { create, act, request, run };
  }

  it("keeps a page Private when no profile is asked for", async () => {
    const { run, create, request } = fixture();

    await run({ operation: "navigate", url: "https://example.com/a" });

    expect(create.mock.calls[0]?.[0].policy.profile).toBeUndefined();
    expect(request.mock.calls[0]?.[0]).not.toHaveProperty("profile");
  });

  it("keeps a selected named account separate from the ordinary Personal profile", async () => {
    const profileId = "40000000-0000-4000-8000-000000000002";
    const f = fixture({ defaultProfile: `account:${profileId}` });
    expect((await f.run({ operation: "navigate", url: "https://example.com" })).isError).toBe(
      false,
    );
    expect(f.request).toHaveBeenCalledWith(
      expect.objectContaining({ profile: { kind: "account", profileId } }),
    );
    expect(f.create.mock.calls[0]?.[0].policy.profile).toEqual({ kind: "account", profileId });
  });

  it("uses the task default without granting it, and lets an explicit Private override it", async () => {
    const selected = fixture({ defaultProfile: "personal" });
    await selected.run({ operation: "navigate", url: "https://example.com" });
    expect(selected.request).toHaveBeenCalledWith(
      expect.objectContaining({ profile: { kind: "personal" } }),
    );
    expect(selected.create.mock.calls[0]?.[0].policy.profile).toEqual({ kind: "personal" });
    const explicit = fixture({ defaultProfile: "personal" });
    await explicit.run({ operation: "navigate", url: "https://example.com", profile: "private" });
    expect(explicit.create.mock.calls[0]?.[0].policy.profile).toBeUndefined();
  });

  it.each([{ unattended: true }, { profileCaller: "terminal-grant" as const }, { paired: true }])(
    "refuses an inherited stored default for excluded callers instead of opening Private: %j",
    async (caller) => {
      const f = fixture({ ...caller, defaultProfile: "personal" });
      const answer = await f.run({ operation: "navigate", url: "https://example.com" });
      expect(answer.isError).toBe(true);
      expect(f.create).not.toHaveBeenCalled();
      expect(f.request).not.toHaveBeenCalled();
    },
  );

  it.each(["same", "model", "authority"] as const)(
    "checks a person-switched pending binding before exposing page content: %s",
    async (change) => {
      const active = activeContext({ kind: "personal" });
      const bindings = new Map([
        [
          String(active.context!.contextId),
          {
            approval: "pending" as const,
            modelId: change === "model" ? "old-model" : modelId,
            authority:
              change === "authority"
                ? { ...workAuthority, rootId: "different" as never }
                : workAuthority,
          },
        ],
      ]);
      const f = fixture({ inspect: active, modelBindings: bindings, remembered: () => true });
      await f.run({ operation: "snapshot" });
      expect(f.request).toHaveBeenCalledTimes(change === "same" ? 0 : 1);
      expect(bindings.get(String(active.context!.contextId))).not.toHaveProperty("approval");
    },
  );

  it("keeps a live explicit Private page when a later navigate omits its Project default", async () => {
    const active = activeContext();
    const bindings = new Map([
      [String(active.context!.contextId), { modelId, authority: workAuthority }],
    ]);
    const f = fixture({ defaultProfile: "project", inspect: active, modelBindings: bindings });
    expect((await f.run({ operation: "navigate", url: "https://example.com/next" })).isError).toBe(
      false,
    );
    expect(f.create).not.toHaveBeenCalled();
  });

  it("asks the person about the site and names the profile", async () => {
    const { run, create, request } = fixture();

    await run({ operation: "navigate", url: "https://example.com/a", profile: "personal" });

    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({ origin: "https://example.com", profile: { kind: "personal" } }),
    );
    expect(create.mock.calls[0]?.[0].policy.profile).toEqual({ kind: "personal" });
  });

  it("maps project to this thread's own Project profile", async () => {
    const { run, create } = fixture();

    await run({ operation: "navigate", url: "https://example.com/a", profile: "project" });

    expect(create.mock.calls[0]?.[0].policy.profile).toEqual({ kind: "project", projectId });
  });

  it("lets a pair remembered for that profile stand in for the prompt, and no other pair", async () => {
    const remembered = fixture({
      remembered: (origin, profile) =>
        origin === "https://example.com" &&
        (profile as { kind: string } | undefined)?.kind === "personal",
    });
    await remembered.run({
      operation: "navigate",
      url: "https://example.com/a",
      profile: "personal",
    });
    expect(remembered.request).not.toHaveBeenCalled();

    const otherProfile = fixture({
      remembered: (_origin, profile) =>
        (profile as { kind: string } | undefined)?.kind === "personal",
    });
    await otherProfile.run({
      operation: "navigate",
      url: "https://example.com/a",
      profile: "project",
    });
    expect(otherProfile.request).toHaveBeenCalledTimes(1);

    // A remembered Private origin never covers a profile page.
    const privateOnly = fixture({ remembered: (_origin, profile) => profile === undefined });
    await privateOnly.run({
      operation: "navigate",
      url: "https://example.com/a",
      profile: "personal",
    });
    expect(privateOnly.request).toHaveBeenCalledTimes(1);
  });

  it("refuses a profile page for a routine, a subagent, and a terminal grant without asking anyone", async () => {
    for (const options of [{ unattended: true }, { profileCaller: "terminal-grant" as const }]) {
      const { run, create, request } = fixture(options);

      const result = await run({
        operation: "navigate",
        url: "https://example.com/a",
        profile: "personal",
      });

      expect(result).toMatchObject({ isError: true, result: { error: "profile-needs-a-person" } });
      expect(request).not.toHaveBeenCalled();
      expect(create).not.toHaveBeenCalled();
    }
  });

  it("does not let the agent move an open page to another profile", async () => {
    const { run, create } = fixture({ inspect: activeContext() });

    const result = await run({
      operation: "navigate",
      url: "https://example.com/b",
      profile: "personal",
    });

    expect(result).toMatchObject({
      isError: true,
      result: { error: "browser-profile-differs-stop-first" },
    });
    expect(create).not.toHaveBeenCalled();
  });

  it("refuses an unattended turn on a page that is already in a profile", async () => {
    const contextId = "50000000-0000-4000-8000-000000000001";
    const { run, request } = fixture({
      unattended: true,
      inspect: activeContext({ kind: "personal" }),
      modelBindings: new Map([[contextId, { modelId, authority: workAuthority }]]),
    });

    const result = await run({ operation: "read-page" });

    expect(result).toMatchObject({ isError: true, result: { error: "profile-needs-a-person" } });
    expect(request).not.toHaveBeenCalled();
  });

  it("reports an expired page without creating, approving, or switching its profile", async () => {
    const opened = activeContext({ kind: "personal" });
    const expired = snapshot({
      ...opened,
      status: "stale",
      context: { ...opened.context, state: "expired" } as never,
      failure: {
        category: "context-expired",
        message: 'The Browser page expired. Call navigate with profile "personal".',
      },
    });
    const bindings = new Map<string, BrowserModelBinding>([
      [String(opened.context?.contextId), { modelId, authority: workAuthority }],
    ]);
    const { run, create, act, request } = fixture({ inspect: expired, modelBindings: bindings });
    for (const operation of ["snapshot", "read-page", "screenshot", "sign-in"]) {
      expect(await run({ operation })).toMatchObject({
        isError: true,
        result: {
          failure: {
            category: "context-expired",
            message: expect.stringContaining('profile "personal"'),
          },
        },
      });
    }
    expect(create).not.toHaveBeenCalled();
    expect(act).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
    expect(bindings.size).toBe(1);
    await run({ operation: "navigate", url: "https://example.com/a", profile: "personal" });
    expect(create.mock.calls[0]?.[0].policy.profile).toEqual({ kind: "personal" });
  });

  it("keeps a never-opened page distinct and hides expiry from mismatched or missing bindings", async () => {
    const never = fixture();
    expect(await never.run({ operation: "snapshot" })).toMatchObject({
      isError: true,
      result: { error: "browser-navigation-required" },
    });
    const opened = activeContext({ kind: "personal" });
    const expired = snapshot({
      ...opened,
      status: "stale",
      context: { ...opened.context, state: "expired" } as never,
      failure: {
        category: "context-expired",
        message: "The Browser page expired in the Personal profile.",
      },
    });
    const otherAuthority = decodeToolActionAuthority({
      ...workAuthority,
      hostId: "30000000-0000-4000-8000-000000000002",
    });
    for (const binding of [
      undefined,
      { modelId: "another-model", authority: workAuthority },
      { modelId, authority: otherAuthority },
    ]) {
      const { run, create, request } = fixture({
        inspect: expired,
        modelBindings:
          binding === undefined
            ? new Map()
            : new Map([[String(opened.context?.contextId), binding]]),
      });
      const result = await run({ operation: "snapshot" });
      expect(result).toMatchObject({
        isError: true,
        result: { error: "browser-navigation-required" },
      });
      expect(JSON.stringify(result)).not.toContain("Personal");
      expect(create).not.toHaveBeenCalled();
      expect(request).not.toHaveBeenCalled();
    }
  });

  it("keeps expired stored profiles unavailable to unattended and terminal callers", async () => {
    const opened = activeContext({ kind: "personal" });
    const expired = snapshot({
      ...opened,
      status: "stale",
      context: { ...opened.context, state: "expired" } as never,
      failure: { category: "context-expired", message: "Expired Personal page." },
    });
    for (const caller of [{ unattended: true }, { profileCaller: "terminal-grant" as const }]) {
      const { run, create, act } = fixture({
        ...caller,
        inspect: expired,
        modelBindings: new Map([
          [String(opened.context?.contextId), { modelId, authority: workAuthority }],
        ]),
      });
      const answer = await run({ operation: "snapshot" });
      expect(answer).toMatchObject({ isError: true, result: { error: "profile-needs-a-person" } });
      expect(JSON.stringify(answer)).not.toContain("Personal");
      expect(create).not.toHaveBeenCalled();
      expect(act).not.toHaveBeenCalled();
    }
  });

  it("rejects a profile other than project or personal", async () => {
    const { run } = fixture();

    expect(
      await run({ operation: "navigate", url: "https://example.com/a", profile: "default" }),
    ).toMatchObject({ isError: true, result: { error: "invalid-browser-input" } });
  });
});

describe("octant_browser resize and device emulation", () => {
  const running = snapshot({
    status: "running",
    context: {
      contextId: "50000000-0000-4000-8000-000000000001" as never,
      threadId,
      actionId: "60000000-0000-4000-8000-000000000001" as never,
      correlationId: "70000000-0000-4000-8000-000000000001" as never,
      authority,
      policy: {
        profileMode: "isolated" as const,
        allowedOrigins: ["https://example.com"],
        credentialFieldProtection: true,
        maxConcurrentTabs: 8,
        sessionTimeoutMs: 600_000,
      },
      state: "active" as const,
      createdAt: "2026-09-09T10:00:00.000Z" as never,
    },
    observation: {
      revision: 3,
      emulation: {
        width: 390,
        height: 844,
        deviceScaleFactor: 3,
        touch: true,
        colorScheme: "dark",
      },
    } as never,
  });

  function resizeWith(
    input: Record<string, unknown>,
    executionPolicy: "approval-gated" | "plan" = "approval-gated",
  ) {
    const act = vi.fn(async () => running);
    const tools = createBrowserAppManagedTools({
      windowId,
      threadId,
      mode: "chat",
      modelId,
      resolveModelId: () => modelId,
      modelBindings: new Map(),
      executionPolicy,
      resolveAuthority: () => authority,
      browser: {
        inspectThread: () => running,
        create: vi.fn(async () => running),
        act,
        releaseThread: vi.fn(async () => running),
      },
      approvals: { request: vi.fn(async () => "approved" as const) } as never,
      uuid: () => "80000000-0000-4000-8000-000000000001",
    });
    return {
      act,
      result: tools.execute({
        name: "octant_browser",
        inputJson: JSON.stringify({ operation: "resize", ...input }),
      }),
    };
  }

  function requested(act: ReturnType<typeof resizeWith>["act"]) {
    return (act.mock.calls[0] as unknown as [Record<string, unknown>])[0];
  }

  it.each([
    [
      "phone",
      { viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, mobile: true, touch: true },
    ],
    [
      "phone-landscape",
      { viewport: { width: 844, height: 390 }, deviceScaleFactor: 3, mobile: true, touch: true },
    ],
    [
      "tablet",
      { viewport: { width: 820, height: 1180 }, deviceScaleFactor: 2, mobile: true, touch: true },
    ],
    [
      "desktop",
      { viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1, mobile: false, touch: false },
    ],
  ])(
    "turns the %s preset into a size, a pixel ratio, a mobile flag, and touch",
    async (preset, expected) => {
      const { act, result } = resizeWith({ preset });
      expect(await result).toMatchObject({ isError: false });
      expect(requested(act)).toMatchObject({ request: { kind: "resize", ...expected } });
    },
  );

  it("lets touch and color scheme override a preset, and reports what the page now sees", async () => {
    const { act, result } = resizeWith({ preset: "phone", touch: false, colorScheme: "dark" });
    expect(await result).toMatchObject({
      result: {
        page: {
          emulation: {
            width: 390,
            height: 844,
            deviceScaleFactor: 3,
            touch: true,
            colorScheme: "dark",
          },
        },
      },
    });
    expect(requested(act)).toMatchObject({
      request: { kind: "resize", touch: false, colorScheme: "dark", mobile: true },
    });
  });

  it("changes only the fields named, and restores all with none", async () => {
    const dark = resizeWith({ colorScheme: "dark" });
    await dark.result;
    const request = (requested(dark.act) as { request: Record<string, unknown> }).request;
    expect(request).toMatchObject({ kind: "resize", colorScheme: "dark" });
    expect(request).not.toHaveProperty("viewport");
    expect(request).not.toHaveProperty("touch");

    const restore = resizeWith({});
    await restore.result;
    const restoring = (requested(restore.act) as { request: Record<string, unknown> }).request;
    for (const field of ["viewport", "touch", "colorScheme", "deviceScaleFactor", "mobile"]) {
      expect(restoring).not.toHaveProperty(field);
    }

    const sized = resizeWith({ width: 600, height: 900, touch: true });
    await sized.result;
    const plain = (requested(sized.act) as { request: Record<string, unknown> }).request;
    expect(plain).toMatchObject({ viewport: { width: 600, height: 900 }, touch: true });
    expect(plain).not.toHaveProperty("deviceScaleFactor");
  });

  it.each([
    ["an unknown preset", { preset: "watch" }],
    ["a prototype name as a preset", { preset: "constructor" }],
    ["a preset beside a width", { preset: "phone", width: 400 }],
    ["a preset beside a height", { preset: "phone", height: 800 }],
    ["a width without a height", { width: 400 }],
    ["a size under the bound", { width: 100, height: 100 }],
    ["a touch that is not a boolean", { touch: "yes" }],
    ["an unknown color scheme", { colorScheme: "sepia" }],
    ["a pixel ratio the agent picks", { preset: "phone", deviceScaleFactor: 9 }],
    ["a mobile flag the agent picks", { width: 400, height: 800, mobile: true }],
  ])("refuses %s before any page is touched", async (_label, input) => {
    const { act, result } = resizeWith(input);
    expect((await result).result).toEqual({ error: "invalid-browser-input" });
    expect(act).not.toHaveBeenCalled();
  });

  it("refuses emulation in Plan mode like any other operation", async () => {
    const { act, result } = resizeWith({ preset: "phone", colorScheme: "dark" }, "plan");
    expect((await result).result).toEqual({ error: "plan-mode-read-only" });
    expect(act).not.toHaveBeenCalled();
  });
});

describe("octant_browser flow operations", () => {
  const parse = (input: unknown) =>
    parseBrowserToolInput(JSON.stringify(input), { allowProfile: true });

  it("reads flow-save and flow-run with a name of 1 to 80 characters that is already trimmed", () => {
    expect(parse({ operation: "flow-save", name: "Check the form" })).toEqual({
      operation: "flow-save",
      name: "Check the form",
    });
    expect(parse({ operation: "flow-run", name: "x".repeat(80) })?.operation).toBe("flow-run");
    for (const name of ["", " padded ", "x".repeat(81), 3, undefined]) {
      expect(parse({ operation: "flow-run", name })).toBeUndefined();
      expect(parse({ operation: "flow-save", name })).toBeUndefined();
    }
    expect(parse({ operation: "flow-list" })).toEqual({ operation: "flow-list" });
    expect(parse({ operation: "flow-list", name: "x" })).toBeUndefined();
    expect(parse({ operation: "flow-run", name: "x", include: ["snapshot"] })).toBeUndefined();
  });

  it("keeps a flow operation out of a batch", () => {
    for (const operation of [
      { operation: "flow-run", name: "x" },
      { operation: "flow-save", name: "x" },
      { operation: "flow-list" },
    ]) {
      expect(parse({ operation: "steps", steps: [operation] })).toBeUndefined();
    }
  });

  it("answers that flows are unavailable where the host keeps none", async () => {
    const tools = createBrowserAppManagedTools({
      windowId,
      threadId,
      mode: "chat",
      modelId,
      resolveModelId: () => modelId,
      modelBindings: new Map(),
      executionPolicy: "approval-gated",
      resolveAuthority: () => authority,
      browser: {
        inspectThread: () => snapshot(),
        create: vi.fn(),
        act: vi.fn(),
        releaseThread: vi.fn(),
      },
      uuid: () => "80000000-0000-4000-8000-000000000001",
    });
    expect(
      await tools.execute({
        name: "octant_browser",
        inputJson: JSON.stringify({ operation: "flow-list" }),
      }),
    ).toMatchObject({ isError: true, result: { error: "browser-flows-unavailable" } });
  });

  it("writes an operation back as the tool takes it, and a stored step reads again to the same operation", () => {
    for (const call of [
      {
        operation: "wait",
        conditions: [{ text: "Saved", present: true }, { urlContains: "/done" }],
        match: "any",
        timeoutMs: 2000,
      },
      { operation: "wait", conditions: [{ ref: "e4", state: "visible" }], match: "all" },
      { operation: "drag", ref: "e2", toRef: "e3" },
      { operation: "resize", width: 390, height: 844 },
      { operation: "type", ref: "e2", text: "Ada" },
      { operation: "scroll", deltaY: 200 },
      { operation: "navigate", url: "https://example.com/a" },
    ]) {
      const parsed = parse({ ...call, expectedObservationRevision: 4 });
      if (parsed === undefined || parsed.operation === "steps") throw new Error("not parsed");
      const record = browserToolInputRecord(parsed);
      expect(record.expectedObservationRevision).toBeUndefined();
      expect(parse(record)).toEqual(parse(call));
    }
  });

  it("keeps reads and listings out of a flow and refuses what needs the person", () => {
    const decide = (input: unknown) => {
      const parsed = parse(input);
      if (parsed === undefined) throw new Error("not parsed");
      return flowDecision(parsed).kind;
    };
    for (const operation of ["snapshot", "screenshot", "read-page", "diagnostics", "tab-list"]) {
      expect(decide({ operation })).toBe("unstored");
    }
    expect(decide({ operation: "audit", kind: "accessibility" })).toBe("unstored");
    expect(decide({ operation: "click", selector: "#go" })).toBe("stored");
    expect(decide({ operation: "upload", selector: "#f", files: ["a.pdf"] })).toBe(
      "needs-a-person",
    );
    expect(decide({ operation: "sign-in" })).toBe("needs-a-person");
    expect(decide({ operation: "download-save", downloadId: "d1" })).toBe("needs-a-person");
    expect(decide({ operation: "stop" })).toBe("needs-a-person");
    expect(decide({ operation: "navigate", url: "https://example.com", profile: "project" })).toBe(
      "needs-a-person",
    );
    expect(decide({ operation: "navigate", url: "https://user:pw@example.com/" })).toBe(
      "needs-a-person",
    );
    expect(decide({ operation: "navigate", url: "https://example.com/?code=1#top" })).toBe(
      "needs-a-person",
    );
    expect(decide({ operation: "navigate", url: "https://example.com/?page=2#top" })).toBe(
      "stored",
    );
  });
});

describe("bounded page script input", () => {
  it("requires an observed revision and bounds source bytes while refusing script batches", () => {
    const parse = (input: unknown) =>
      parseBrowserToolInput(JSON.stringify(input), { allowProfile: true });
    expect(
      parse({ operation: "run-script", source: "document.title", expectedObservationRevision: 1 }),
    ).toEqual({
      operation: "run-script",
      source: "document.title",
      expectedObservationRevision: 1,
    });
    for (const input of [
      { operation: "run-script", source: "42" },
      { operation: "run-script", source: "😀".repeat(2049), expectedObservationRevision: 1 },
      {
        operation: "run-script",
        source: "42",
        expectedObservationRevision: 1,
        profile: "personal",
      },
      {
        operation: "steps",
        steps: [{ operation: "run-script", source: "42", expectedObservationRevision: 1 }],
      },
    ])
      expect(parse(input)).toBeUndefined();
  });
});

describe("octant_browser recording", () => {
  const context = {
    contextId: "50000000-0000-4000-8000-000000000001" as never,
    threadId,
    actionId: "60000000-0000-4000-8000-000000000001" as never,
    correlationId: "70000000-0000-4000-8000-000000000001" as never,
    authority,
    policy: {
      profileMode: "isolated" as const,
      allowedOrigins: ["https://example.com"],
      credentialFieldProtection: true,
      maxConcurrentTabs: 8,
      sessionTimeoutMs: 600_000,
    },
    state: "active" as const,
    createdAt: "2026-09-09T10:00:00.000Z" as never,
  };
  const captureId = "6f1c2f0e-8a58-4c53-9a1b-3a4f0f6f7a10";
  const recording = { frames: 9, durationMs: 2_250 };

  function recordingTools(
    answer: (kind: string) => BrowserAutomationSnapshot,
    posture: "approval-gated" | "plan" | (() => "approval-gated" | "plan") = "approval-gated",
  ) {
    const running = snapshot({ status: "running", context, observation: { revision: 4 } as never });
    const act = vi.fn(async (input: { readonly request: { readonly kind: string } }) =>
      answer(input.request.kind),
    );
    const tools = createBrowserAppManagedTools({
      windowId,
      threadId,
      mode: "chat",
      modelId,
      resolveModelId: () => modelId,
      modelBindings: new Map(),
      // Read at each check, as a posture that changes while a call runs is.
      get executionPolicy() {
        return typeof posture === "function" ? posture() : posture;
      },
      resolveAuthority: () => authority,
      browser: {
        inspectThread: () => running,
        create: vi.fn(async () => running),
        act: act as never,
        releaseThread: vi.fn(async () => running),
      },
      approvals: { request: vi.fn(async () => "approved" as const) } as never,
      uuid: () => "80000000-0000-4000-8000-000000000001",
    });
    const kinds = () =>
      act.mock.calls.map((call) => (call[0] as { request: { kind: string } }).request.kind);
    return { act, tools, kinds };
  }

  const kept = (kind: string) =>
    snapshot({
      status: "running",
      context,
      observation: {
        revision: 5,
        ...(kind === "record-stop"
          ? { capture: { status: "kept", captureId, recording } }
          : { change: "The page's text changed." }),
      } as never,
    });

  it("records the page around a batch and answers with the recording the thread kept", async () => {
    const { act, tools, kinds } = recordingTools(kept);
    const result = await tools.execute({
      name: "octant_browser",
      inputJson: JSON.stringify({
        operation: "steps",
        record: true,
        steps: [{ operation: "click", selector: "#save" }],
      }),
    });
    expect(kinds()).toEqual(["record-start", "click", "record-stop"]);
    for (const call of act.mock.calls) {
      expect(call[0]).toMatchObject({ capturedBy: "agent" });
    }
    expect(result).toMatchObject({
      isError: false,
      result: { recording: { captureId, ...recording }, steps: [{ step: 1, operation: "click" }] },
    });
  });

  it("records a flow replay the same way", async () => {
    const { kinds, tools } = recordingTools(kept);
    await tools.execute({
      name: "octant_browser",
      inputJson: JSON.stringify({ operation: "flow-run", name: "Check the form", record: true }),
    });
    // This host keeps no flows, so the replay itself is refused; the recording
    // around it still starts and ends.
    expect(kinds()).toEqual(["record-start", "record-stop"]);
  });

  it("still ends the recording when a step fails, and says why none was kept", async () => {
    const { tools, kinds } = recordingTools((kind) =>
      kind === "click"
        ? snapshot({
            status: "failed",
            context,
            failure: { category: "failed", message: "The browser action failed." },
          })
        : kind === "record-stop"
          ? snapshot({
              status: "running",
              context,
              observation: {
                revision: 5,
                capture: { status: "not-kept", reason: "no-picture" },
              } as never,
            })
          : kept(kind),
    );
    const result = await tools.execute({
      name: "octant_browser",
      inputJson: JSON.stringify({
        operation: "steps",
        record: true,
        steps: [
          { operation: "click", selector: "#save" },
          { operation: "click", selector: "#next" },
        ],
      }),
    });
    expect(kinds()).toEqual(["record-start", "click", "record-stop"]);
    expect(result).toMatchObject({
      isError: true,
      result: { failedStep: { step: 1 }, recordingNotKept: "no-picture" },
    });
  });

  it("runs nothing when the Browser cannot record", async () => {
    const { tools, kinds } = recordingTools((kind) =>
      kind === "record-start"
        ? snapshot({
            status: "failed",
            context,
            failure: { category: "unavailable", message: "This Browser cannot record the page." },
          })
        : kept(kind),
    );
    const result = await tools.execute({
      name: "octant_browser",
      inputJson: JSON.stringify({
        operation: "steps",
        record: true,
        steps: [{ operation: "click", selector: "#save" }],
      }),
    });
    expect(kinds()).toEqual(["record-start"]);
    expect(result).toMatchObject({
      isError: true,
      result: {
        error: "recording-refused",
        answer: { failure: { category: "unavailable" } },
      },
    });
  });

  it("stops a recording that began before Plan and keeps nothing when the thread moves into Plan mid-batch", async () => {
    let posture: "approval-gated" | "plan" = "approval-gated";
    const { act, tools, kinds } = recordingTools(
      (kind) => {
        if (kind === "wait") posture = "plan";
        return kept(kind === "record-stop" ? "wait" : kind);
      },
      () => posture,
    );
    const result = await tools.execute({
      name: "octant_browser",
      inputJson: JSON.stringify({
        operation: "steps",
        record: true,
        steps: [
          { operation: "wait", selector: "main" },
          { operation: "click", selector: "#save" },
        ],
      }),
    });
    expect(kinds()).toEqual(["record-start", "wait", "record-stop"]);
    expect(act.mock.calls[2]?.[0]).toMatchObject({ discardRecording: true });
    expect(result).toMatchObject({
      isError: true,
      result: { failedStep: { step: 2 }, recordingNotKept: "plan-mode-read-only" },
    });
    expect(result.result).not.toHaveProperty("recording");
  });

  it("refuses a recording in Plan, even around a batch of reads, and runs none of it", async () => {
    const { act, tools } = recordingTools(kept, "plan");
    const result = await tools.execute({
      name: "octant_browser",
      inputJson: JSON.stringify({
        operation: "steps",
        record: true,
        steps: [{ operation: "screenshot" }],
      }),
    });
    expect(result.result).toEqual({
      error: "recording-refused",
      answer: { error: "plan-mode-read-only" },
    });
    expect(act).not.toHaveBeenCalled();
  });

  it("reads record only as a boolean on steps and flow-run, and never as an operation", () => {
    const parse = (input: unknown) =>
      parseBrowserToolInput(JSON.stringify(input), { allowProfile: true });
    expect(
      parse({ operation: "steps", record: true, steps: [{ operation: "snapshot" }] }),
    ).toMatchObject({ record: true });
    expect(
      parse({ operation: "steps", record: false, steps: [{ operation: "snapshot" }] }),
    ).not.toHaveProperty("record");
    expect(parse({ operation: "flow-run", name: "Check", record: true })).toMatchObject({
      record: true,
    });
    for (const input of [
      { operation: "steps", record: "yes", steps: [{ operation: "snapshot" }] },
      { operation: "steps", steps: [{ operation: "snapshot", record: true }] },
      { operation: "flow-save", name: "Check", record: true },
      { operation: "screenshot", record: true },
      { operation: "record-start" },
      { operation: "record-stop" },
      { operation: "steps", steps: [{ operation: "record-start" }] },
    ])
      expect(parse(input), JSON.stringify(input)).toBeUndefined();
  });
});

describe("octant_browser in Plan mode", () => {
  const contextId = "50000000-0000-4000-8000-000000000031";
  // Flows belong to a Project, so this thread's authority names one.
  const planAuthority = {
    ...authority,
    projectId: "80000000-0000-4000-8000-000000000031",
  } as ToolActionAuthority;
  const page = snapshot({
    status: "running",
    context: {
      contextId: contextId as never,
      threadId,
      actionId: "60000000-0000-4000-8000-000000000031" as never,
      correlationId: "70000000-0000-4000-8000-000000000031" as never,
      authority: planAuthority,
      policy: {
        profileMode: "isolated",
        allowedOrigins: ["https://example.com"],
        credentialFieldProtection: true,
        maxConcurrentTabs: 8,
        sessionTimeoutMs: 600_000,
      },
      state: "active",
      createdAt: "2026-09-09T10:00:00.000Z" as never,
    },
    observation: { revision: 4, screenshotDataUrl: "data:image/png;base64,aGVsbG8=" } as never,
  });

  /** A Plan turn whose page is already open and approved for model-a. */
  function planTools(options: { readonly modelId?: string } = {}) {
    const turnModel = options.modelId ?? modelId;
    const act = vi.fn(async () => page);
    const create = vi.fn(async () => page);
    const releaseThread = vi.fn(async () => snapshot());
    const saveDownload = vi.fn();
    const request = vi.fn(async () => "denied" as const);
    const save = vi.fn();
    const tools = createBrowserAppManagedTools({
      windowId,
      threadId,
      mode: "work",
      modelId: turnModel,
      resolveModelId: () => turnModel,
      modelBindings: new Map<string, BrowserModelBinding>([
        [contextId, { modelId, authority: planAuthority }],
      ]),
      executionPolicy: "plan",
      resolveAuthority: () => planAuthority,
      browser: {
        inspectThread: () => page,
        create,
        act,
        saveDownload: saveDownload as never,
        releaseThread,
        snapshotRefs: () => [],
        holdForPerson: vi.fn(),
      },
      flows: {
        service: { list: () => [], get: () => undefined, save: save as never },
        recorder: new BrowserFlowRecorder(),
        caller: () => "person",
      },
      approvals: { request } as never,
      uploadRoot: () => "/tmp/octant-plan-workspace",
      uuid: () => crypto.randomUUID(),
    });
    return { tools, act, create, releaseThread, saveDownload, request, save };
  }
  const call = (tools: ReturnType<typeof planTools>["tools"], input: unknown) =>
    tools.execute({ name: "octant_browser", inputJson: JSON.stringify(input) });
  const operations = Object.keys(BROWSER_OPERATION_EFFECT) as ReadonlyArray<
    keyof typeof BROWSER_OPERATION_EFFECT
  >;
  const withEffect = (effect: string) =>
    operations.filter((operation) => BROWSER_OPERATION_EFFECT[operation] === effect);

  it.each(withEffect("reads"))(
    "admits %s in Plan, which only reads, and asks no one",
    async (operation) => {
      const { tools, act, create, request } = planTools();
      const answer = await call(tools, BROWSER_CALL_OF_EACH_OPERATION[operation]);
      expect(answer.isError).toBe(false);
      // help and flow-list touch no page; every other read reaches it once.
      expect(act).toHaveBeenCalledTimes(operation === "help" || operation === "flow-list" ? 0 : 1);
      expect(create).not.toHaveBeenCalled();
      expect(request).not.toHaveBeenCalled();
    },
  );

  it.each(withEffect("changes"))(
    "refuses %s before anything reaches the page, the workspace, or the person",
    async (operation) => {
      const { tools, act, create, request, saveDownload, save } = planTools();
      const answer = await call(tools, BROWSER_CALL_OF_EACH_OPERATION[operation]);
      // A recording is refused at its start, so the call it wraps never runs.
      const refusal = { error: "plan-mode-read-only" };
      expect(answer).toEqual({
        result: operation.startsWith("record-")
          ? { error: "recording-refused", answer: refusal }
          : refusal,
        isError: true,
      });
      expect(act).not.toHaveBeenCalled();
      expect(create).not.toHaveBeenCalled();
      expect(request).not.toHaveBeenCalled();
      expect(saveDownload).not.toHaveBeenCalled();
      expect(save).not.toHaveBeenCalled();
    },
  );

  it("still lets stop release the thread's own Browser", async () => {
    const { tools, releaseThread } = planTools();
    expect((await call(tools, BROWSER_CALL_OF_EACH_OPERATION.stop)).isError).toBe(false);
    expect(releaseThread).toHaveBeenCalledOnce();
  });

  it("runs the reads of a batch and stops at its first step that changes the page", async () => {
    const { tools, act } = planTools();
    const answer = await call(tools, {
      operation: "steps",
      steps: [
        { operation: "snapshot" },
        { operation: "click", ref: "e1" },
        { operation: "snapshot" },
      ],
    });
    expect(act).toHaveBeenCalledOnce();
    expect(answer.result).toMatchObject({
      failedStep: { step: 2, operation: "click", answer: { error: "plan-mode-read-only" } },
    });
  });

  it("still asks the person before another model reads the page, and reads nothing they decline", async () => {
    const { tools, act, request } = planTools({ modelId: "model-b" });
    expect(await call(tools, { operation: "snapshot" })).toEqual({
      result: { error: "browser-approval-denied" },
      isError: true,
    });
    expect(request).toHaveBeenCalledOnce();
    expect(act).not.toHaveBeenCalled();
  });

  it("still refuses a read while the person holds the page", async () => {
    const act = vi.fn(async () => page);
    const held = createBrowserAppManagedTools({
      windowId,
      threadId,
      mode: "work",
      modelId,
      resolveModelId: () => modelId,
      modelBindings: new Map<string, BrowserModelBinding>([
        [contextId, { modelId, authority: planAuthority }],
      ]),
      executionPolicy: "plan",
      resolveAuthority: () => planAuthority,
      browser: {
        inspectThread: () => ({ ...page, waitingForPerson: "sign-in" as const }),
        create: vi.fn(),
        act,
        releaseThread: vi.fn(),
      },
      uuid: () => crypto.randomUUID(),
    });
    expect((await call(held, { operation: "snapshot" })).isError).toBe(true);
    expect(act).not.toHaveBeenCalled();
  });

  it("still refuses a read once the turn's model is no longer the thread's", async () => {
    const act = vi.fn(async () => page);
    const stale = createBrowserAppManagedTools({
      windowId,
      threadId,
      mode: "work",
      modelId,
      resolveModelId: () => "model-b",
      modelBindings: new Map<string, BrowserModelBinding>([
        [contextId, { modelId, authority: planAuthority }],
      ]),
      executionPolicy: "plan",
      resolveAuthority: () => planAuthority,
      browser: { inspectThread: () => page, create: vi.fn(), act, releaseThread: vi.fn() },
      uuid: () => crypto.randomUUID(),
    });
    expect(await call(stale, { operation: "snapshot" })).toEqual({
      result: { error: "browser-model-stale" },
      isError: true,
    });
    expect(act).not.toHaveBeenCalled();
  });
});
