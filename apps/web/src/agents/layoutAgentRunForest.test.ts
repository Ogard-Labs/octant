import { describe, expect, it } from "vitest";
import { buildAgentRunForest } from "@octant/domain";
import { forestRun } from "./agentRunForest.fixture";
import {
  AGENT_RUN_GRAPH_MARGIN,
  layoutAgentRunForest,
  runGraphId,
  threadGraphId,
} from "./layoutAgentRunForest";

describe("layoutAgentRunForest", () => {
  it("draws the grandchild below its parent", () => {
    const lead = forestRun({
      runId: "11111111-1111-4111-8111-111111111111",
      task: "Lead",
    });
    const child = forestRun({
      runId: "21111111-1111-4111-8111-111111111111",
      task: "Child",
      parentRunId: String(lead.runId),
      createdAt: "2026-08-01T10:02:00.000Z",
    });
    const grandchild = forestRun({
      runId: "31111111-1111-4111-8111-111111111111",
      task: "Grandchild",
      parentRunId: String(child.runId),
      createdAt: "2026-08-01T10:03:00.000Z",
    });
    const layout = layoutAgentRunForest(buildAgentRunForest([lead, child, grandchild]));
    const threadBox = layout.boxes.find((box) => box.kind === "thread");
    const leadBox = layout.boxes.find((box) => box.id === runGraphId(String(lead.runId)));
    const childBox = layout.boxes.find((box) => box.id === runGraphId(String(child.runId)));
    const grandchildBox = layout.boxes.find(
      (box) => box.id === runGraphId(String(grandchild.runId)),
    );
    expect(threadBox?.y).toBe(AGENT_RUN_GRAPH_MARGIN);
    expect(leadBox).toBeDefined();
    expect(childBox).toBeDefined();
    expect(grandchildBox).toBeDefined();
    if (leadBox === undefined || childBox === undefined || grandchildBox === undefined) return;
    expect(childBox.y).toBeGreaterThan(leadBox.y);
    expect(grandchildBox.y).toBeGreaterThan(childBox.y);
    expect(
      layout.edges.some(
        (edge) =>
          edge.fromId === runGraphId(String(lead.runId)) &&
          edge.toId === runGraphId(String(child.runId)),
      ),
    ).toBe(true);
    expect(
      layout.edges.some(
        (edge) =>
          edge.fromId === runGraphId(String(child.runId)) &&
          edge.toId === runGraphId(String(grandchild.runId)),
      ),
    ).toBe(true);
    expect(threadBox?.id).toBe(threadGraphId(String(lead.parentThreadId)));
  });

  it("places sibling parent threads side by side", () => {
    const design = forestRun({
      runId: "41111111-1111-4111-8111-111111111111",
      task: "Design work",
      parentThreadTitle: "Design chat",
    });
    const code = forestRun({
      runId: "51111111-1111-4111-8111-111111111111",
      task: "Code work",
      parentThreadId: "55555555-5555-4555-8555-555555555555",
      parentThreadTitle: "Implement auth",
    });
    const layout = layoutAgentRunForest(buildAgentRunForest([design, code]));
    const designThread = layout.boxes.find(
      (box) => box.kind === "thread" && box.thread.title === "Design chat",
    );
    const codeThread = layout.boxes.find(
      (box) => box.kind === "thread" && box.thread.title === "Implement auth",
    );
    expect(designThread).toBeDefined();
    expect(codeThread).toBeDefined();
    if (designThread === undefined || codeThread === undefined) return;
    expect(codeThread.x).toBeGreaterThan(designThread.x);
    expect(codeThread.y).toBe(designThread.y);
  });

  it("returns no boxes for an empty forest", () => {
    expect(layoutAgentRunForest({ threads: [] })).toEqual({
      width: 0,
      height: 0,
      boxes: [],
      edges: [],
    });
  });

  it("lays out the same forest the same way twice", () => {
    const lead = forestRun({
      runId: "61111111-1111-4111-8111-111111111111",
      task: "Lead",
    });
    const forest = buildAgentRunForest([lead]);
    expect(layoutAgentRunForest(forest)).toEqual(layoutAgentRunForest(forest));
  });
});
