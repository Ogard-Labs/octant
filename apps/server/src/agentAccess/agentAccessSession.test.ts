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
const chatThread = "30000000-0000-4000-8000-000000000005";
const turnKey = "60000000-0000-4000-8000-000000000001";
const otherModelThread = "30000000-0000-4000-8000-000000000006";
const workThread = "30000000-0000-4000-8000-000000000007";

function deps() {
  const recorded: Array<{ threadId: string; mode: string }> = [];
  const turned: Array<{ threadId: string; mode: string }> = [];
  const sentTurns: Array<{ threadId: string; turnKey: string }> = [];
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
    noteTurnThread: (_grantId, threadId, mode) => {
      turned.push({ threadId, mode });
    },
    turnThreadsOf: () => [],
    recordTurnSent: (input) => {
      sentTurns.push({ threadId: input.threadId, turnKey: input.turnKey });
    },
    holdTurnStart: () => {
      const startingAlready = starting;
      starting += 1;
      return { startingAlready, release: () => (starting -= 1) };
    },
  };
  const threadProject = (threadId: string) =>
    threadId === projectThread ||
    threadId === ownThread ||
    threadId === autoThread ||
    threadId === chatThread ||
    threadId === workThread ||
    threadId === otherModelThread
      ? { projectId: granted }
      : threadId === strangerThread
        ? { projectId: other }
        : undefined;
  // The agent's own thread at Ask first, another it made at Auto, the
  // person's Chat thread in the granted Project, and a thread on another model.
  const askFirst = {
    kind: "code" as const,
    modelId: "fake-model",
    executionPolicy: "approval-gated",
    autoApprove: false,
    fullAccessSandbox: false,
  };
  const threadAccess = (threadId: string): AgentThreadAccess | undefined =>
    threadId === strangerThread || threadId === projectThread || threadId === ownThread
      ? askFirst
      : threadId === autoThread
        ? { ...askFirst, autoApprove: true }
        : threadId === chatThread
          ? { kind: "chat", modelId: "fake-model" }
          : threadId === otherModelThread
            ? { ...askFirst, modelId: "other-model" }
            : threadId === workThread
              ? {
                  kind: "work",
                  modelId: "fake-model",
                  access: "ask-first",
                  fullAccessSandbox: false,
                }
              : undefined;
  return { service, threadProject, threadAccess, recorded, turned, sentTurns };
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

  it("runs at Full access only when the person chose Full access for the grant, and never remembers it on a Project", () => {
    const thread = {
      id: "t",
      projectId: granted,
      modelId: "m",
      permissionPersistence: "current-session",
      executionPolicy: "full-access",
    };
    const createCode = (overrides: Record<string, unknown>, scope: Partial<AgentGrantScope>) =>
      guard(
        {
          path: "/api/code/commands",
          method: "POST",
          body: { kind: "create-code-thread", thread: { ...thread, ...overrides } },
        },
        scope,
      );
    const raiseWork = (scope: Partial<AgentGrantScope>) =>
      guard(
        {
          path: "/api/work/threads/commands",
          method: "POST",
          body: { kind: "change-work-thread-access", threadId: ownThread, access: "full-access" },
        },
        scope,
      );

    expect(createCode({}, { highestLevel: "full-access" })).toBe("allowed");
    expect(createCode({ fullAccessSandbox: true }, { highestLevel: "full-access" })).toBe(
      "allowed",
    );
    expect(raiseWork({ highestLevel: "full-access" })).toBe("allowed");
    // Every lower level still stops below Full access.
    expect(createCode({}, { highestLevel: "auto" })).toBe("refused");
    expect(createCode({ fullAccessSandbox: true }, { highestLevel: "auto" })).toBe("refused");
    expect(raiseWork({ highestLevel: "auto" })).toBe("refused");
    // Remembering it on the Project is administration, which no grant holds.
    expect(
      createCode({ permissionPersistence: "project-default" }, { highestLevel: "full-access" }),
    ).toBe("refused");
    expect(
      guard(
        {
          path: "/api/projects/commands",
          method: "POST",
          body: { kind: "change-code-project-access", projectId: granted },
        },
        { highestLevel: "full-access" },
      ),
    ).toBe("refused");
    // Approvals, terminals, and the host Browser stay off the grant's list.
    for (const path of [
      "/api/extensions/tool-approvals",
      "/api/code/project-terminals",
      "/api/browser/actions",
      "/api/extensions/lifecycle",
    ]) {
      expect(guard({ path, method: "POST", body: {} }, { highestLevel: "full-access" })).toBe(
        "refused",
      );
    }
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
        body: { kind: "start-provider-turn", operationId: turnKey, threadId: strangerThread },
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
          body: { kind: "start-provider-turn", operationId: turnKey, threadId },
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
      body: { kind: "start-provider-turn", operationId: turnKey, threadId: projectThread },
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
      body: { kind: "start-provider-turn", operationId: turnKey, threadId: ownThread },
    });
    expect(answer.status).toBe(503);
    expect(dispatch).not.toHaveBeenCalled();
  });
});

