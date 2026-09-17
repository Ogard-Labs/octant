import { describe, expect, it } from "vitest";
import { forestRun } from "./agentRunForest.fixture";
import { AGENT_RUN_GRAPH_MAX_DEPTH, buildAgentRunForest } from "./buildAgentRunForest";

const THREAD_A = "33333333-3333-4333-8333-333333333333";
const THREAD_B = "55555555-5555-4555-8555-555555555555";

describe("buildAgentRunForest", () => {
  it("places a child under the parent run that launched it", () => {
    const parent = forestRun({
      runId: "11111111-1111-4111-8111-111111111111",
      task: "Lead research",
    });
    const child = forestRun({
      runId: "21111111-1111-4111-8111-111111111111",
      task: "Review findings",
      parentRunId: String(parent.runId),
      role: "review",
      createdAt: "2026-08-01T10:02:00.000Z",
    });
    const forest = buildAgentRunForest([parent, child]);
    expect(forest.threads).toHaveLength(1);
    expect(forest.threads[0]?.title).toBe("Design chat");
    expect(forest.threads[0]?.roots).toHaveLength(1);
    expect(String(forest.threads[0]?.roots[0]?.summary.runId)).toBe(String(parent.runId));
    expect(forest.threads[0]?.roots[0]?.depth).toBe(0);
    expect(forest.threads[0]?.roots[0]?.children).toHaveLength(1);
    expect(String(forest.threads[0]?.roots[0]?.children[0]?.summary.runId)).toBe(
      String(child.runId),
    );
    expect(forest.threads[0]?.roots[0]?.children[0]?.depth).toBe(1);
  });

  it("keeps a child visible under its thread when the parent run is missing from the page", () => {
    const orphan = forestRun({
      runId: "31111111-1111-4111-8111-111111111111",
      task: "Orphaned review",
      parentRunId: "99999999-1111-4111-8111-111111111111",
    });
    const forest = buildAgentRunForest([orphan]);
    expect(forest.threads[0]?.roots).toHaveLength(1);
    expect(String(forest.threads[0]?.roots[0]?.summary.runId)).toBe(String(orphan.runId));
    expect(forest.threads[0]?.roots[0]?.depth).toBe(0);
    expect(forest.threads[0]?.roots[0]?.children).toEqual([]);
  });

  it("does not follow a cyclic parent run and still shows both runs", () => {
    const first = forestRun({
      runId: "41111111-1111-4111-8111-111111111111",
      task: "First",
      parentRunId: "51111111-1111-4111-8111-111111111111",
    });
    const second = forestRun({
      runId: "51111111-1111-4111-8111-111111111111",
      task: "Second",
      parentRunId: "41111111-1111-4111-8111-111111111111",
    });
    const forest = buildAgentRunForest([first, second]);
    const rootIds = forest.threads[0]?.roots.map((node) => String(node.summary.runId)) ?? [];
    expect(rootIds).toEqual([String(first.runId), String(second.runId)]);
    expect(forest.threads[0]?.roots.every((node) => node.children.length === 0)).toBe(true);
  });

  it("refuses a third run level and still shows the run under its thread", () => {
    expect(AGENT_RUN_GRAPH_MAX_DEPTH).toBe(2);
    const lead = forestRun({
      runId: "61111111-1111-4111-8111-111111111111",
      task: "Lead",
    });
    const child = forestRun({
      runId: "71111111-1111-4111-8111-111111111111",
      task: "Child",
      parentRunId: String(lead.runId),
      createdAt: "2026-08-01T10:02:00.000Z",
    });
    const grandchild = forestRun({
      runId: "81111111-1111-4111-8111-111111111111",
      task: "Grandchild",
      parentRunId: String(child.runId),
      createdAt: "2026-08-01T10:03:00.000Z",
    });
    const tooDeep = forestRun({
      runId: "91111111-1111-4111-8111-111111111111",
      task: "Too deep",
      parentRunId: String(grandchild.runId),
      createdAt: "2026-08-01T10:04:00.000Z",
    });
    const forest = buildAgentRunForest([lead, child, grandchild, tooDeep]);
    const leadNode = forest.threads[0]?.roots[0];
    expect(leadNode?.children[0]?.children).toHaveLength(1);
    expect(String(leadNode?.children[0]?.children[0]?.summary.runId)).toBe(
      String(grandchild.runId),
    );
    const rootIds = forest.threads[0]?.roots.map((node) => String(node.summary.runId)) ?? [];
    expect(rootIds).toContain(String(tooDeep.runId));
  });

  it("groups separate parent threads as sibling trees", () => {
    const design = forestRun({
      runId: "a1111111-1111-4111-8111-111111111111",
      task: "Design work",
      parentThreadId: THREAD_A,
      parentThreadTitle: "Design chat",
    });
    const code = forestRun({
      runId: "b1111111-1111-4111-8111-111111111111",
      task: "Code work",
      parentThreadId: THREAD_B,
      parentThreadTitle: "Implement auth",
      createdAt: "2026-08-01T11:00:00.000Z",
    });
    const forest = buildAgentRunForest([design, code]);
    expect(forest.threads.map((thread) => thread.title)).toEqual(["Design chat", "Implement auth"]);
    expect(forest.threads[1]?.parentThreadId).toBe(THREAD_B);
  });

  it("returns no trees when the center page is empty", () => {
    expect(buildAgentRunForest([])).toEqual({ threads: [] });
  });
});
