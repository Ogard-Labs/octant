import { decodeCodeThreadId } from "@octant/contracts/code";
import type { CodeOperationEvent } from "@octant/contracts/code-operations";
import type { AggregateVersion, UtcTimestamp } from "@octant/contracts/events";
import { describe, expect, it } from "vitest";
import {
  CodeFollowUpPolicyRejected,
  completeCodeFollowUp,
  deriveCodeFollowUpTrigger,
  evaluateCodeFollowUpTrigger,
} from "./codeFollowUpPolicy";

const threadId = decodeCodeThreadId("20000000-0000-4000-8000-000000000001");
const now = "2026-07-21T12:00:00.000Z" as UtcTimestamp;

describe("code thread follow-up policy", () => {
  it("opens follow-up on a new trigger and adopts newer, ignores older", () => {
    const first = evaluateCodeFollowUpTrigger(threadId, undefined, {
      sequence: 5,
      reason: "Approval requested: git-push",
      origin: "automatic",
      triggeredAt: now,
    });
    expect(first.state).toBe("open");
    expect(first.triggerSequence).toBe(5);
    expect(first.acknowledgedThroughSequence).toBe(0);

    const second = evaluateCodeFollowUpTrigger(threadId, first, {
      sequence: 10,
      reason: "Input requested",
      origin: "manual",
      triggeredAt: now,
    });
    expect(second.triggerSequence).toBe(10);
    expect(second.reason).toBe("Input requested");

    const older = evaluateCodeFollowUpTrigger(threadId, second, {
      sequence: 7,
      reason: "Stale",
      origin: "automatic",
      triggeredAt: now,
    });
    expect(older.triggerSequence).toBe(10);
    expect(older.reason).toBe("Input requested");
  });

  it("is idempotent for duplicate and replayed triggers", () => {
    const open = evaluateCodeFollowUpTrigger(threadId, undefined, {
      sequence: 5,
      reason: "Approval requested: git-push",
      origin: "automatic",
      triggeredAt: now,
    });
    const duplicate = evaluateCodeFollowUpTrigger(threadId, open, {
      sequence: 5,
      reason: "Different reason on replay",
      origin: "manual",
      triggeredAt: now,
    });
    expect(duplicate).toEqual(open);
  });

  it("never clears on view and reopens once only on a strictly newer trigger", () => {
    const open = evaluateCodeFollowUpTrigger(threadId, undefined, {
      sequence: 5,
      reason: "Approval requested: git-push",
      origin: "automatic",
      triggeredAt: now,
    });
    const completed = completeCodeFollowUp(0 as AggregateVersion, open, {
      expectedVersion: 0 as AggregateVersion,
      acknowledgedThroughSequence: 5,
      completedAt: now,
    });
    expect(completed.state).toBe("completed");
    expect(completed.completedAt).toBe(now);

    // Viewing (an older/equal trigger) never reopens.
    const viewedOlder = evaluateCodeFollowUpTrigger(threadId, completed, {
      sequence: 3,
      reason: "Viewed",
      origin: "manual",
      triggeredAt: now,
    });
    expect(viewedOlder.state).toBe("completed");
    const sameTrigger = evaluateCodeFollowUpTrigger(threadId, completed, {
      sequence: 5,
      reason: "Same acknowledged trigger",
      origin: "automatic",
      triggeredAt: now,
    });
    expect(sameTrigger.state).toBe("completed");

    // A strictly newer actionable trigger reopens exactly once.
    const reopened = evaluateCodeFollowUpTrigger(threadId, completed, {
      sequence: 12,
      reason: "New approval",
      origin: "automatic",
      triggeredAt: now,
    });
    expect(reopened.state).toBe("open");
    expect(reopened.triggerSequence).toBe(12);
    expect(reopened.acknowledgedThroughSequence).toBe(5);
    expect(reopened.completedAt).toBeUndefined();
  });

  it("rejects empty reasons and invalid completions", () => {
    expect(() =>
      evaluateCodeFollowUpTrigger(threadId, undefined, {
        sequence: 1,
        reason: "   ",
        origin: "manual",
        triggeredAt: now,
      }),
    ).toThrow(CodeFollowUpPolicyRejected);

    const open = evaluateCodeFollowUpTrigger(threadId, undefined, {
      sequence: 5,
      reason: "Approval requested: git-push",
      origin: "automatic",
      triggeredAt: now,
    });
    // Wrong acknowledged sequence is rejected.
    expect(() =>
      completeCodeFollowUp(0 as AggregateVersion, open, {
        expectedVersion: 0 as AggregateVersion,
        acknowledgedThroughSequence: 4,
        completedAt: now,
      }),
    ).toThrow(CodeFollowUpPolicyRejected);
    // Stale expected version is rejected.
    expect(() =>
      completeCodeFollowUp(1 as AggregateVersion, open, {
        expectedVersion: 0 as AggregateVersion,
        acknowledgedThroughSequence: 5,
        completedAt: now,
      }),
    ).toThrow(CodeFollowUpPolicyRejected);
    // Completing an already-completed marker is rejected.
    const completed = completeCodeFollowUp(0 as AggregateVersion, open, {
      expectedVersion: 0 as AggregateVersion,
      acknowledgedThroughSequence: 5,
      completedAt: now,
    });
    expect(() =>
      completeCodeFollowUp(1 as AggregateVersion, completed, {
        expectedVersion: 1 as AggregateVersion,
        acknowledgedThroughSequence: 5,
        completedAt: now,
      }),
    ).toThrow(CodeFollowUpPolicyRejected);
  });
});