describe("the running-turn limit", () => {
  it("counts a turn that is still starting, so two started at once cannot both pass a limit of one", async () => {
    const { service, threadProject, threadAccess } = deps();
    const policy = agentToolPolicy(
      grant({ limits: { ...DEFAULT_AGENT_GRANT_LIMITS, runningTurns: 1 } }),
      { service, threadProject, threadAccess },
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

describe("naming Full access in a tool call", () => {
  it("is open to a grant the person gave Full access and to no other", () => {
    const { service, threadProject, threadAccess } = deps();
    const naming = (highestLevel: AgentGrantScope["highestLevel"]) =>
      agentToolPolicy(grant({ highestLevel }), { service, threadProject, threadAccess })
        .allowsFullAccess;
    expect(naming("full-access")).toBe(true);
    expect(naming("auto")).toBe(false);
    expect(naming("ask-first")).toBe(false);
  });
});

describe("threads the person made in a granted Project", () => {
  it("are out of reach in a mode the grant does not name", () => {
    const read = { path: `/api/chat/threads/${chatThread}`, method: "GET" as const };
    expect(guard(read, { threads: "project" })).toBe("refused");
    expect(guard(read, { threads: "project", modes: ["code", "work", "chat"] })).toBe("allowed");
  });

  it("take no prompt on a model the grant does not include", () => {
    const send = (threadId: string) =>
      guard(
        {
          path: "/api/code/commands",
          method: "POST",
          body: { kind: "start-provider-turn", operationId: turnKey, threadId },
        },
        { threads: "project", models: ["fake-model"] },
      );
    expect(send(projectThread)).toBe("allowed");
    expect(send(otherModelThread)).toBe("refused");
  });

  it("count toward the running-turn limit once the agent runs a turn there", async () => {
    const { service, threadProject, threadAccess, turned } = deps();
    const session = createAgentSession({
      grant: grant({ threads: "project" }),
      signal: new AbortController().signal,
      deps: {
        service,
        threadProject,
        threadAccess,
        hostId: () => "40000000-0000-4000-8000-000000000001",
        markOutsideContent: () => undefined,
        dispatch: async () => Response.json({}),
      },
    });
    await session.send({
      path: "/api/code/commands",
      method: "POST",
      body: { kind: "start-provider-turn", operationId: turnKey, threadId: projectThread },
    });
    expect(turned).toEqual([{ threadId: projectThread, mode: "code" }]);
  });
});

describe("stopping a revoked agent's turns", () => {
  it("reaches a thread the person made once the agent ran a turn there, and no other", async () => {
    const { service, threadProject, threadAccess } = deps();
    const turnedService: AgentSessionDependencies["service"] = {
      ...service,
      turnThreadsOf: () => [{ threadId: projectThread, mode: "code" }],
    };
    const sent: string[] = [];
    const session = createAgentSession({
      grant: grant(),
      signal: new AbortController().signal,
      stopOnly: true,
      deps: {
        service: turnedService,
        threadProject,
        threadAccess,
        hostId: () => "40000000-0000-4000-8000-000000000001",
        markOutsideContent: () => undefined,
        dispatch: async ({ request }) => {
          sent.push(new URL(request.url).pathname);
          return Response.json({});
        },
      },
    });
    const cancel = (threadId: string) =>
      session.send({
        path: "/api/code/commands",
        method: "POST",
        body: { kind: "cancel-provider-turn", threadId },
      });
    expect((await cancel(projectThread)).status).toBe(200);
    expect((await cancel(strangerThread)).status).toBe(403);
    expect(sent).toEqual(["/api/code/commands"]);
  });
});

describe("the sender of each turn", () => {
  function session(answer: (body: Readonly<Record<string, unknown>>) => Response) {
    const fixture = deps();
    const created = createAgentSession({
      grant: grant({ threads: "project", modes: ["code", "work", "chat"] }),
      signal: new AbortController().signal,
      deps: {
        ...fixture,
        hostId: () => "40000000-0000-4000-8000-000000000001",
        markOutsideContent: () => undefined,
        dispatch: async ({ request }) => answer((await request.json()) as Record<string, unknown>),
      },
    });
    return { session: created, sentTurns: fixture.sentTurns };
  }
  // What the host answers when it starts the turn the request named.
  const started = (body: Readonly<Record<string, unknown>>) =>
    Response.json(
      body["kind"] === "send-chat-turn"
        ? { kind: "turn-created", turn: { submissionId: body["submissionId"] } }
        : { kind: "provider-turn-state", operationId: body["operationId"], state: "running" },
    );

  it("records the id each accepted turn keeps, so the transcript can name the agent", async () => {
    const { session: agent, sentTurns } = session(started);
    await agent.send({
      path: "/api/code/commands",
      method: "POST",
      body: { kind: "start-provider-turn", operationId: turnKey, threadId: projectThread },
    });
    await agent.send({
      path: "/api/chat/commands",
      method: "POST",
      body: { kind: "send-chat-turn", submissionId: turnKey, threadId: chatThread },
    });
    expect(sentTurns).toEqual([
      { threadId: projectThread, turnKey },
      { threadId: chatThread, turnKey },
    ]);
  });

  it("records a Work turn the host started, and nothing when it cannot tell whether the turn started", async () => {
    const send = {
      path: "/api/work/turns",
      method: "POST" as const,
      body: { kind: "start-work-thread-turn", turnId: turnKey, threadId: workThread },
    };
    const accepted = session(() =>
      Response.json({ kind: "accepted", turn: { turnId: turnKey, threadId: workThread } }),
    );
    await accepted.session.send(send);
    expect(accepted.sentTurns).toEqual([{ threadId: workThread, turnKey }]);
    const ambiguous = session(() =>
      Response.json({ kind: "ambiguous", turnId: turnKey, threadId: workThread }),
    );
    await ambiguous.session.send(send);
    expect(ambiguous.sentTurns).toEqual([]);
  });

  it("records nothing for a turn the host refused, even one it answered with HTTP 200, or for an answer", async () => {
    const send = {
      path: "/api/code/commands",
      method: "POST" as const,
      body: { kind: "start-provider-turn", operationId: turnKey, threadId: projectThread },
    };
    for (const answer of [
      () => Response.json({ kind: "refused" }, { status: 409 }),
      // A start refused before launch answers 200 with the refusal in the result.
      () =>
        Response.json({
          kind: "operation-failed",
          operationId: turnKey,
          failure: { code: "refused" },
          admission: "refused",
        }),
      () =>
        Response.json({
          kind: "provider-turn-state",
          operationId: turnKey,
          state: "failed",
          failure: { code: "refused" },
          admission: "refused",
        }),
      // An answer naming a different turn is not this request's turn.
      () =>
        Response.json({
          kind: "provider-turn-state",
          operationId: "60000000-0000-4000-8000-000000000099",
          state: "running",
        }),
    ]) {
      const refusedSend = session(answer);
      await refusedSend.session.send(send);
      expect(refusedSend.sentTurns).toEqual([]);
    }
    const { session: agent, sentTurns } = session(started);
    await agent.send({
      path: "/api/chat/commands",
      method: "POST",
      body: { kind: "answer-chat-turn-question", threadId: chatThread },
    });
    expect(sentTurns).toEqual([]);
  });

  it("refuses a turn start that names no id to record it by", () => {
    expect(
      guard(
        {
          path: "/api/code/commands",
          method: "POST",
          body: { kind: "start-provider-turn", threadId: projectThread },
        },
        { threads: "project" },
      ),
    ).toBe("refused");
  });
});
