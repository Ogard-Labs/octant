import { WORK_TURN_CAPABILITIES, decodeCancelWorkTurnCommand } from "@octant/contracts";
import { describe, expect, it } from "vitest";
import {
  CODE_THREAD_TURNS,
  agentThreadPort,
  createAgentThread,
  openAgentThreadById,
} from "./agentThread";
import { statusLineFrom } from "./agentTuiModel";
import type { LocalControlRequest, OpenedLocalControlSession } from "./localControl";

const now = "2026-10-09T09:00:00.000Z";
const ids = {
  project: "20000000-0000-4000-8000-000000000001",
  binding: "30000000-0000-4000-8000-000000000001",
  checkout: "40000000-0000-4000-8000-000000000001",
  provider: "50000000-0000-4000-8000-000000000001",
} as const;

function projects(codeAccessPersistence: "current-session" | "project-default"): unknown {
  return {
    active: [
      {
        id: ids.project,
        name: "Repo",
        type: "code",
        lifecycle: "active",
        pinned: false,
        rank: "1/2",
        version: 1,
        createdAt: now,
        updatedAt: now,
        binding: { canonicalRoot: "/home/user/repo" },
        bindingRevisionId: ids.binding,
        codeAccessPersistence,
      },
    ],
    archived: [],
    availability: [],
    memory: [],
  };
}

const providers = {
  instances: [
    {
      id: ids.provider,
      displayName: "Loopback",
      driverKind: "openai-compatible",
      configuration: {
        kind: "openai-compatible-http",
        baseUrl: "http://127.0.0.1:9/v1/",
        authentication: "none",
        protocol: "responses",
        manualModelIds: [],
      },
      enabled: true,
      environmentPolicy: "inherit-host",
      version: 1,
      createdAt: now,
      updatedAt: now,
    },
  ],
  defaults: { permissionPersistence: "current-session", version: 0 },
  observedStates: [
    {
      instanceId: ids.provider,
      readiness: "ready",
      processState: "running",
      models: [
        {
          id: "loopback-model",
          displayName: "Loopback model",
          reasoning: "unavailable",
          inputModalities: ["text"],
          options: [],
          source: "discovered",
          verification: "verified",
        },
      ],
      capabilities: {
        streaming: "supported",
        resume: "unavailable",
        interruption: "supported",
        approvals: "supported",
        userQuestions: "supported",
        reasoning: "unavailable",
        usage: "supported",
        toolActivity: "supported",
        fileChanges: "unavailable",
        diffs: "unavailable",
        taskProgress: "supported",
        nativeChildAgents: "unavailable",
        harnessAutoReview: "unsupported",
        nativeAttachments: "unavailable",
        nativeWebResearch: "unavailable",
        appManagedTools: "supported",
        citations: "unavailable",
      },
      observedAt: now,
    },
  ],
};

/**
 * A loopback host that answers the routes `octant agent` walks to start a
 * Code thread, and records what the terminal asked for.
 */
function host(codeAccessPersistence: "current-session" | "project-default") {
  const seen: LocalControlRequest[] = [];
  const session: OpenedLocalControlSession = {
    kind: "opened",
    windowId: "11111111-1111-4111-8111-111111111111",
    send: async (request) => {
      seen.push(request);
      if (request.path === "/api/projects/bootstrap") {
        return { status: 200, body: projects(codeAccessPersistence) };
      }
      if (request.path === "/api/providers/bootstrap") return { status: 200, body: providers };
      if (request.path === "/api/shell/bootstrap") {
        return { status: 200, body: { workspaceVersion: 1 } };
      }
      if (request.path === "/api/shell/commands") return { status: 200, body: {} };
      const body = request.body as { kind: string; thread?: unknown };
      if (body.kind === "prepare-code-project-checkout") {
        return {
          status: 200,
          body: {
            kind: "checkout-prepared",
            bindingRevisionId: ids.binding,
            checkout: {
              id: ids.checkout,
              repositoryId: `repo_${"a".repeat(64)}`,
              kind: "existing-worktree",
              availability: "available",
              head: { kind: "branch", name: "main", oid: "b".repeat(40) },
              observedAt: now,
            },
          },
        };
      }
      if (body.kind === "create-code-thread") {
        return { status: 200, body: { kind: "thread-created", thread: body.thread } };
      }
      return { status: 404, body: { message: `Unexpected ${request.path}` } };
    },
    close: async () => undefined,
  };
  const created = () =>
    seen.find(
      (request) => (request.body as { kind?: string } | undefined)?.kind === "create-code-thread",
    )?.body as { thread: { executionPolicy: string; permissionPersistence: string } } | undefined;
  return { session, created };
}

