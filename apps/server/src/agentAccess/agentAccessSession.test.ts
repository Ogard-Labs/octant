import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_AGENT_GRANT_LIMITS,
  type AgentGrant,
  type AgentGrantScope,
} from "@octant/contracts";
import type { AuthenticatedProductDispatchHandoff } from "../authenticatedProductRoutes";
import {
  AGENT_ACCESS_ORIGIN,
  agentToolPolicy,
  createAgentSession,
  guardAgentRequest,
  type AgentSessionDependencies,
  type AgentThreadAccess,
} from "./agentAccessSession";

const grantId = "10000000-0000-4000-8000-000000000001";
const scopeId = "10000000-0000-4000-8000-0000000000aa";
const granted = "20000000-0000-4000-8000-000000000001";
const other = "20000000-0000-4000-8000-000000000002";
const ownThread = "30000000-0000-4000-8000-000000000001";
const strangerThread = "30000000-0000-4000-8000-000000000002";
const projectThread = "30000000-0000-4000-8000-000000000003";

function grant(overrides: Partial<AgentGrantScope> = {}): AgentGrant {
  return {
    grantId: grantId as AgentGrant["grantId"],
    scopeId: scopeId as AgentGrant["scopeId"],
    name: "Bot",
    scope: {
      projects: [granted as AgentGrantScope["projects"][number]],
      modes: ["code", "work"],
      highestLevel: "ask-first",
      threads: "own",
      tools: ["start_work", "read_thread"],
      limits: DEFAULT_AGENT_GRANT_LIMITS,
      direct: false,
      ...overrides,
    },
    state: "active",
    generation: 1,
    keys: [],
    createdAt: "2026-11-11T10:00:00.000Z" as AgentGrant["createdAt"],
    expiresAt: "2026-12-11T10:00:00.000Z" as AgentGrant["expiresAt"],
  };
}

const autoThread = "30000000-0000-4000-8000-000000000004";

function deps() {
  const recorded: Array<{ threadId: string; mode: string }> = [];
  let starting = 0;
  const service: AgentSessionDependencies["service"] = {
    threadOwner: (threadId: string) =>
      threadId === ownThread || threadId === autoThread
        ? { threadId, grantId, mode: "code" as const, startedAt: "2026-11-11T10:00:00.000Z" }
        : undefined,
    recordThreadStarted: (input) => {
      recorded.push(input);
    },
    threadsOf: () => [],
    takeTurn: () => true,
    holdTurnStart: () => {
      const startingAlready = starting;
      starting += 1;
      return { startingAlready, release: () => (starting -= 1) };
    },
  };
  const threadProject = (threadId: string) =>
    threadId === projectThread || threadId === ownThread || threadId === autoThread
      ? { projectId: granted }
      : threadId === strangerThread
        ? { projectId: other }
        : undefined;
  // The agent's own thread at Ask first, another it made at Auto.
  const threadAccess = (threadId: string): AgentThreadAccess | undefined =>
    threadId === strangerThread || threadId === projectThread || threadId === ownThread
      ? {
          kind: "code",
          executionPolicy: "approval-gated",
          autoApprove: false,
          fullAccessSandbox: false,
        }
      : threadId === autoThread
        ? {
            kind: "code",
            executionPolicy: "approval-gated",
            autoApprove: true,
            fullAccessSandbox: false,
          }
        : undefined;
  return { service, threadProject, threadAccess, recorded };
}

const guard = (
  request: Parameters<typeof guardAgentRequest>[0]["request"],
  overrides: Partial<AgentGrantScope> = {},
) => guardAgentRequest({ grant: grant(overrides), request, deps: deps() }).kind;

