import { describe, expect, it } from "vitest";
import {
  alwaysVisibleActivityRows,
  settledTurnActivitySummary,
  toolStepsActivity,
} from "./turnActivity";

describe("turn activity", () => {
  it("summarizes a settled turn's toolchain for the quiet fold line", () => {
    expect(
      settledTurnActivitySummary({
        reasoning: "plan",
        rows: [
          { kind: "tool", id: "1", toolName: "Read", state: "completed" },
          { kind: "tool", id: "2", toolName: "Write", state: "completed" },
          { kind: "tool", id: "3", toolName: "Edit", state: "completed" },
          { kind: "tool", id: "4", toolName: "Bash", state: "completed" },
        ],
      }),
    ).toBe("4 tool calls · 2 files edited");
  });

  it("counts only the edits that happened, not a write the person denied", () => {
    expect(
      settledTurnActivitySummary({
        reasoning: "",
        rows: [
          { kind: "tool", id: "1", toolName: "Write", state: "failed" },
          { kind: "tool", id: "2", toolName: "Edit", state: "completed" },
        ],
      }),
    ).toBe("2 tool calls · 1 file edited");
    expect(
      settledTurnActivitySummary({
        reasoning: "",
        rows: [{ kind: "tool", id: "1", toolName: "Write", state: "failed" }],
      }),
    ).toBe("1 tool call");
  });

  it("keeps waiting rows outside the settled fold", () => {
    const activity = {
      reasoning: "",
      rows: [
        { kind: "tool" as const, id: "1", toolName: "Read", state: "completed" as const },
        {
          kind: "task" as const,
          id: "t1",
          state: "waiting" as const,
          summary: "Apply the edit",
        },
      ],
    };
    expect(alwaysVisibleActivityRows(activity)).toEqual([
      { kind: "task", id: "t1", state: "waiting", summary: "Apply the edit" },
    ]);
  });

  it("carries the Watcher's tag from a Chat or Work turn's recorded tool step to its row", () => {
    const activity = toolStepsActivity(
      [
        {
          toolCallId: "fetch-1",
          toolName: "webfetch",
          state: "completed",
          outsideContent: { labels: ["agent-instructions"] },
        },
        { toolCallId: "read-1", toolName: "Read", state: "completed" },
      ],
      false,
    );
    expect(activity?.rows).toMatchObject([
      { id: "fetch-1", outsideContent: { labels: ["agent-instructions"] } },
      { id: "read-1" },
    ]);
    expect(activity?.rows[1]).not.toHaveProperty("outsideContent");
  });
});
