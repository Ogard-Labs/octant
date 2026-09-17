import { describe, expect, it } from "vitest";
import { buildAgentRunForest } from "./agentRunForest";
import { agentRunForestCanvasTitle, buildAgentRunForestCanvasBlocks } from "./agentRunForestCanvas";
import type { AgentRunForestMember } from "./agentRunForest";

const THREAD_A = "33333333-3333-4333-8333-333333333333";

function member(overrides: {
  readonly runId: string;
  readonly task: string;
  readonly parentThreadId?: string;
  readonly parentThreadTitle?: string;
  readonly parentRunId?: string;
  readonly role?: string;
  readonly createdAt?: string;
}): AgentRunForestMember {
  return {
    runId: overrides.runId,
    parentThreadId: overrides.parentThreadId ?? THREAD_A,
    parentThreadTitle: overrides.parentThreadTitle ?? "Design chat",
    ...(overrides.parentRunId === undefined ? {} : { parentRunId: overrides.parentRunId }),
    mode: "chat",
    role: overrides.role ?? "research",
    task: overrides.task,
    createdAt: overrides.createdAt ?? "2026-08-01T10:00:00.000Z",
  };
}

describe("buildAgentRunForestCanvasBlocks", () => {
  it("snapshots launch edges from parent thread to child to grandchild", () => {
    const lead = member({
      runId: "11111111-1111-4111-8111-111111111111",
      task: "Lead research",
    });
    const child = member({
      runId: "21111111-1111-4111-8111-111111111111",
      task: "Review findings",
      parentRunId: lead.runId,
      role: "review",
      createdAt: "2026-08-01T10:02:00.000Z",
    });
    const grandchild = member({
      runId: "31111111-1111-4111-8111-111111111111",
      task: "Tighten the review",
      parentRunId: child.runId,
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
    expect(diagram.layout).toBe("auto");
  });

  it("returns no blocks for an empty forest", () => {
    expect(buildAgentRunForestCanvasBlocks({ threads: [] })).toEqual([]);
  });

  it("keeps a Canvas title inside the card limit", () => {
    const title = agentRunForestCanvasTitle("A".repeat(300));
    expect(title.endsWith(" agent graph")).toBe(true);
    expect(title.length).toBeLessThanOrEqual(256);
  });
});
