import { describe, expect, it } from "vitest";
import type { ThreadToolStep } from "@octant/contracts";
import {
  alwaysVisibleActivityRows,
  groupActivityRows,
  runningStepTitle,
  settledTurnActivitySummary,
  settledTurnFoldsActivity,
  toolStepsActivity,
  type TurnActivity,
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

  it("shows a Work step Octant Shield answered as a review row, not a tool call", () => {
    const decision = {
      reviewer: "octant-shield",
      verdict: "deny",
      stage: "deny-rule",
      reason: "Reads a secret file.",
      latencyMs: 2,
      decidedAt: "2026-10-31T10:00:00.000Z",
    } as unknown as NonNullable<ThreadToolStep["shield"]>;
    const activity = toolStepsActivity(
      [
        { toolCallId: "a", toolName: "Bash", state: "completed" },
        {
          toolCallId: "shield:approval-1",
          toolName: "Bash",
          state: "completed",
          summary: "cat .env",
          shield: decision,
        },
      ],
      undefined,
    );
    expect(activity?.rows).toEqual([
      { kind: "tool", id: "a", toolName: "Bash", state: "completed" },
      { kind: "review", id: "shield:approval-1", summary: "cat .env", decision },
    ]);
  });
});

describe("looks grouped into one row", () => {
  const tool = (id: string, toolName: string, state: "completed" | "running" = "completed") => ({
    kind: "tool" as const,
    id,
    toolName,
    state,
  });

  it("groups consecutive reads and searches and counts each kind", () => {
    const items = groupActivityRows([
      tool("1", "Read"),
      tool("2", "Read"),
      tool("3", "Grep"),
      tool("4", "Glob"),
      tool("5", "Read"),
      tool("6", "Read"),
    ]);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: "group", label: "Read 4 files, searched 2 times" });
  });

  it("splits a group at an edit and leaves a single look as a plain row", () => {
    const items = groupActivityRows([
      tool("1", "Read"),
      tool("2", "Grep"),
      tool("3", "Edit"),
      tool("4", "Read"),
    ]);
    expect(items.map((item) => item.kind)).toEqual(["group", "row", "row"]);
  });

  it("keeps a web read that brought outside content as its own row", () => {
    const items = groupActivityRows([
      tool("1", "Read"),
      { ...tool("2", "WebFetch"), outsideContent: { labels: [] } },
      tool("3", "Read"),
    ]);
    expect(items.every((item) => item.kind === "row")).toBe(true);
  });
});

describe("the live step and the settled summary", () => {
  it("names the newest running tool, and nothing when none runs", () => {
    expect(
      runningStepTitle({
        reasoning: "",
        rows: [
          { kind: "tool", id: "1", toolName: "Read", state: "running" },
          { kind: "tool", id: "2", toolName: "Grep", state: "running" },
          { kind: "tool", id: "3", toolName: "Edit", state: "completed" },
        ],
      }),
    ).toBe("Grep");
    expect(
      runningStepTitle({
        reasoning: "",
        rows: [{ kind: "tool", id: "1", toolName: "Read", state: "completed" }],
      }),
    ).toBeUndefined();
  });

  it("leads the fold summary with the duration once, and never folds on the duration alone", () => {
    const activity: TurnActivity = {
      reasoning: "",
      rows: [
        { kind: "tool", id: "1", toolName: "Bash", state: "completed" },
        { kind: "tool", id: "2", toolName: "Edit", state: "completed" },
      ],
    };
    expect(settledTurnActivitySummary(activity, "Worked for 1m 5s")).toBe(
      "Worked for 1m 5s · 2 tool calls · 1 file edited",
    );
    expect(settledTurnActivitySummary({ reasoning: "", rows: [] }, "Worked for 5s")).toBe("");
    expect(settledTurnFoldsActivity(activity)).toBe(true);
    expect(settledTurnFoldsActivity({ reasoning: "", rows: [] })).toBe(false);
  });
});
