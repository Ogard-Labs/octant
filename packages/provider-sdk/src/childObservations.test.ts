import { describe, expect, it } from "vitest";
import { decodeProviderRuntimeEvent } from "@octant/contracts";
import { recordProviderChildObservation } from "./childObservations";

const activity = (patch: Record<string, unknown> = {}) => {
  const event = decodeProviderRuntimeEvent({
    kind: "child-agent-activity",
    instanceId: "00000000-0000-4000-8000-000000000001",
    sessionId: "00000000-0000-4000-8000-000000000002",
    correlationId: "00000000-0000-4000-8000-000000000003",
    sequence: 1,
    occurredAt: "2026-10-03T20:00:00.000Z",
    childAgentId: "child",
    status: "running",
    summary: "Inspecting files",
    ...patch,
  });
  if (event.kind !== "child-agent-activity") throw new Error("Invalid fixture");
  return event;
};

describe("provider child observations", () => {
  it("deduplicates replay without granting controls or guessing a model", () => {
    const first = recordProviderChildObservation(undefined, activity());
    expect(first.children).toHaveLength(1);
    expect(first.children[0]).toMatchObject({
      lifecycleStatus: "running",
      historyStatus: "partial",
    });
    expect(first.children[0]?.modelId).toBeUndefined();
    expect(recordProviderChildObservation(first, activity())).toBe(first);
  });
  it("keeps provider sessions separate and refuses conflicting identity or replay", () => {
    const first = recordProviderChildObservation(
      undefined,
      activity({ modelId: "child-model", parentChildAgentId: "parent" }),
    );
    const missingMetadata = recordProviderChildObservation(
      first,
      activity({ sequence: 2, status: "completed" }),
    );
    expect(missingMetadata.children[0]?.parentChildAgentId).toBe("parent");
    expect(missingMetadata.children[0]?.modelId).toBe("child-model");
    const otherSession = recordProviderChildObservation(
      first,
      activity({ sessionId: "00000000-0000-4000-8000-000000000004" }),
    );
    expect(otherSession.children).toHaveLength(2);
    for (const patch of [
      { modelId: "foreign-model" },
      { parentChildAgentId: "foreign-parent" },
      { summary: "Different report" },
    ]) {
      const conflict = recordProviderChildObservation(
        first,
        activity({ modelId: "child-model", parentChildAgentId: "parent", ...patch }),
      );
      expect(conflict.children[0]).toMatchObject({
        lifecycleStatus: "unknown",
        historyStatus: "conflicted",
      });
      expect(recordProviderChildObservation(conflict, activity({ sequence: 3 }))).toBe(conflict);
    }
  });

  it("refuses two child identities claiming the same provider event", () => {
    const first = recordProviderChildObservation(undefined, activity());
    const conflict = recordProviderChildObservation(
      first,
      activity({ childAgentId: "foreign-child" }),
    );
    expect(conflict.children).toHaveLength(1);
    expect(conflict.children[0]).toMatchObject({
      historyStatus: "conflicted",
      lifecycleStatus: "unknown",
    });
    expect(conflict.truncated).toBe(true);
  });

  it("bounds history and refuses old replay from restoring discarded entries", () => {
    let state = recordProviderChildObservation(undefined, activity());
    for (let sequence = 2; sequence <= 20; sequence++)
      state = recordProviderChildObservation(state, activity({ sequence }));
    expect(state.children[0]?.history).toHaveLength(8);
    expect(state.children[0]?.historyStatus).toBe("truncated");
    expect(recordProviderChildObservation(state, activity())).toBe(state);
    for (let child = 1; child <= 20; child++)
      state = recordProviderChildObservation(
        state,
        activity({ childAgentId: `child-${child}`, sequence: 20 + child }),
      );
    expect(state.children).toHaveLength(16);
    expect(state.truncated).toBe(true);
  });
});