describe("starting a Code thread from the terminal", () => {
  it("asks for the Project's remembered Full access, the request the app's composer sends", async () => {
    const fake = host("project-default");

    const result = await createAgentThread(fake.session, {
      mode: "code",
      title: "Run the terminal",
      projectName: "Repo",
    });

    expect(result).toMatchObject({ kind: "created", mode: "code", projectName: "Repo" });
    expect(fake.created()?.thread).toMatchObject({
      executionPolicy: "full-access",
      permissionPersistence: "project-default",
    });
  });

  it("starts approval-gated in a Project that never remembered Full access", async () => {
    const fake = host("current-session");

    const result = await createAgentThread(fake.session, {
      mode: "code",
      title: "Run the terminal",
      projectName: "Repo",
    });

    expect(result).toMatchObject({ kind: "created", mode: "code" });
    expect(fake.created()?.thread).toMatchObject({
      executionPolicy: "approval-gated",
      permissionPersistence: "current-session",
    });
  });
});

const chatThread = {
  id: "60000000-0000-4000-8000-000000000001",
  title: "Plain question",
  lifecycle: "active",
  providerInstanceId: ids.provider,
  modelId: "loopback-model",
  researchEnabled: false,
  researchRouting: "automatic",
  personalityInstructions: "Be brief.",
  version: 1,
  createdAt: now,
  updatedAt: now,
};

/** A host that holds one Chat thread and no Projects, and records the shell commands it is sent. */
function chatHost(
  options: {
    duplicateNames?: boolean;
    refuseSelection?: boolean;
    cold?: boolean;
    refuseProbe?: boolean;
  } = {},
) {
  const probed: string[] = [];
  const commands: unknown[] = [];
  const accountIds = [ids.provider, "50000000-0000-4000-8000-000000000002"];
  const shell: Array<{ mode: string; kind: string }> = [];
  const session: OpenedLocalControlSession = {
    kind: "opened",
    windowId: "11111111-1111-4111-8111-111111111111",
    send: async (request) => {
      if (request.path === "/api/projects/bootstrap") {
        return { status: 200, body: { active: [], archived: [], availability: [], memory: [] } };
      }
      if (request.path === "/api/shell/bootstrap") {
        return { status: 200, body: { workspaceVersion: 1 } };
      }
      if (request.path === "/api/shell/commands") {
        const operation = (
          request.body as { operation: { mode: string; surface: { kind: string } } }
        ).operation;
        shell.push({ mode: operation.mode, kind: operation.surface.kind });
        return { status: 200, body: {} };
      }
      if (request.path === "/api/providers/bootstrap") {
        return {
          status: 200,
          body: {
            ...providers,
            instances: accountIds.map((id, index) => ({
              ...providers.instances[0],
              id,
              driverKind: "codex",
              displayName: options.duplicateNames || index === 0 ? "Subscription" : "API",
              configuration: { kind: "codex-cli", binaryPath: "codex" },
            })),
            observedStates: options.cold
              ? []
              : accountIds.map((instanceId) => ({
                  ...providers.observedStates[0],
                  instanceId,
                })),
          },
        };
      }
      if (request.path.endsWith("/probe") && request.method === "POST") {
        const instanceId = request.path.split("/")[3];
        probed.push(instanceId!);
        return options.refuseProbe
          ? { status: 503, body: { message: "Provider discovery is unavailable." } }
          : { status: 200, body: { ...providers.observedStates[0], instanceId } };
      }
      if (request.path === "/api/chat/commands") {
        commands.push(request.body);
        if ((request.body as { kind: string }).kind === "change-chat-provider") {
          return options.refuseSelection
            ? { status: 409, body: { message: "The selected account is unavailable." } }
            : { status: 200, body: { kind: "thread-updated", thread: chatThread } };
        }
        return { status: 200, body: { kind: "thread-created", thread: chatThread } };
      }
      if (request.path === `/api/chat/threads/${chatThread.id}`) {
        return {
          status: 200,
          body: {
            thread: chatThread,
            turns: [],
            lastSequence: 1,
            contents: [],
            attachments: [],
            citations: [],
            workItems: [],
            workListVersion: 0,
            followUpVersion: 0,
          },
        };
      }
      return { status: 404, body: { message: `Unexpected ${request.path}` } };
    },
    close: async () => undefined,
  };
  return { session, shell, commands, probed };
}