describe("the agent grant guard", () => {
  it("refuses every approval route, whatever thread it names", () => {
    expect(
      guard({
        path: `/api/native-harness/sessions/${ownThread}/approvals`,
        method: "POST",
        body: {},
      }),
    ).toBe("refused");
    expect(guard({ path: "/api/extensions/tool-approvals", method: "POST", body: {} })).toBe(
      "refused",
    );
  });

  it("refuses remembering Full access on a Project and every other Project command", () => {
    expect(
      guard({
        path: "/api/projects/commands",
        method: "POST",
        body: { kind: "change-code-project-access", projectId: granted },
      }),
    ).toBe("refused");
  });

  it("starts a Code thread only in a granted Project and only at or below the grant's level", () => {
    const create = (thread: Record<string, unknown>) =>
      guard({
        path: "/api/code/commands",
        method: "POST",
        body: { kind: "create-code-thread", thread },
      });
    const base = {
      id: "t",
      projectId: granted,
      modelId: "m",
      permissionPersistence: "current-session",
    };
    expect(create({ ...base, executionPolicy: "approval-gated" })).toBe("allowed");
    expect(create({ ...base, executionPolicy: "plan" })).toBe("allowed");
    expect(create({ ...base, executionPolicy: "full-access" })).toBe("refused");
    expect(create({ ...base, executionPolicy: "approval-gated", autoApprove: true })).toBe(
      "refused",
    );
    expect(create({ ...base, executionPolicy: "auto-accept-edits" })).toBe("refused");
    expect(
      create({
        ...base,
        executionPolicy: "approval-gated",
        permissionPersistence: "project-default",
      }),
    ).toBe("refused");
    expect(create({ ...base, projectId: other, executionPolicy: "approval-gated" })).toBe(
      "refused",
    );
    expect(
      guard(
        {
          path: "/api/code/commands",
          method: "POST",
          body: {
            kind: "create-code-thread",
            thread: { ...base, executionPolicy: "approval-gated", autoApprove: true },
          },
        },
        { highestLevel: "auto" },
      ),
    ).toBe("allowed");
  });

  it("reaches only its own threads, or its Projects' threads when the grant says so", () => {
    const read = (threadId: string, threads: "own" | "project" = "own") =>
      guard({ path: `/api/code/threads/${threadId}`, method: "GET" }, { threads });
    expect(read(ownThread)).toBe("allowed");
    expect(read(projectThread)).toBe("refused");
    expect(read(projectThread, "project")).toBe("allowed");
    expect(read(strangerThread, "project")).toBe("refused");
    expect(
      guard({
        path: "/api/code/commands",
        method: "POST",
        body: { kind: "start-provider-turn", threadId: strangerThread },
      }),
    ).toBe("refused");
  });

  it("refuses a mode, a tool, a model, or a route the grant does not name", () => {
    expect(
      guard({ path: "/api/chat/commands", method: "POST", body: { kind: "create-chat-thread" } }),
    ).toBe("refused");
    expect(
      guard({
        path: `/api/native-harness/sessions/${ownThread}/questions`,
        method: "POST",
        body: {},
      }),
    ).toBe("refused");
    expect(
      guard(
        {
          path: "/api/work/threads/commands",
          method: "POST",
          body: { kind: "create-work-thread", projectId: granted, modelId: "other-model" },
        },
        { models: ["fake-model"] },
      ),
    ).toBe("refused");
    expect(guard({ path: "/api/secret-stores", method: "GET" })).toBe("refused");
    expect(guard({ path: "/api/shell/bootstrap", method: "POST" })).toBe("refused");
  });
});

describe("an agent session", () => {
  it("dispatches as a paired-device principal with the grant's scope id and keeps refused requests from routes", async () => {
    const seen: AuthenticatedProductDispatchHandoff[] = [];
    const { service, threadProject, threadAccess, recorded } = deps();
    const marked: string[] = [];
    const session = createAgentSession({
      grant: grant(),
      signal: new AbortController().signal,
      deps: {
        service,
        threadProject,
        threadAccess,
        hostId: () => "40000000-0000-4000-8000-000000000001",
        markOutsideContent: (threadId) => marked.push(threadId),
        dispatch: vi.fn(async (handoff: AuthenticatedProductDispatchHandoff) => {
          seen.push(handoff);
          return Response.json({ kind: "thread-created" });
        }),
      },
    });

    const refused = await session.send({
      path: `/api/native-harness/sessions/${ownThread}/approvals`,
      method: "POST",
      body: { approvalId: "a", decision: "approve" },
    });
    expect(refused.status).toBe(403);
    expect(seen).toEqual([]);

    const created = await session.send({
      path: "/api/code/commands",
      method: "POST",
      body: {
        kind: "create-code-thread",
        thread: {
          id: "50000000-0000-4000-8000-000000000001",
          projectId: granted,
          modelId: "m",
          executionPolicy: "approval-gated",
          permissionPersistence: "current-session",
        },
      },
    });
    expect(created.status).toBe(200);
    expect(seen[0]?.principal).toMatchObject({
      kind: "remote-device",
      deviceId: scopeId,
      origin: AGENT_ACCESS_ORIGIN,
    });
    // The new thread is this agent's from the moment it exists, and marked.
    expect(recorded).toEqual([
      expect.objectContaining({ threadId: "50000000-0000-4000-8000-000000000001", mode: "code" }),
    ]);
    expect(marked).toEqual(["50000000-0000-4000-8000-000000000001"]);
  });
});

