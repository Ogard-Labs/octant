import {
  decodeWindowId,
  decodeWorkThread,
  decodeWorkTurnState,
  type WorkThread,
  type WorkTurnState,
} from "@octant/contracts";
import { describe, expect, it } from "vitest";
import { listWorkTurnDecisions, workTurnDecision } from "./workTurnDecisions";

const at = "2026-10-09T09:00:00.000Z";
const ended = "2026-10-09T09:05:00.000Z";
const windowId = decodeWindowId("00000000-0000-4000-8000-000000000b01");
const projectId = "00000000-0000-4000-8000-000000000b02";
const threadId = "00000000-0000-4000-8000-000000000b03";
const ask =
  '```octant-decision\n{"ask":"Which chart leads the summary?","options":[{"label":"Revenue","recommended":true},{"label":"Headcount"}]}\n```';

describe("Work turn decisions", () => {
  it("raises the ask a finished turn closes with, answered as the thread's next turn", () => {
    const decision = workTurnDecision(workThread(), [turn(1, "completed", `Drafted.\n\n${ask}`)]);
    expect(decision).toEqual({
      mode: "work",
      kind: "decision",
      projectId,
      threadId,
      threadTitle: "Quarterly report",
      requestedAt: ended,
      text: "Which chart leads the summary?",
      options: [
        { label: "Revenue", recommended: true },
        { label: "Headcount", recommended: false },
      ],
      answer: {
        threadId,
        turnId: "00000000-0000-4000-8000-000000000201",
        authority: {
          hostId: "local",
          projectId,
          bindingRevisionId: "00000000-0000-4000-8000-000000000b05",
          workingDirectory: ".",
          confinementPosture: "project-root-confined",
          // The thread moved to another model after the turn; the next turn uses it.
          providerInstanceId: "00000000-0000-4000-8000-000000000b06",
          modelId: "model-b",
        },
      },
    });
  });

  it("raises nothing for a reply without an ask, a newer turn, or a turn that did not complete", () => {
    expect(
      workTurnDecision(workThread(), [turn(1, "completed", "Done, nothing needs you.")]),
    ).toBeUndefined();
    expect(
      workTurnDecision(workThread(), [turn(1, "completed", ask), turn(2, "running", "")]),
    ).toBeUndefined();
    expect(workTurnDecision(workThread(), [turn(1, "failed", ask)])).toBeUndefined();
  });

  it("raises nothing on an archived, completed, or snoozed thread", () => {
    const turns = [turn(1, "completed", ask)];
    expect(workTurnDecision(workThread({ lifecycle: "archived" }), turns)).toBeUndefined();
    expect(workTurnDecision(workThread({ completedAt: at }), turns)).toBeUndefined();
    expect(
      workTurnDecision(workThread({ snooze: { until: "2026-10-10T09:00:00.000Z", at } }), turns),
    ).toBeUndefined();
  });

  it("lists a decision only on a thread in one of the window's Work Projects", async () => {
    const sources = (type: string) => ({
      projects: async () => ({ active: [{ id: projectId as never, type }] }),
      threads: async () => ({ threads: [workThread()] }),
      turns: () => [turn(1, "completed", ask)],
    });
    expect(await listWorkTurnDecisions(sources("work"), windowId)).toHaveLength(1);
    expect(await listWorkTurnDecisions(sources("code"), windowId)).toEqual([]);
  });
});

function workThread(overrides: Partial<Record<string, unknown>> = {}): WorkThread {
  return decodeWorkThread({
    id: threadId,
    projectId,
    title: "Quarterly report",
    lifecycle: "active",
    providerInstanceId: "00000000-0000-4000-8000-000000000b06",
    modelId: "model-b",
    bindingRevisionId: "00000000-0000-4000-8000-000000000b05",
    version: 3,
    createdAt: at,
    updatedAt: at,
    ...overrides,
  });
}

function turn(n: number, status: WorkTurnState["status"], response: string): WorkTurnState {
  return decodeWorkTurnState({
    requestId: `00000000-0000-4000-8000-${String(100 + n).padStart(12, "0")}`,
    turnId: `00000000-0000-4000-8000-${String(200 + n).padStart(12, "0")}`,
    threadId,
    projectId,
    authority: {
      hostId: "local",
      projectId,
      bindingRevisionId: "00000000-0000-4000-8000-000000000b05",
      workingDirectory: ".",
      confinementPosture: "project-root-confined",
      providerInstanceId: "00000000-0000-4000-8000-000000000b04",
      modelId: "model-a",
    },
    status,
    prompt: `question ${String(n)}`,
    ...(response === "" ? {} : { response }),
    transcript: [{ role: "user", text: `question ${String(n)}` }],
    capabilities: {
      workspace: "project-backed",
      confinement: "project-root-confined",
      shell: "denied",
      git: "denied",
      worktree: "denied",
      pullRequest: "denied",
      code: "denied",
    },
    version: 2,
    acceptedAt: at,
    updatedAt: ended,
  });
}
