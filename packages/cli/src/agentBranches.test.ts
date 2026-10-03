import { describe, expect, it } from "vitest";
import {
  forkAgentThread,
  listAgentCheckpoints,
  markAgentCheckpoint,
  restoreAgentCheckpoint,
} from "./agentBranches";
import type { AgentThreadSnapshot, AgentThreadTurn } from "./agentThread";
import type { LocalControlRequest, OpenedLocalControlSession } from "./localControl";

const threadId = "00000000-0000-4000-8000-000000000020";

function session(
  answer: (request: LocalControlRequest) => { status: number; body: unknown },
  seen: LocalControlRequest[] = [],
): OpenedLocalControlSession {
  return {
    kind: "opened",
    windowId: "window",
    send: async (request) => {
      seen.push(request);
      return answer(request);
    },
    close: async () => undefined,
  };
}

function turn(id: string, outcome: AgentThreadTurn["outcome"]): AgentThreadTurn {
  return { id, at: "", prompt: "", reply: "", replyAt: "", outcome };
}

function snapshot(
  mode: AgentThreadSnapshot["mode"],
  turns: ReadonlyArray<AgentThreadTurn>,
): AgentThreadSnapshot {
  return {
    id: threadId,
    mode,
    title: "Parser",
    providerInstanceId: "p",
    modelId: "m",
    version: 7,
    turns,
    workItems: [],
  };
}

const checkpoint = {
  id: "00000000-0000-4000-8000-000000000061",
  anchor: {
    mode: "code",
    threadId,
    operationId: "00000000-0000-4000-8000-000000000071",
    revision: "a".repeat(40),
  },
  label: "Before the refactor",
  lifecycle: "marked",
  restoreCount: 0,
  markedAt: "2026-10-02T12:00:00.000Z",
  version: 3,
  updatedAt: "2026-10-02T12:00:00.000Z",
};

describe("forks and checkpoints from the terminal", () => {
  it("forks a Code thread at its newest finished reply through the host's fork command", async () => {
    const seen: LocalControlRequest[] = [];
    const result = await forkAgentThread(
      session(() => ({ status: 200, body: { kind: "managed-thread-created" } }), seen),
      snapshot("code", [
        turn("00000000-0000-4000-8000-000000000071", "completed"),
        turn("00000000-0000-4000-8000-000000000072", "failed"),
      ]),
    );

    expect(seen[0]).toMatchObject({
      path: "/api/code/commands",
      body: {
        kind: "fork-code-thread",
        sourceThreadId: threadId,
        throughOperationId: "00000000-0000-4000-8000-000000000071",
        title: "Parser (fork)",
      },
    });
    expect(result).toMatchObject({ kind: "created", mode: "code" });
    if (result.kind === "created")
      expect(result.threadId).toBe((seen[0]?.body as { threadId: string }).threadId);
  });

  it("says why the host refused a fork, and refuses one with nothing finished to fork from", async () => {
    const refused = await forkAgentThread(
      session(() => ({
        status: 409,
        body: {
          failure: { category: "conflict", message: "Fork from a reply that has finished." },
        },
      })),
      snapshot("code", [turn("00000000-0000-4000-8000-000000000071", "completed")]),
    );
    expect(refused).toEqual({ kind: "refused", message: "Fork from a reply that has finished." });

    const seen: LocalControlRequest[] = [];
    const nothing = await forkAgentThread(
      session(() => ({ status: 200, body: {} }), seen),
      snapshot("code", [turn("00000000-0000-4000-8000-000000000072", "streaming")]),
    );
    expect(nothing.kind).toBe("refused");
    expect(seen).toHaveLength(0);
  });

  it("marks, lists, and restores a checkpoint as a new thread at the version it was listed with", async () => {
    const seen: LocalControlRequest[] = [];
    const host = session((request) => {
      if (request.method === "GET") {
        return {
          status: 200,
          body: {
            checkpoints: [
              checkpoint,
              { ...checkpoint, id: "00000000-0000-4000-8000-000000000062", lifecycle: "forgotten" },
            ],
          },
        };
      }
      const kind = (request.body as { kind: string }).kind;
      return kind === "mark-thread-checkpoint"
        ? { status: 200, body: { kind: "checkpoint-marked", checkpoint } }
        : {
            status: 200,
            body: {
              kind: "checkpoint-restored",
              checkpoint: {
                ...checkpoint,
                restoreCount: 1,
                lastRestoredAt: checkpoint.markedAt,
                version: 4,
              },
              restore: { mode: "code", threadId: "00000000-0000-4000-8000-000000000099" },
            },
          };
    }, seen);
    const thread = snapshot("code", [turn("00000000-0000-4000-8000-000000000071", "completed")]);

    const marked = await markAgentCheckpoint(host, thread, "Before the refactor");
    const listed = await listAgentCheckpoints(host, threadId);
    if (listed.kind !== "listed") throw new Error("not listed");
    const restored = await restoreAgentCheckpoint(
      host,
      listed.checkpoints[0] as never,
      "Parser (again)",
    );

    expect(marked.kind).toBe("marked");
    expect(seen[0]?.body).toMatchObject({
      anchor: { mode: "code", threadId, operationId: "00000000-0000-4000-8000-000000000071" },
    });
    // A forgotten checkpoint is not offered for restore.
    expect(listed.checkpoints).toHaveLength(1);
    expect(seen[2]?.body).toMatchObject({
      kind: "restore-from-thread-checkpoint",
      checkpointId: checkpoint.id,
      expectedVersion: 3,
    });
    expect(restored).toEqual({
      kind: "created",
      threadId: "00000000-0000-4000-8000-000000000099",
      mode: "code",
    });
  });

  it("refuses to fork or checkpoint a Work thread rather than pretending to", async () => {
    const seen: LocalControlRequest[] = [];
    const host = session(() => ({ status: 200, body: {} }), seen);
    const work = snapshot("work", [turn("00000000-0000-4000-8000-000000000071", "completed")]);

    expect((await forkAgentThread(host, work)).kind).toBe("refused");
    expect((await markAgentCheckpoint(host, work, "x")).kind).toBe("refused");
    expect(seen).toHaveLength(0);
  });
});
