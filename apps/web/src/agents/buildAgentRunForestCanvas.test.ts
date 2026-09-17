import { describe, expect, it } from "vitest";
import { forestRun } from "./agentRunForest.fixture";
import { buildAgentRunForest } from "./buildAgentRunForest";
import { buildAgentRunForestCanvasBlocks } from "./buildAgentRunForestCanvas";

describe("buildAgentRunForestCanvasBlocks", () => {
  it("snapshots launch edges from parent thread to child to grandchild", () => {
    const lead = forestRun({
      runId: "11111111-1111-4111-8111-111111111111",
      task: "Lead research",
    });
    const child = forestRun({
      runId: "21111111-1111-4111-8111-111111111111",
      task: "Review findings",
      parentRunId: String(lead.runId),
      role: "review",
      createdAt: "2026-08-01T10:02:00.000Z",
    });
    const grandchild = forestRun({
      runId: "31111111-1111-4111-8111-111111111111",
      task: "Tighten the review",
      parentRunId: String(child.runId),
      createdAt: "2026-08-01T10:03:00.000Z",
    });
    const blocks = buildAgentRunForestCanvasBlocks(buildAgentRunForest([lead, child, grandchild]));
    expect(blocks).toHaveLength(1);
    const diagram = blocks[0];
    expect(diagram?.kind).toBe("diagram");
    if (diagram?.kind !== "diagram") return;
    expect(diagram.nodes.map((node) => node.label)).toEqual([
      "Design chat",
      "Lead research",
      "Review findings",
      "Tighten the review",
    ]);
    expect(diagram.edges).toHaveLength(3);
    expect(diagram.flow).toBe("down");
  });

  it("returns no blocks for an empty forest", () => {
    expect(buildAgentRunForestCanvasBlocks({ threads: [] })).toEqual([]);
  });
});
