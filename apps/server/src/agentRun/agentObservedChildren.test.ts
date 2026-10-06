import { describe, expect, it } from "vitest";
import { decodeAgentRunParentThreadId, decodeProviderRuntimeEvent } from "@octant/contracts";
import { observedChildren } from "./agentObservedChildren";

const root = decodeAgentRunParentThreadId("00000000-0000-4000-8000-000000000003");
function report(childAgentId: string, sequence: number, parentChildAgentId?: string) {
  const value = decodeProviderRuntimeEvent({
    kind: "child-agent-activity",
    instanceId: "00000000-0000-4000-8000-000000000001",
    sessionId: "00000000-0000-4000-8000-000000000002",
    correlationId: root,
    occurredAt: "2026-10-03T20:00:00.000Z",
    sequence,
    childAgentId,
    status: "running",
    summary: "Reading",
    ...(parentChildAgentId === undefined ? {} : { parentChildAgentId }),
  });
  if (value.kind !== "child-agent-activity") throw new Error("Invalid fixture");
  return value;
}
describe("observed child reads", () => {
  it("scopes identity by mode and root while refusing missing or circular lineage", () => {
    const events = [
      report("parent", 1),
      report("child", 2, "parent"),
      report("orphan", 3, "missing"),
      report("a", 4, "b"),
      report("b", 5, "a"),
    ];
    const chat = observedChildren({ parentThreadId: root, mode: "chat", events });
    expect(chat.observations.map((child) => child.childAgentId)).toEqual(["parent", "child"]);
    expect(
      chat.observations.every(
        (child) =>
          child.control === "unavailable" && child.parentThreadId === root && !("runId" in child),
      ),
    ).toBe(true);
    expect(chat.observations[0]?.observationId).not.toBe(
      observedChildren({ parentThreadId: root, mode: "code", events }).observations[0]
        ?.observationId,
    );
    expect(
      observedChildren({ parentThreadId: root, mode: "chat", events: [...events, ...events] }),
    ).toEqual(chat);
  });
});