describe("a Chat thread in the terminal's window", () => {
  it("waits for cold provider discovery before selecting an account", async () => {
    const fake = chatHost({ cold: true });
    expect(
      await createAgentThread(fake.session, {
        mode: "chat",
        title: "Cold account",
        model: "API/loopback-model",
      }),
    ).toMatchObject({ kind: "created" });
    expect(fake.probed).toHaveLength(2);
    expect(fake.commands.at(-1)).toMatchObject({
      kind: "change-chat-provider",
      providerInstanceId: "50000000-0000-4000-8000-000000000002",
    });
  });

  it("refuses a model shared by accounts after cold discovery", async () => {
    const fake = chatHost({ cold: true });
    expect(
      await createAgentThread(fake.session, {
        mode: "chat",
        title: "Ambiguous cold account",
        model: "loopback-model",
      }),
    ).toMatchObject({ kind: "refused" });
    expect(fake.probed).toHaveLength(2);
    expect(fake.commands).toEqual([]);
  });

  it("does not create a thread when cold discovery fails", async () => {
    const fake = chatHost({ cold: true, refuseProbe: true });
    expect(
      await createAgentThread(fake.session, {
        mode: "chat",
        title: "Unavailable cold account",
        model: "API/loopback-model",
      }),
    ).toMatchObject({ kind: "refused" });
    expect(fake.probed.length).toBeGreaterThan(0);
    expect(fake.commands).toEqual([]);
  });

  it("selects the requested CLI account before returning a new Chat thread", async () => {
    const fake = chatHost();
    expect(
      await createAgentThread(fake.session, {
        mode: "chat",
        title: "Account selection",
        model: "API/loopback-model",
      }),
    ).toMatchObject({ kind: "created", mode: "chat" });
    expect(fake.commands).toEqual([
      { kind: "create-chat-thread", title: "Account selection" },
      {
        kind: "change-chat-provider",
        threadId: chatThread.id,
        expectedVersion: 1,
        providerInstanceId: "50000000-0000-4000-8000-000000000002",
        modelId: "loopback-model",
      },
    ]);
  });

  it.each([
    ["missing", false],
    ["loopback-model", false],
    ["Subscription/loopback-model", true],
  ])(
    "refuses an unknown or ambiguous selection %s before creating a Chat thread",
    async (model, duplicateNames) => {
      const fake = chatHost({ duplicateNames });
      expect(
        await createAgentThread(fake.session, { mode: "chat", title: "No inference", model }),
      ).toMatchObject({ kind: "refused" });
      expect(fake.commands).toEqual([]);
    },
  );

  it("does not return a sendable thread when the host refuses the account change", async () => {
    const fake = chatHost({ refuseSelection: true });
    expect(
      await createAgentThread(fake.session, {
        mode: "chat",
        title: "No fallback",
        model: "API/loopback-model",
      }),
    ).toEqual({ kind: "refused", message: "The selected account is unavailable." });
    expect(fake.shell).toEqual([]);
  });

  it("is open in the window once the terminal creates it, so its harness session answers", async () => {
    const fake = chatHost();
    const result = await createAgentThread(fake.session, {
      mode: "chat",
      title: "Plain question",
    });
    expect(result).toMatchObject({ kind: "created", mode: "chat", threadId: chatThread.id });
    expect(fake.shell).toEqual([{ mode: "chat", kind: "chat-thread" }]);
  });

  it("is opened for a bare thread id that no Work or Code Project holds", async () => {
    const fake = chatHost();
    expect(await openAgentThreadById(fake.session, chatThread.id)).toEqual({ kind: "opened" });
    expect(fake.shell).toEqual([{ mode: "chat", kind: "chat-thread" }]);
    expect(await openAgentThreadById(fake.session, "no-such-thread")).toMatchObject({
      kind: "refused",
    });
  });
});

