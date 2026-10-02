import type { AgentRunId, AgentRunLifecycleStatus } from "@octant/contracts";
import { describe, expect, it } from "vitest";
import {
  AGENT_RUN_DEPENDENCY_WAITING_REASON,
  decideAgentRunDependencies,
} from "./agentRunDependencyPolicy";

const a = "00000000-0000-4000-8000-00000000000a" as AgentRunId;
const b = "00000000-0000-4000-8000-00000000000b" as AgentRunId;

function decide(statuses: Record<string, AgentRunLifecycleStatus>) {
  return decideAgentRunDependencies(
    {
      lifecycleStatus: "waiting",
      recoveryReason: AGENT_RUN_DEPENDENCY_WAITING_REASON,
      dependsOn: [a, b],
    },
    (id) => {
      const lifecycleStatus = statuses[String(id)];
      return lifecycleStatus === undefined ? undefined : { lifecycleStatus };
    },
  );
}

describe("agent run dependencies", () => {
  it("keeps a run waiting until every dependency completed, then lets it start", () => {
    expect(decide({ [a]: "completed", [b]: "running" })).toEqual({ kind: "wait", pending: [b] });
    expect(decide({ [a]: "completed", [b]: "completed" })).toEqual({ kind: "ready" });
  });

  it("fails a run whose dependency failed or was cancelled, naming which", () => {
    expect(decide({ [a]: "completed", [b]: "failed" })).toEqual({
      kind: "fail",
      recoveryReason: `dependency-failed: ${b}`,
    });
    expect(decide({ [a]: "cancelled", [b]: "running" })).toEqual({
      kind: "fail",
      recoveryReason: `dependency-cancelled: ${a}`,
    });
  });

  it("keeps waiting on an interrupted dependency, which a retry can still complete", () => {
    expect(decide({ [a]: "interrupted", [b]: "completed" })).toEqual({
      kind: "wait",
      pending: [a],
    });
  });

  it("fails a run whose dependency no longer exists", () => {
    expect(decide({ [a]: "completed" })).toMatchObject({ kind: "fail" });
  });

  it("decides nothing for a run that is not parked on its dependencies", () => {
    expect(
      decideAgentRunDependencies(
        { lifecycleStatus: "running", recoveryReason: undefined, dependsOn: [a] },
        () => ({ lifecycleStatus: "completed" }),
      ),
    ).toEqual({ kind: "not-waiting" });
  });
});
