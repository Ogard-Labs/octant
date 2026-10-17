import { describe, expect, it } from "vitest";
import {
  childDetailLines,
  childrenAfterRead,
  childListLines,
  childQuestion,
  listAgentChildren,
  pickAgentChild,
  readAgentChild,
  replyToAgentChild,
  type AgentChild,
} from "./agentChildren";
import type { LocalControlRequest, OpenedLocalControlSession } from "./localControl";

const threadId = "70000000-0000-4000-8000-000000000001";
const now = "2026-10-16T09:00:00.000Z";

/** One Agents Center row the way the host serializes it. */
export function childRow(
  overrides: Partial<Record<string, unknown>> & { readonly runId: string },
): Record<string, unknown> {
  return {
    requestId: "71000000-0000-4000-8000-000000000001",
    parentThreadId: threadId,
    parentThreadTitle: "Plan the parser",
    mode: "chat",
    role: "research",
    task: "Find where the lexer handles escapes",
    lifecycleStatus: "running",
    executionKind: "octant-managed",
    authority: {
      filesystem: false,
      shell: false,
      git: false,
      network: false,
      tools: true,
      subagents: false,
      executionPolicy: "approval-gated",
      permissionPersistence: "current-session",
    },
    workspaceKind: "chat-virtual",
    usageQuality: "unavailable",
    route: {
      requestedProviderInstanceId: "50000000-0000-4000-8000-000000000001",
      requestedModelId: "loopback-model",
      executionProviderInstanceId: "50000000-0000-4000-8000-000000000001",
      executionModelId: "loopback-model",
      poolDerived: false,
    },
    resultAcknowledgement: { required: false, acknowledged: false },
    version: 3,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

const first = childRow({ runId: "72000000-0000-4000-8000-000000000001" });
const second = childRow({
  runId: "72000000-0000-4000-8000-000000000002",
  role: "review",
  task: "Review the escape handling",
  lifecycleStatus: "completed",
  createdAt: "2026-10-16T09:01:00.000Z",
  updatedAt: "2026-10-16T09:02:00.000Z",
});

function host(answer: (request: LocalControlRequest) => { status: number; body: unknown }): {
  session: OpenedLocalControlSession;
  sent: LocalControlRequest[];
} {
  const sent: LocalControlRequest[] = [];
  return {
    sent,
    session: {
      kind: "opened",
      windowId: "11111111-1111-4111-8111-111111111111",
      send: async (request) => {
        sent.push(request);
        return answer(request);
      },
      close: async () => undefined,
    },
  };
}

async function children(rows: ReadonlyArray<unknown>): Promise<ReadonlyArray<AgentChild>> {
  const fake = host(() => ({ status: 200, body: { items: rows } }));
  const listed = await listAgentChildren(fake.session, threadId);
  if (listed.kind !== "listed") throw new Error("not listed");
  return listed.children;
}

describe("a thread's helper agents in the terminal", () => {
  it("lists them oldest first from the Agents Center, for this thread only", async () => {
    const fake = host(() => ({ status: 200, body: { items: [second, first] } }));
    const listed = await listAgentChildren(fake.session, threadId);
    expect(fake.sent[0]?.path).toBe(
      `/api/agent-runs/center?status=all&mode=all&parentThreadId=${threadId}`,
    );
    expect(listed.kind === "listed" && listed.children.map((child) => child.task)).toEqual([
      "Find where the lexer handles escapes",
      "Review the escape handling",
    ]);
  });

  it("follows every page of the list before numbering, so older helpers keep their numbers", async () => {
    const older = childRow({
      runId: "72000000-0000-4000-8000-000000000009",
      task: "Oldest helper",
      createdAt: "2026-10-16T08:00:00.000Z",
    });
    const fake = host((request) =>
      request.path.includes("cursor=page-2")
        ? { status: 200, body: { items: [older] } }
        : { status: 200, body: { items: [second, first], nextCursor: "page-2" } },
    );
    const listed = await listAgentChildren(fake.session, threadId);
    expect(fake.sent.map((request) => request.path)).toEqual([
      `/api/agent-runs/center?status=all&mode=all&parentThreadId=${threadId}`,
      `/api/agent-runs/center?status=all&mode=all&parentThreadId=${threadId}&cursor=page-2`,
    ]);
    expect(listed.kind === "listed" && listed.children.map((child) => child.task)).toEqual([
      "Oldest helper",
      "Find where the lexer handles escapes",
      "Review the escape handling",
    ]);
  });

  it("keeps no helpers after a refused read, so another thread's are never listed or picked", async () => {
    const kept = await children([first]);
    expect(childrenAfterRead({ kind: "listed", children: kept })).toEqual({ children: kept });
    const refused = childrenAfterRead({
      kind: "refused",
      message: "AgentRun request is unauthorized.",
    });
    expect(refused).toEqual({ children: [], refusal: "AgentRun request is unauthorized." });
    expect(pickAgentChild(refused.children, "1")).toBeUndefined();
  });

  it("says why the host would not list them", async () => {
    const fake = host(() => ({
      status: 403,
      body: { error: "AgentRun request is unauthorized." },
    }));
    expect(await listAgentChildren(fake.session, threadId)).toEqual({
      kind: "refused",
      message: "AgentRun request is unauthorized.",
    });
  });

  it("picks one by number or by the start of its id, and none when the id is ambiguous", async () => {
    const rows = await children([first, second]);
    expect(pickAgentChild(rows, "2")?.role).toBe("review");
    expect(pickAgentChild(rows, "72000000-0000-4000-8000-000000000001")?.role).toBe("research");
    expect(pickAgentChild(rows, "72000000")).toBeUndefined();
    expect(pickAgentChild(rows, "9")).toBeUndefined();
  });

  it("words each row with its number, state, role, model, age and brief", async () => {
    const rows = await children([first, second]);
    const lines = childListLines(rows, Date.parse("2026-10-16T09:05:00.000Z"), new Set());
    expect(lines[0]).toBe(
      "1. [72000000] working · research · loopback-model · 5m — Find where the lexer handles escapes",
    );
    expect(lines[1]).toContain("done · review");
    expect(childListLines([], 0)).toEqual([
      "No helper agents yet. They appear when the lead hands off part of its work.",
    ]);
  });

  it("reads a running helper's live text and a finished one's reported summary", async () => {
    const [running, done] = await children([first, second]);
    const live = host((request) =>
      request.path.startsWith("/api/agent-runs/results")
        ? { status: 200, body: { runId: first.runId, packets: [], truncated: false } }
        : {
            status: 200,
            body: {
              runId: first.runId,
              parentThreadId: threadId,
              executionKind: "octant-managed",
              modelId: "loopback-model",
              lifecycleStatus: "running",
              status: "live",
              entries: [
                { sequence: 1, kind: "assistant", text: "Looking at ", occurredAt: now },
                { sequence: 2, kind: "status", text: "tool", occurredAt: now },
                { sequence: 3, kind: "assistant", text: "the lexer.", occurredAt: now },
              ],
              truncated: false,
            },
          },
    );
    expect((await readAgentChild(live.session, running!)).reply).toBe("Looking at the lexer.");
    const gone = host((request) =>
      request.path.startsWith("/api/agent-runs/results")
        ? { status: 200, body: { runId: second.runId, packets: [], truncated: false } }
        : { status: 404, body: {} },
    );
    const read = await readAgentChild(gone.session, done!);
    expect(read.reply).toBeUndefined();
    expect(childDetailLines(done!, read, undefined, Date.parse(now)).join("\n")).toContain(
      "No reply yet.",
    );
  });

  it("steers a running helper, follows up on a finished one, and refuses one that has stopped or runs inside its provider", async () => {
    const [running, done] = await children([first, second]);
    const accepted = host(() => ({ status: 200, body: { kind: "run-updated" } }));
    expect(
      await replyToAgentChild(accepted.session, threadId, running!, "use sqlite", undefined),
    ).toEqual({
      kind: "replied",
      how: "steered",
    });
    expect(accepted.sent[0]).toMatchObject({
      path: "/api/agent-runs/steer",
      body: { runId: first.runId, expectedVersion: 3, message: "use sqlite" },
    });
    expect(
      await replyToAgentChild(accepted.session, threadId, done!, "and the docs?", undefined),
    ).toEqual({
      kind: "replied",
      how: "followed-up",
    });
    expect(accepted.sent[1]?.path).toBe("/api/agent-runs/resume");

    const [failed, native] = await children([
      childRow({ runId: "72000000-0000-4000-8000-000000000003", lifecycleStatus: "failed" }),
      childRow({
        runId: "72000000-0000-4000-8000-000000000004",
        executionKind: "provider-native",
      }),
    ]);
    const idle = host(() => ({ status: 200, body: {} }));
    expect(await replyToAgentChild(idle.session, threadId, failed!, "again", undefined)).toEqual({
      kind: "refused",
      message: "This helper is failed, so it takes no reply.",
    });
    expect(await replyToAgentChild(idle.session, threadId, native!, "hi", undefined)).toMatchObject(
      { kind: "refused" },
    );
    expect(idle.sent).toEqual([]);
  });

  it("shows the host's refusal when a stale reply is turned down", async () => {
    const [running] = await children([first]);
    const stale = host(() => ({
      status: 409,
      body: { kind: "run-command-failed", message: "The helper changed; read it again." },
    }));
    expect(await replyToAgentChild(stale.session, threadId, running!, "x", undefined)).toEqual({
      kind: "refused",
      message: "The helper changed; read it again.",
    });
  });

  it("answers the question a helper asked through the session's question route", async () => {
    const [running] = await children([first]);
    const question = {
      id: "73000000-0000-4000-8000-000000000001",
      source: {
        runId: first.runId,
        providerInstanceId: "50000000-0000-4000-8000-000000000001",
        modelId: "loopback-model",
      },
      prompt: "Which lexer?",
      options: ["hand written", "generated"],
      status: "pending",
      askedAt: now,
    };
    const session = { questions: [question] } as never;
    expect(childQuestion(session, running!)).toBe(question);
    expect(childQuestion(session, (await children([second]))[0]!)).toBeUndefined();
    const fake = host(() => ({ status: 200, body: {} }));
    expect(
      await replyToAgentChild(fake.session, threadId, running!, "2", question as never),
    ).toEqual({
      kind: "replied",
      how: "answered",
    });
    expect(fake.sent[0]).toMatchObject({
      path: `/api/native-harness/sessions/${threadId}/questions`,
      body: { questionId: question.id, answer: "generated" },
    });
  });
});
