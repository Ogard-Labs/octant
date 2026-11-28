import type {
  AutomationOpaqueReference,
  AutomationThreadId,
  ProjectId,
  UtcTimestamp,
} from "@octant/contracts";
import { describe, expect, it } from "vitest";
import { decideRoutineFromAgent } from "./automationPolicy";
import {
  decideThreadFinishWaitArming,
  defaultThreadFinishWaitExpiry,
  evaluateThreadFinishWait,
  isThreadFinishConditionMetNow,
  type ThreadFinishTargetFacts,
} from "./automationThreadFinishPolicy";

const TARGET_ID = "44444444-4444-4444-8444-444444444444" as AutomationThreadId;
const ORIGIN_ID = "33333333-3333-4333-8333-333333333333" as AutomationThreadId;
const PROJECT_ID = "55555555-5555-4555-8555-555555555555" as ProjectId;
const ARMED_AT = "2026-11-28T10:00:00.000Z" as UtcTimestamp;
const EXPIRES_AT = defaultThreadFinishWaitExpiry(ARMED_AT);

function presentTarget(
  overrides: Partial<Extract<ThreadFinishTargetFacts, { readonly kind: "present" }>> = {},
): Extract<ThreadFinishTargetFacts, { readonly kind: "present" }> {
  return {
    kind: "present",
    threadId: String(TARGET_ID),
    mode: "code",
    projectId: String(PROJECT_ID),
    working: false,
    hasOpenRequest: false,
    hasPendingDecision: false,
    hasQueuedMessage: false,
    done: false,
    latestCompletedTurn: {
      turnId: "turn-2",
      completedAt: "2026-11-28T10:15:00.000Z" as UtcTimestamp,
    },
    ...overrides,
  };
}