describe("code follow-up automatic trigger derivation", () => {
  function event(partial: CodeOperationEvent): CodeOperationEvent {
    return partial;
  }

  it("derives triggers only from user-actionable structural edges", () => {
    expect(
      deriveCodeFollowUpTrigger(
        event({
          kind: "approval-requested",
          approvalId: "c0000000-0000-4000-8000-000000000001" as never,
          action: "git-push",
          summary: "Push to origin",
        }),
      ),
    ).toEqual({ origin: "automatic", reason: "Approval requested: git-push" });

    expect(
      deriveCodeFollowUpTrigger(
        event({
          kind: "input-requested",
          requestId: "req-1",
          prompt: "Which branch?",
          options: [],
        }),
      ),
    ).toEqual({ origin: "automatic", reason: "The agent is waiting for your input." });

    expect(
      deriveCodeFollowUpTrigger(
        event({ kind: "task-progress", taskId: "t1", state: "waiting", summary: "Needs review" }),
      ),
    ).toEqual({ origin: "automatic", reason: "Task needs attention: Needs review" });

    expect(
      deriveCodeFollowUpTrigger(
        event({ kind: "child-activity", childId: "c1", state: "failed", summary: "crashed" }),
      ),
    ).toEqual({ origin: "automatic", reason: "Subagent failed: crashed" });

    expect(deriveCodeFollowUpTrigger(event({ kind: "operation-state", state: "waiting" }))).toEqual(
      { origin: "automatic", reason: "The operation is waiting for you." },
    );
  });

  it("never derives a trigger from ordinary prose, telemetry, or plain progress", () => {
    expect(
      deriveCodeFollowUpTrigger(
        event({
          kind: "provider-content",
          channel: "message",
          content: {
            contentId: "80000000-0000-4000-8000-000000000001" as never,
            digest: "sha256:" + "a".repeat(64),
            byteLength: 4,
          },
        }),
      ),
    ).toBeUndefined();
    expect(
      deriveCodeFollowUpTrigger(event({ kind: "usage", inputTokens: 10, outputTokens: 20 })),
    ).toBeUndefined();
    expect(
      deriveCodeFollowUpTrigger(
        event({ kind: "task-progress", taskId: "t1", state: "running", summary: "working" }),
      ),
    ).toBeUndefined();
    expect(
      deriveCodeFollowUpTrigger(event({ kind: "operation-state", state: "running" })),
    ).toBeUndefined();
  });
});
