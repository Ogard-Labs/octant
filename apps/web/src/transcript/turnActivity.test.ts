import { describe, expect, it } from "vitest";
import {
  alwaysVisibleActivityRows,
  settledTurnActivitySummary,
  toolStepsActivity,
} from "./turnActivity";

describe("turn activity", () => {
  it("carries a recorded step's published page onto its row and nothing onto the others", () => {
    const page = { url: "https://claude.ai/artifact/abc-123", title: "Quarterly report" };
    const activity = toolStepsActivity(
      [
        { toolCallId: "a", toolName: "Read", state: "completed", summary: "Read 40 lines" },
        {
          toolCallId: "b",
          toolName: "Artifact",
          state: "completed",
          summary: `Published: ${page.url}`,
          publishedPage: page,
        },
      ],
      false,
    );
    expect(activity?.rows).toEqual([
      { kind: "tool", id: "a", toolName: "Read", state: "completed", summary: "Read 40 lines" },
      {
        kind: "tool",
        id: "b",
        toolName: "Artifact",
        state: "completed",
        summary: `Published: ${page.url}`,
        publishedPage: page,
      },
    ]);
  });

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
});
