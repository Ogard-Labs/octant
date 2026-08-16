import { describe, expect, it } from "vitest";
import {
  AgentRunSessionError,
  isAgentRunSessionDeath,
  type AgentRunSessionOutcome,
} from "./agentRunSessionPort";

describe("AgentRunSessionError", () => {
  it("keeps the precondition reason so a host can report the exact missing dependency", () => {
    const error = new AgentRunSessionError(
      "provider-unavailable",
      "Provider instance is not configured on this host.",
    );

    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("AgentRunSessionError");
    expect(error.reason).toBe("provider-unavailable");
  });
});

describe("isAgentRunSessionDeath", () => {
  it("treats only a clean completion as a session that did not die", () => {
    const outcomes: ReadonlyArray<readonly [AgentRunSessionOutcome, boolean]> = [
      [{ kind: "completed", responseText: "done" }, false],
      [{ kind: "waiting", reason: "Approval required." }, true],
      [{ kind: "cancelled" }, true],
      [
        {
          kind: "failed",
          failure: { category: "provider-failed", message: "boom" },
        },
        true,
      ],
      [{ kind: "interrupted", reason: "ambiguous" }, true],
    ];

    for (const [outcome, expected] of outcomes) {
      expect(isAgentRunSessionDeath(outcome)).toBe(expected);
    }
  });
});
