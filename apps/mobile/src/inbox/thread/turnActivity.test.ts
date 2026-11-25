import { describe, expect, it } from "vitest";
import type { WorkTurnState } from "@octant/contracts";
import type { MobileCodeConversationTurn } from "@octant/client-runtime";
import { codeTurnActivity, turnSubagents, workTurnActivity } from "./turnActivity";

const tool = (toolName: string, state: "running" | "completed" | "failed", summary?: string) => ({
  toolCallId: toolName,
  toolName,
  state,
  ...(summary === undefined ? {} : { summary }),
});
const work = (fields: object): WorkTurnState =>
  ({ status: "running", updatedAt: "2026-11-25T08:00:00.000Z", ...fields }) as WorkTurnState;
const code = (fields: Partial<MobileCodeConversationTurn>): MobileCodeConversationTurn => ({
  operationId: "op",
  status: "completed",
  prompt: "",
  assistant: [],
  steps: [],
  stepsTruncated: false,
  routines: [],
  startedAt: "2026-11-25T08:00:00.000Z",
  updatedAt: "2026-11-25T08:01:00.000Z",
  ...fields,
});

describe("what a turn did", () => {
  it("lists a Work turn's calls, plan and changed files as the host reports them", () => {
    const activity = workTurnActivity(
      work({
        toolSteps: [tool("Read", "completed", "12 files"), tool("Bash", "running")],
        tasks: [
          { taskId: "1", state: "completed", summary: "Read the code" },
          { taskId: "2", state: "running", summary: "Run", runningSummary: "Running the tests" },
        ],
        reasoningMs: 12_400,
        wroteFiles: { paths: ["notes.md"], truncated: true },
      }),
    );
    expect(activity.calls).toEqual([
      { name: "Read", status: "done", summary: "12 files" },
      { name: "Bash", status: "running", summary: "" },
    ]);
    expect(activity.plan.map((task) => `${task.state} ${task.text}`)).toEqual([
      "completed Read the code",
      // A running task is named in the words it has while it runs.
      "running Running the tests",
    ]);
    expect(activity.reasoningMs).toBe(12_400);
    expect(activity.files).toEqual({ files: [{ path: "notes.md" }], total: 1, truncated: true });
  });

  it("lists a Code turn's calls with what the reviewer decided, and its changed lines", () => {
    const activity = codeTurnActivity(
      code({
        steps: [
          { kind: "tool", ...tool("Edit", "failed", "No match") },
          { kind: "review", summary: "Run npm test", decision: "approved" },
        ] as never,
        stepsTruncated: true,
        changedFiles: {
          files: [{ path: "src/a.ts", insertions: 4, deletions: 1 }],
          total: 3,
          truncated: true,
        } as never,
      }),
    );
    expect(activity.calls.map((call) => `${call.status} ${call.name}`)).toEqual([
      "failed Edit",
      "done Run npm test",
    ]);
    expect(activity.callsTruncated).toBe(true);
    expect(activity.files).toEqual({
      files: [{ path: "src/a.ts", insertions: 4, deletions: 1 }],
      total: 3,
      truncated: true,
    });
  });

  it("does not call a step running once its turn is over", () => {
    const steps = [{ kind: "tool", ...tool("Bash", "running") }] as never;
    expect(codeTurnActivity(code({ steps, status: "interrupted" })).calls[0]?.status).toBe(
      "failed",
    );
    expect(codeTurnActivity(code({ steps, status: "waiting" })).calls[0]?.status).toBe("running");
  });

  it("counts the subagents still at work", () => {
    const child = (childAgentId: string, lifecycleStatus: string) => ({
      childAgentId,
      lifecycleStatus,
      task: `Task ${childAgentId}`,
      latestSummary: "",
      updatedAt: "2026-11-25T08:00:00.000Z",
    });
    const agents = turnSubagents(
      work({
        childObservations: {
          children: [child("a", "running"), child("b", "completed"), child("c", "waiting")],
          truncated: false,
        },
      }),
    );
    expect(agents.map((agent) => agent.working)).toEqual([true, false, true]);
  });
});
