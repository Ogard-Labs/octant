import type { CodeOperationEventFrame, WorkTurnState } from "@octant/contracts";
import { describe, expect, it } from "vitest";
import { makeClaudeLibraryPublishes } from "./claudeLibraryPublishes";
import { summarizeThreadHistory } from "./code/codeOperationEventStore";

const project = "20000000-0000-4000-8000-000000000001" as never;
const page = {
  url: "https://claude.ai/artifact/hero",
  title: "Hero",
  account: "claude-work",
  artifactType: "Design",
};

function toolFrame(
  cursor: number,
  event: Record<string, unknown>,
  occurredAt = "2026-08-18T09:00:00.000Z",
): CodeOperationEventFrame {
  return {
    threadId: "30000000-0000-4000-8000-000000000001",
    operationId: "40000000-0000-4000-8000-000000000001",
    cursor,
    occurredAt,
    event: { kind: "tool-activity", toolName: "Artifact", ...event },
  } as unknown as CodeOperationEventFrame;
}

describe("Claude pages read from each thread's journal", () => {
  it("keeps every published page in a Code thread's summary, so the library finds it there", () => {
    const frames = [
      toolFrame(1, { toolCallId: "call-1", state: "running" }),
      toolFrame(2, { toolCallId: "call-1", state: "succeeded", published: page }),
      toolFrame(3, { toolCallId: "call-2", state: "succeeded" }, "2026-08-18T10:00:00.000Z"),
    ];
    const summary = summarizeThreadHistory(frames);
    expect(summary.some((frame) => frame.cursor === 2)).toBe(true);
  });

  it("reads a Work turn's published step and a Code thread's published frame, each call once", () => {
    const publishes = makeClaudeLibraryPublishes({
      workThreads: () => [{ id: "work-thread", projectId: project, title: "Landing page" }],
      workTurns: () =>
        [
          {
            updatedAt: "2026-08-18T08:00:00.000Z",
            toolSteps: [
              { toolCallId: "work-call", published: { ...page, snapshot: { format: "html" } } },
              { toolCallId: "other-call" },
            ],
          },
        ] as unknown as ReadonlyArray<WorkTurnState>,
      codeThreads: () => [{ id: "code-thread", projectId: project, title: "Fix header" }],
      codeSummary: () => [
        toolFrame(2, { toolCallId: "code-call", published: page }),
        toolFrame(3, { toolCallId: "code-call", published: page }),
      ],
    })();
    expect(publishes).toEqual([
      expect.objectContaining({
        mode: "work",
        threadId: "work-thread",
        threadTitle: "Landing page",
        toolCallId: "work-call",
        account: "claude-work",
        artifactType: "Design",
        snapshot: "html",
      }),
      expect.objectContaining({ mode: "code", threadId: "code-thread", toolCallId: "code-call" }),
    ]);
  });

  it("lists nothing for a Code thread whose summary must be rebuilt first", () => {
    const publishes = makeClaudeLibraryPublishes({
      workThreads: () => [],
      workTurns: () => [],
      codeThreads: () => [{ id: "code-thread", projectId: project, title: "Fix header" }],
      codeSummary: () => undefined,
    })();
    expect(publishes).toEqual([]);
  });
});