describe("thread-finished arming and evaluation policy", () => {
  it("refuses self-wait, child-run wait, and waits past per-thread or host bounds", () => {
    const base = {
      originThreadId: String(ORIGIN_ID),
      targetThreadId: String(TARGET_ID),
      isTargetChildOfOrigin: false,
      targetAvailable: true,
      activeWaitsForOriginThread: 0,
      activeWaitsForHost: 0,
      armedAt: ARMED_AT,
      expiresAt: EXPIRES_AT,
    };
    expect(decideThreadFinishWaitArming(base)).toEqual({ kind: "allowed" });
    expect(
      decideThreadFinishWaitArming({ ...base, targetThreadId: String(ORIGIN_ID) }),
    ).toMatchObject({ kind: "refused", reason: "self-wait" });
    expect(decideThreadFinishWaitArming({ ...base, isTargetChildOfOrigin: true })).toMatchObject({
      kind: "refused",
      reason: "child-run-wait",
    });
    expect(decideThreadFinishWaitArming({ ...base, activeWaitsForOriginThread: 8 })).toMatchObject({
      kind: "refused",
      reason: "thread-wait-limit",
    });
    expect(decideThreadFinishWaitArming({ ...base, activeWaitsForHost: 32 })).toMatchObject({
      kind: "refused",
      reason: "host-wait-limit",
    });
  });

  it("fires turn-finished only when idle with no open request, pending decision, or queued message and a new completed turn", () => {
    const wait = {
      targetThreadId: TARGET_ID,
      targetMode: "code" as const,
      targetProjectId: PROJECT_ID,
      condition: "turn-finished" as const,
      armedAt: ARMED_AT,
      expiresAt: EXPIRES_AT,
      baselineTurnId: "turn-1" as AutomationOpaqueReference,
      state: "armed" as const,
    };
    const now = "2026-11-28T10:20:00.000Z" as UtcTimestamp;

    expect(evaluateThreadFinishWait({ wait, target: presentTarget(), now })).toEqual({
      kind: "fire",
      attestedTurnId: "turn-2",
      finishedAt: "2026-11-28T10:15:00.000Z",
    });

    // Still working, waiting on approval/question, pending decision, or queued message never fires.
    expect(
      evaluateThreadFinishWait({ wait, target: presentTarget({ working: true }), now }),
    ).toEqual({ kind: "waiting" });
    expect(
      evaluateThreadFinishWait({ wait, target: presentTarget({ hasOpenRequest: true }), now }),
    ).toEqual({ kind: "waiting" });
    expect(
      evaluateThreadFinishWait({ wait, target: presentTarget({ hasPendingDecision: true }), now }),
    ).toEqual({ kind: "waiting" });
    expect(
      evaluateThreadFinishWait({ wait, target: presentTarget({ hasQueuedMessage: true }), now }),
    ).toEqual({ kind: "waiting" });

    // Baseline turn from before arming or a turn completed before arming never fires.
    expect(
      evaluateThreadFinishWait({
        wait,
        target: presentTarget({
          latestCompletedTurn: {
            turnId: "turn-1",
            completedAt: "2026-11-28T10:15:00.000Z" as UtcTimestamp,
          },
        }),
        now,
      }),
    ).toEqual({ kind: "waiting" });
    expect(
      evaluateThreadFinishWait({
        wait,
        target: presentTarget({
          latestCompletedTurn: {
            turnId: "turn-old",
            completedAt: "2026-11-28T09:59:59.000Z" as UtcTimestamp,
          },
        }),
        now,
      }),
    ).toEqual({ kind: "waiting" });
  });

  it("holds stale finishes past the lateness window as missed, expires after 7 days, and marks missing targets unavailable", () => {
    const wait = {
      targetThreadId: TARGET_ID,
      targetMode: "code" as const,
      targetProjectId: PROJECT_ID,
      condition: "turn-finished" as const,
      armedAt: ARMED_AT,
      expiresAt: EXPIRES_AT,
      state: "armed" as const,
    };

    // More than 24h after completion -> missed.
    expect(
      evaluateThreadFinishWait({
        wait,
        target: presentTarget({
          latestCompletedTurn: {
            turnId: "turn-2",
            completedAt: "2026-11-28T10:15:00.000Z" as UtcTimestamp,
          },
        }),
        now: "2026-11-29T10:15:01.000Z" as UtcTimestamp,
      }),
    ).toMatchObject({ kind: "missed", attestedTurnId: "turn-2" });

    // Past 7-day expiry with no completion -> expired.
    expect(
      evaluateThreadFinishWait({
        wait,
        target: presentTarget({ working: true }),
        now: "2026-12-05T10:00:00.000Z" as UtcTimestamp,
      }),
    ).toMatchObject({ kind: "expired" });

    // Missing or moved target -> unavailable, never fires.
    expect(
      evaluateThreadFinishWait({
        wait,
        target: { kind: "unavailable", reason: "deleted" },
        now: "2026-11-28T10:20:00.000Z" as UtcTimestamp,
      }),
    ).toMatchObject({ kind: "unavailable", reason: "deleted" });
  });

  it("evaluates done waits only on unambiguous done truth and detects already-met targets", () => {
    const doneWait = {
      targetThreadId: TARGET_ID,
      targetMode: "code" as const,
      targetProjectId: PROJECT_ID,
      condition: "done" as const,
      armedAt: ARMED_AT,
      expiresAt: EXPIRES_AT,
      state: "armed" as const,
    };
    const now = "2026-11-28T10:20:00.000Z" as UtcTimestamp;

    expect(
      evaluateThreadFinishWait({ wait: doneWait, target: presentTarget({ done: false }), now }),
    ).toEqual({ kind: "waiting" });
    expect(
      evaluateThreadFinishWait({
        wait: doneWait,
        target: presentTarget({
          done: true,
          doneAt: "2026-11-28T10:18:00.000Z" as UtcTimestamp,
        }),
        now,
      }),
    ).toEqual({
      kind: "fire",
      attestedTurnId: "turn-2",
      finishedAt: "2026-11-28T10:18:00.000Z",
    });

    expect(isThreadFinishConditionMetNow(presentTarget({ done: true }), "done")).toBe(true);
    expect(isThreadFinishConditionMetNow(presentTarget({ done: false }), "done")).toBe(false);
    expect(isThreadFinishConditionMetNow(presentTarget({ working: true }), "turn-finished")).toBe(
      false,
    );
    expect(isThreadFinishConditionMetNow(presentTarget({ working: false }), "turn-finished")).toBe(
      true,
    );
  });

  it("keeps agent-proposed finish waits on the approval card at every level including Full access", () => {
    expect(
      decideRoutineFromAgent({
        requestedByPerson: true,
        followUp: false,
        finishWait: true,
        posture: "full-access",
        startActiveAtFullAccess: true,
        strict: false,
        readOutsideContent: false,
      }),
    ).toBe("ask-on-card");
  });
});