/** A Chat thread whose newest turn is parked on the lead's question. */
function chatViewParkedOnQuestion(version = 7, outcome: "waiting" | "completed" = "waiting") {
  const digest = "a".repeat(64);
  const turnId = "61000000-0000-4000-8000-000000000001";
  const attemptId = "62000000-0000-4000-8000-000000000001";
  return {
    thread: { ...chatThread, version },
    turns: [
      {
        id: turnId,
        threadId: chatThread.id,
        sequence: 1,
        userMessageRef: {
          contentId: "63000000-0000-4000-8000-000000000001",
          digest,
          byteLength: 4,
        },
        attachmentIds: [],
        attempts: [
          {
            id: attemptId,
            turnId,
            threadId: chatThread.id,
            providerInstanceId: ids.provider,
            providerSessionId: "64000000-0000-4000-8000-000000000001",
            modelId: "loopback-model",
            contextManifestId: "65000000-0000-4000-8000-000000000001",
            outcome,
            responseRefs: [],
            citationIds: [],
            ...(outcome === "waiting"
              ? {
                  pendingQuestion: {
                    requestId: "call_1",
                    prompt: "Which database?",
                    options: [{ label: "sqlite" }, { label: "postgres" }],
                  },
                }
              : {}),
            createdAt: now,
            updatedAt: now,
          },
        ],
        createdAt: now,
      },
    ],
    lastSequence: 2,
    contents: [
      {
        contentId: "63000000-0000-4000-8000-000000000001",
        role: "user",
        body: "plan",
        digest,
        byteLength: 4,
      },
    ],
    attachments: [],
    citations: [],
    workItems: [],
    workListVersion: 0,
    followUpVersion: 0,
  };
}

describe("a Chat lead's question in the terminal", () => {
  function questionHost(view: () => unknown) {
    const sent: LocalControlRequest[] = [];
    const session: OpenedLocalControlSession = {
      kind: "opened",
      windowId: "11111111-1111-4111-8111-111111111111",
      send: async (request) => {
        sent.push(request);
        if (request.path === `/api/chat/threads/${chatThread.id}`) {
          return { status: 200, body: view() };
        }
        if (request.path === "/api/chat/commands") {
          return { status: 200, body: { kind: "attempt-updated", attempt: {} } };
        }
        return { status: 404, body: {} };
      },
      close: async () => undefined,
    };
    return { session, sent };
  }

  it("is read from the turn's attempt while it waits for the answer", async () => {
    const host = questionHost(() => chatViewParkedOnQuestion());
    const snapshot = await agentThreadPort(host.session, "chat", chatThread.id).read();
    expect(snapshot?.pendingQuestion).toEqual({
      id: "call_1",
      prompt: "Which database?",
      options: ["sqlite", "postgres"],
    });
  });

  it("carries what each option means when the provider gave it", async () => {
    const parked = chatViewParkedOnQuestion();
    const attempt = parked.turns[0]!.attempts[0] as unknown as {
      pendingQuestion: { options: Array<{ label: string; description?: string }> };
    };
    attempt.pendingQuestion.options = [
      { label: "A", description: "keep the schema" },
      { label: "B" },
    ];
    const host = questionHost(() => parked);
    const snapshot = await agentThreadPort(host.session, "chat", chatThread.id).read();
    expect(snapshot?.pendingQuestion).toEqual({
      id: "call_1",
      prompt: "Which database?",
      options: ["A", "B"],
      descriptions: ["keep the schema", undefined],
    });
  });

  it("is not offered once the attempt has moved on", async () => {
    const host = questionHost(() => chatViewParkedOnQuestion(8, "completed"));
    const snapshot = await agentThreadPort(host.session, "chat", chatThread.id).read();
    expect(snapshot?.pendingQuestion).toBeUndefined();
  });

  it("is answered with the command the app's transcript card sends, against the thread's current version", async () => {
    const host = questionHost(() => chatViewParkedOnQuestion(9));
    const port = agentThreadPort(host.session, "chat", chatThread.id);
    const snapshot = await port.read();
    const result = await port.answerQuestion?.(snapshot!.pendingQuestion!, "sqlite");
    expect(result).toEqual({ kind: "answered" });
    expect(host.sent.at(-1)).toMatchObject({
      path: "/api/chat/commands",
      method: "POST",
      body: {
        kind: "answer-chat-turn-question",
        threadId: chatThread.id,
        expectedVersion: 9,
        turnId: "61000000-0000-4000-8000-000000000001",
        attemptId: "62000000-0000-4000-8000-000000000001",
        requestId: "call_1",
        answer: "sqlite",
      },
    });
  });

  it("refuses an answer once the question was answered elsewhere, sending nothing", async () => {
    let answered = false;
    const host = questionHost(() =>
      answered ? chatViewParkedOnQuestion(10, "completed") : chatViewParkedOnQuestion(9),
    );
    const port = agentThreadPort(host.session, "chat", chatThread.id);
    const question = (await port.read())!.pendingQuestion!;
    answered = true;
    expect(await port.answerQuestion?.(question, "sqlite")).toMatchObject({
      kind: "refused",
      message: "That question is no longer open.",
    });
    expect(host.sent.some((request) => request.path === "/api/chat/commands")).toBe(false);
  });
});

