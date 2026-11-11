import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_AGENT_GRANT_LIMITS,
  type AgentGrant,
  type AgentGrantScope,
} from "@octant/contracts";
import type { AuthenticatedProductDispatchHandoff } from "../authenticatedProductRoutes";
import {
  AGENT_ACCESS_ORIGIN,
  createAgentSession,
  guardAgentRequest,
  type AgentSessionDependencies,
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

function deps() {
  const recorded: Array<{ threadId: string; mode: string }> = [];
  const service: AgentSessionDependencies["service"] = {
    threadOwner: (threadId: string) =>
      threadId === ownThread
        ? { threadId, grantId, mode: "code" as const, startedAt: "2026-11-11T10:00:00.000Z" }
        : undefined,
    recordThreadStarted: (input) => {
      recorded.push(input);
    },
    threadsOf: () => [],
    takeTurn: () => true,
  };
  const threadProject = (threadId: string) =>
    threadId === projectThread
      ? { projectId: granted }
      : threadId === strangerThread
        ? { projectId: other }
        : undefined;
  return { service, threadProject, recorded };
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
    const { service, threadProject, recorded } = deps();
    const marked: string[] = [];
    const session = createAgentSession({
      grant: grant(),
      signal: new AbortController().signal,
      deps: {
        service,
        threadProject,
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
