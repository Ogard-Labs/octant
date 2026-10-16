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
function chatHost() {
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
      if (request.path === "/api/chat/commands") {
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
  return { session, shell };
}

describe("a Chat thread in the terminal's window", () => {
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

describe("reading a long Code thread in the terminal", () => {
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