describe("Code threads in the terminal", () => {
  const threadId = "84000000-0000-4000-8000-000000000001";
  const threadView = {
    thread: {
      id: threadId,
      projectId: ids.project,
      bindingRevisionId: ids.binding,
      repositoryId: `repo_${"a".repeat(64)}`,
      checkoutId: ids.checkout,
      title: "Long thread",
      lifecycle: "active",
      providerInstanceId: ids.provider,
      modelId: "loopback-model",
      executionPolicy: "approval-gated",
      permissionPersistence: "current-session",
      deliveryTarget: {
        branchIntent: "long-thread",
        remoteName: "origin",
        proposedBaseRepository: "acme/app",
        proposedBaseBranch: "main",
        outcomeKind: "local-implementation",
        confirmedAt: now,
      },
      version: 1,
      createdAt: now,
      updatedAt: now,
    },
    checkout: {
      id: ids.checkout,
      repositoryId: `repo_${"a".repeat(64)}`,
      kind: "existing-worktree",
      availability: "available",
      head: { kind: "branch", name: "main", oid: "b".repeat(40) },
      observedAt: now,
    },
    lastSequence: 1,
  };
  const numbered = (index: number) => `${String(index).padStart(12, "0")}`;
  const turn = (index: number) => ({
    operationId: `86000000-0000-4000-8000-${numbered(index)}`,
    providerInstanceId: ids.provider,
    modelId: "loopback-model",
    sessionId: "89000000-0000-4000-8000-000000000001",
    prompt: {
      contentId: `87000000-0000-4000-8000-${numbered(index)}`,
      digest: "c".repeat(64),
      byteLength: 8,
    },
    assistant: [],
    status: "completed",
    startedAt: now,
    updatedAt: now,
  });

  /** A host holding `count()` turns, with or without the window read. */
  function longThreadHost(count: () => number, window: boolean) {
    const paths: string[] = [];
    const conversation = `/api/code/threads/${threadId}/conversation`;
    const session: OpenedLocalControlSession = {
      kind: "opened",
      windowId: "11111111-1111-4111-8111-111111111111",
      send: async (request) => {
        paths.push(request.path);
        const total = count();
        // Only the asked-for run is built, so a very long thread stays cheap.
        const turns = (from: number, to: number) =>
          Array.from({ length: Math.max(0, Math.min(to, total) - from) }, (_, index) =>
            turn(from + index + 1),
          );
        const [path = "", query = ""] = request.path.split("?");
        const params = new URLSearchParams(query);
        if (path === `/api/code/threads/${threadId}`) return { status: 200, body: threadView };
        if (window && path === `${conversation}/window`) {
          const limit = Number(params.get("limit"));
          return {
            status: 200,
            body: {
              version: 1,
              threadId,
              turns: turns(Math.max(0, total - limit), total),
              hasEarlier: total > limit,
              hasLater: false,
            },
          };
        }
        if (path === conversation) {
          const after = Number(params.get("afterCursor"));
          const page = turns(after, after + Number(params.get("limit")));
          return {
            status: 200,
            body: {
              version: 3,
              threadId,
              turns: page,
              nextCursor: after + page.length,
              hasMore: after + page.length < total,
            },
          };
        }
        if (path === "/api/code/evidence/batch") {
          const { items } = request.body as {
            items: Array<{ operationId: string; contentId: string }>;
          };
          return {
            status: 200,
            body: {
              threadId,
              items: items.map((item) => ({
                ...item,
                text: `prompt-${Number(item.contentId.slice(-12))}`,
              })),
            },
          };
        }
        return { status: 404, body: { message: `Unexpected ${request.path}` } };
      },
      close: async () => undefined,
    };
    return { session, paths };
  }

  const expectedPrompts = (total: number) =>
    Array.from(
      { length: CODE_THREAD_TURNS },
      (_, index) => `prompt-${total - CODE_THREAD_TURNS + index + 1}`,
    );

  function interruptHost(
    reply: (request: LocalControlRequest) => unknown,
    running = true,
  ): OpenedLocalControlSession {
    const base = longThreadHost(() => 0, true).session;
    return {
      ...base,
      send: async (request) => {
        if (request.path.includes("/conversation/window")) {
          return {
            status: 200,
            body: {
              version: 1,
              threadId,
              turns: running ? [{ ...turn(1), status: "incomplete" }] : [],
              hasEarlier: false,
              hasLater: false,
            },
          };
        }
        if (request.path === "/api/code/commands") {
          return { status: 200, body: reply(request) };
        }
        return base.send(request);
      },
    };
  }

  it("stops a running turn without replaying its start or an earlier stop", async () => {
    const commands: unknown[] = [];
    const session = interruptHost((request) => {
      const command = request.body as { operationId: string };
      commands.push(request.body);
      // The host replays an operation's original result when its ID is reused.
      return {
        kind: "provider-turn-state",
        operationId: command.operationId,
        state: command.operationId === turn(1).operationId ? "running" : "interrupted",
      };
    });
    const port = agentThreadPort(session, "code", threadId);
    await expect(port.interrupt()).resolves.toEqual({ kind: "interrupted" });
    await expect(port.interrupt()).resolves.toEqual({ kind: "interrupted" });
    expect(commands).toHaveLength(2);
    expect(commands[0]).toMatchObject({
      kind: "cancel-provider-turn",
      threadId,
      checkoutId: ids.checkout,
      operationId: expect.not.stringMatching(turn(1).operationId),
    });
    expect(commands[0]).not.toEqual(commands[1]);
  });

  it.each([
    { kind: "provider-turn-state", state: "running" },
    {
      kind: "provider-turn-state",
      state: "failed",
      failure: { category: "unavailable", message: "The checkout is unavailable." },
    },
    { kind: "operation-accepted" },
    {
      kind: "operation-failed",
      failure: { category: "unavailable", message: "The checkout is unavailable." },
    },
  ])("does not report a stopped turn when the host replies $kind $state", async (result) => {
    const session = interruptHost((request) => ({
      ...result,
      operationId: (request.body as { operationId: string }).operationId,
    }));
    await expect(agentThreadPort(session, "code", threadId).interrupt()).resolves.toMatchObject({
      kind: "refused",
    });
  });

  it("reports nothing running when the turn finishes before its stop arrives", async () => {
    const session = interruptHost((request) => ({
      kind: "provider-turn-state",
      operationId: (request.body as { operationId: string }).operationId,
      state: "failed",
    }));
    await expect(agentThreadPort(session, "code", threadId).interrupt()).resolves.toEqual({
      kind: "nothing-running",
    });
  });

  it("does not report another operation's interruption as this stop", async () => {
    const session = interruptHost(() => ({
      kind: "provider-turn-state",
      state: "interrupted",
      operationId: turn(1).operationId,
    }));
    await expect(agentThreadPort(session, "code", threadId).interrupt()).resolves.toMatchObject({
      kind: "refused",
    });
  });

  it("does not send a stop when the conversation has no running turn", async () => {
    const session = interruptHost(() => {
      throw new Error("No cancellation should be sent.");
    }, false);
    await expect(agentThreadPort(session, "code", threadId).interrupt()).resolves.toEqual({
      kind: "nothing-running",
    });
  });

  it("shows the newest turns of a thread longer than one page and says earlier ones exist", async () => {
    const fake = longThreadHost(() => 130, true);

    const snapshot = await agentThreadPort(fake.session, "code", threadId).read();

    expect(snapshot?.turns.map((entry) => entry.prompt)).toEqual(expectedPrompts(130));
    expect(snapshot?.hasEarlier).toBe(true);
    expect(statusLineFrom(snapshot, undefined)).toBe(
      `loopback-model · newest ${CODE_THREAD_TURNS} turns`,
    );
    expect(fake.paths).toContain(
      `/api/code/threads/${threadId}/conversation/window?limit=${CODE_THREAD_TURNS}`,
    );
    expect(fake.paths.some((path) => path.includes("/conversation?"))).toBe(false);
  });

  it("shows the tail of the forward read on a host without the window read", async () => {
    // Three forward pages, the last holding exactly the shown tail.
    let total = 250;
    const fake = longThreadHost(() => total, false);
    const port = agentThreadPort(fake.session, "code", threadId);

    const first = await port.read();
    expect(first?.turns.map((entry) => entry.prompt)).toEqual(expectedPrompts(250));
    expect(first?.hasEarlier).toBe(true);

    // A new turn lands; the next read starts where the shown tail began and
    // never asks for the window again.
    total = 251;
    fake.paths.length = 0;
    const second = await port.read();
    expect(second?.turns.map((entry) => entry.prompt)).toEqual(expectedPrompts(251));
    expect(fake.paths.some((path) => path.includes("/window"))).toBe(false);
    expect(fake.paths.some((path) => path.includes("afterCursor=0&"))).toBe(false);
  });

  it("shows nothing rather than an older run when the forward walk stops at its page bound", async () => {
    // One hundred forward pages of 100 turns stop short of the newest 50.
    const fake = longThreadHost(() => 10_050, false);
    const port = agentThreadPort(fake.session, "code", threadId);

    await expect(port.read()).resolves.toBeUndefined();

    // The next read continues from where the cut-off walk got to.
    const next = await port.read();
    expect(next?.turns.map((entry) => entry.prompt)).toEqual(expectedPrompts(10_050));
    expect(next?.hasEarlier).toBe(true);
  });
});