describe("a grant that narrows after the agent made threads", () => {
  it("takes the agent's own threads out with a Project or mode removed from the grant", () => {
    const read = { path: `/api/code/threads/${ownThread}`, method: "GET" as const };
    expect(guard(read)).toBe("allowed");
    expect(guard(read, { projects: [] })).toBe("refused");
    expect(guard(read, { modes: ["work"] })).toBe("refused");
  });

  it("refuses a turn on a thread the agent made at Auto once the grant allows only Ask first", () => {
    const start = (threadId: string, highestLevel: AgentGrantScope["highestLevel"]) =>
      guard(
        {
          path: "/api/code/commands",
          method: "POST",
          body: { kind: "start-provider-turn", threadId },
        },
        { highestLevel },
      );
    expect(start(autoThread, "auto")).toBe("allowed");
    expect(start(autoThread, "ask-first")).toBe("refused");
    expect(start(ownThread, "ask-first")).toBe("allowed");
  });
});

describe("prompts an outside agent sends", () => {
  it("marks an existing thread as outside content before the prompt reaches it", async () => {
    const { service, threadProject, threadAccess } = deps();
    const order: string[] = [];
    const session = createAgentSession({
      grant: grant({ threads: "project" }),
      signal: new AbortController().signal,
      deps: {
        service,
        threadProject,
        threadAccess,
        hostId: () => "40000000-0000-4000-8000-000000000001",
        markOutsideContent: (threadId) => order.push(`marked ${threadId}`),
        dispatch: async () => {
          order.push("sent");
          return Response.json({});
        },
      },
    });
    await session.send({
      path: "/api/code/commands",
      method: "POST",
      body: { kind: "start-provider-turn", threadId: projectThread },
    });
    expect(order).toEqual([`marked ${projectThread}`, "sent"]);
  });

  it("sends nothing when the mark cannot be recorded", async () => {
    const { service, threadProject, threadAccess } = deps();
    const dispatch = vi.fn(async () => Response.json({}));
    const session = createAgentSession({
      grant: grant(),
      signal: new AbortController().signal,
      deps: {
        service,
        threadProject,
        threadAccess,
        hostId: () => "40000000-0000-4000-8000-000000000001",
        markOutsideContent: () => {
          throw new Error("store unavailable");
        },
        dispatch,
      },
    });
    const answer = await session.send({
      path: "/api/code/commands",
      method: "POST",
      body: { kind: "start-provider-turn", threadId: ownThread },
    });
    expect(answer.status).toBe(503);
    expect(dispatch).not.toHaveBeenCalled();
  });
});

describe("the running-turn limit", () => {
  it("counts a turn that is still starting, so two started at once cannot both pass a limit of one", async () => {
    const { service, threadProject } = deps();
    const policy = agentToolPolicy(
      grant({ limits: { ...DEFAULT_AGENT_GRANT_LIMITS, runningTurns: 1 } }),
      { service, threadProject },
    );
    const session = {} as Parameters<typeof policy.beforeTurn>[0];
    const [first, second] = await Promise.all([
      policy.beforeTurn(session),
      policy.beforeTurn(session),
    ]);
    expect([first.kind, second.kind].sort()).toEqual(["admitted", "refused"]);
    if (first.kind === "admitted") first.release();
    if (second.kind === "admitted") second.release();
    expect((await policy.beforeTurn(session)).kind).toBe("admitted");
  });
});
