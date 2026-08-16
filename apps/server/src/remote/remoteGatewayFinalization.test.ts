// R2/R3: Tests for the internal finalization sequence controller.
//
// These tests verify the deterministic finalization order (admission →
// sessions → work) and fail-stop behavior at each stage. The finalization
// logic is tested in isolation with injected finalizer functions — no
// bypass-capable factory is exported from the production gateway module.

import { describe, expect, it } from "vitest";
import { executeFinalizationSequence, type FinalizerFunctions } from "./remoteGatewayFinalization";

describe("RemoteGatewayFinalization — deterministic sequence", () => {
  it("R3: executes in order: admission → sessions → work", () => {
    const events: string[] = [];
    const finalizers: FinalizerFunctions = {
      stopAdmission: () => {
        events.push("admission");
      },
      invalidateSessions: () => {
        events.push("sessions");
        return { cancelHookFailures: 0 };
      },
      cancelWork: () => {
        events.push("work");
        return { canceled: 0, cancelHookFailures: 0 };
      },
    };
    const outcome = executeFinalizationSequence(finalizers);
    expect(outcome.failure).toBeUndefined();
    expect(events).toEqual(["admission", "sessions", "work"]);
  });

  it("R3: fail-stop at invalidation prevents work cancellation", () => {
    const events: string[] = [];
    const finalizers: FinalizerFunctions = {
      stopAdmission: () => {
        events.push("admission");
      },
      invalidateSessions: () => {
        events.push("sessions");
        return { cancelHookFailures: 3 };
      },
      cancelWork: () => {
        events.push("work");
        return { canceled: 0, cancelHookFailures: 0 };
      },
    };
    const outcome = executeFinalizationSequence(finalizers);
    expect(outcome.failure).toBeDefined();
    expect(outcome.failure!.kind).toBe("invalidation-failed");
    expect(outcome.failure!.cancelHookFailures).toBe(3);
    // Only admission and sessions were called — work was NOT called
    expect(events).toEqual(["admission", "sessions"]);
  });

  it("R3: fail-stop at cancellation reports failure but work was called", () => {
    const events: string[] = [];
    const finalizers: FinalizerFunctions = {
      stopAdmission: () => {
        events.push("admission");
      },
      invalidateSessions: () => {
        events.push("sessions");
        return { cancelHookFailures: 0 };
      },
      cancelWork: () => {
        events.push("work");
        return { canceled: 5, cancelHookFailures: 2 };
      },
    };
    const outcome = executeFinalizationSequence(finalizers);
    expect(outcome.failure).toBeDefined();
    expect(outcome.failure!.kind).toBe("cancellation-failed");
    expect(outcome.failure!.cancelHookFailures).toBe(2);
    // Admission, sessions, and work were called
    expect(events).toEqual(["admission", "sessions", "work"]);
  });

  it("R2: invalidation failure returns typed failure with hook count", () => {
    const finalizers: FinalizerFunctions = {
      stopAdmission: () => {},
      invalidateSessions: () => ({ cancelHookFailures: 3 }),
      cancelWork: () => ({ canceled: 0, cancelHookFailures: 0 }),
    };
    const outcome = executeFinalizationSequence(finalizers);
    expect(outcome.failure).toBeDefined();
    expect(outcome.failure!.kind).toBe("invalidation-failed");
    expect(outcome.failure!.cancelHookFailures).toBe(3);
  });

  it("R2: cancellation failure returns typed failure with hook count", () => {
    const finalizers: FinalizerFunctions = {
      stopAdmission: () => {},
      invalidateSessions: () => ({ cancelHookFailures: 0 }),
      cancelWork: () => ({ canceled: 5, cancelHookFailures: 2 }),
    };
    const outcome = executeFinalizationSequence(finalizers);
    expect(outcome.failure).toBeDefined();
    expect(outcome.failure!.kind).toBe("cancellation-failed");
    expect(outcome.failure!.cancelHookFailures).toBe(2);
  });

  it("R2: successful finalization returns no failure", () => {
    const finalizers: FinalizerFunctions = {
      stopAdmission: () => {},
      invalidateSessions: () => ({ cancelHookFailures: 0 }),
      cancelWork: () => ({ canceled: 3, cancelHookFailures: 0 }),
    };
    const outcome = executeFinalizationSequence(finalizers);
    expect(outcome.failure).toBeUndefined();
  });

  it("R3: admission is always called first, even when it throws", () => {
    // If stopAdmission throws, the error propagates — the sequence does
    // not catch it. This is intentional: admission clearing is a
    // synchronous prerequisite.
    const events: string[] = [];
    const finalizers: FinalizerFunctions = {
      stopAdmission: () => {
        events.push("admission");
        throw new Error("admission crash");
      },
      invalidateSessions: () => {
        events.push("sessions");
        return { cancelHookFailures: 0 };
      },
      cancelWork: () => {
        events.push("work");
        return { canceled: 0, cancelHookFailures: 0 };
      },
    };
    expect(() => executeFinalizationSequence(finalizers)).toThrow("admission crash");
    expect(events).toEqual(["admission"]);
  });
});