describe("stopping a Work turn from the terminal", () => {
  const workThread = "c0000000-0000-4000-8000-000000000001";
  const request = "a0000000-0000-4000-8000-000000000001";
  const turn = "b0000000-0000-4000-8000-000000000001";

  it("sends the turn id the host requires, and the host stops the running turn", async () => {
    const cancelled: unknown[] = [];
    const session: OpenedLocalControlSession = {
      kind: "opened",
      windowId: "11111111-1111-4111-8111-111111111111",
      send: async (call) => {
        if (call.path === `/api/work/turns/transcript/${workThread}`) {
          return {
            status: 200,
            body: {
              threadId: workThread,
              turns: [
                {
                  requestId: request,
                  threadId: workThread,
                  turnId: turn,
                  projectId: ids.project,
                  authority: {
                    hostId: "local",
                    projectId: ids.project,
                    bindingRevisionId: ids.binding,
                    workingDirectory: ".",
                    confinementPosture: "project-root-confined",
                    providerInstanceId: ids.provider,
                    modelId: "loopback-model",
                  },
                  status: "running",
                  prompt: "Open the fixture",
                  transcript: [{ role: "user", text: "Open the fixture" }],
                  capabilities: WORK_TURN_CAPABILITIES,
                  version: 1,
                  acceptedAt: now,
                  updatedAt: now,
                },
              ],
            },
          };
        }
        if (call.path === "/api/work/turns/cancel") {
          // The host decodes the command strictly; a command it cannot decode
          // is refused as an unavailable service.
          try {
            cancelled.push(decodeCancelWorkTurnCommand(call.body));
          } catch {
            return { status: 503, body: { message: "Octant Work turn service is unavailable." } };
          }
          return { status: 200, body: { kind: "turn-cancelled" } };
        }
        return { status: 404, body: { message: `Unexpected ${call.path}` } };
      },
      close: async () => undefined,
    };

    const outcome = await agentThreadPort(session, "work", workThread).interrupt();

    expect(outcome).toEqual({ kind: "interrupted" });
    expect(cancelled).toEqual([
      { kind: "cancel-work-turn", requestId: request, threadId: workThread, turnId: turn },
    ]);
  });
});
