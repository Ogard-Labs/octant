import type {
  AutomationDigest,
  AutomationFirstTurnRequestId,
  AutomationRun,
  AutomationThreadId,
  CodeThreadId,
  WorkThreadId,
  UtcTimestamp,
  WindowId,
} from "@octant/contracts";

export type AutomationThreadCreationOutcome =
  | {
      readonly kind: "created";
      readonly threadId: AutomationThreadId;
      readonly createdAt: UtcTimestamp;
    }
  | {
      readonly kind: "existing";
      readonly threadId: AutomationThreadId;
    }
  | {
      readonly kind: "failed";
      readonly reason: "thread-creation-failed" | "unavailable" | "unauthorized" | "conflict";
      readonly message: string;
    };

export type AutomationFirstTurnLaunchOutcome =
  | {
      readonly kind: "accepted";
      readonly runtimeReceipt: string;
      readonly acceptedAt: UtcTimestamp;
    }
  | {
      readonly kind: "waiting-capacity";
      readonly message: string;
    }
  | {
      readonly kind: "failed";
      readonly reason: "provider-launch-failed" | "recovery-failed" | "cancelled";
      readonly message: string;
    };

/**
 * Code adapter behind the ordinary managed-worktree / provider-turn path.
 * Implementations must be idempotent for the deterministic thread id and
 * first-turn request id derived from the occurrence.
 */
export interface AutomationCodeDispatchPort {
  readonly createApprovalGatedThread: (input: {
    readonly run: AutomationRun;
    readonly threadId: CodeThreadId;
    readonly title: string;
    readonly windowId: WindowId;
  }) => Promise<AutomationThreadCreationOutcome>;
  readonly startOrRecoverFirstTurn: (input: {
    readonly run: AutomationRun;
    readonly threadId: CodeThreadId;
    readonly firstTurnRequestId: AutomationFirstTurnRequestId;
    readonly promptDigest: AutomationDigest;
    readonly windowId: WindowId;
  }) => Promise<AutomationFirstTurnLaunchOutcome>;
}

/**
 * Work adapter behind the ordinary create-thread / first-turn path.
 * Production wiring uses {@link createAutomationWorkDispatchPort}; tests and
 * negative paths may still inject {@link unavailableAutomationWorkDispatchPort}.
 */
export interface AutomationWorkDispatchPort {
  readonly available: boolean;
  readonly unavailableReason: string | undefined;
  readonly createThread: (input: {
    readonly run: AutomationRun;
    readonly threadId: WorkThreadId;
    readonly title: string;
    readonly windowId: WindowId;
  }) => Promise<AutomationThreadCreationOutcome>;
  readonly startOrRecoverFirstTurn: (input: {
    readonly run: AutomationRun;
    readonly threadId: WorkThreadId;
    readonly firstTurnRequestId: AutomationFirstTurnRequestId;
    readonly promptDigest: AutomationDigest;
    readonly windowId: WindowId;
  }) => Promise<AutomationFirstTurnLaunchOutcome>;
}

/**
 * Test/fallback Work gate that fails closed. Production hosts wire
 * {@link createAutomationWorkDispatchPort} instead once the provider-backed
 * first-turn runtime is available.
 */
export function unavailableAutomationWorkDispatchPort(
  reason = "Work first-turn runtime is unavailable for Automation dispatch.",
): AutomationWorkDispatchPort {
  return {
    available: false,
    unavailableReason: reason,
    createThread: async () => ({
      kind: "failed",
      reason: "unavailable",
      message: reason,
    }),
    startOrRecoverFirstTurn: async () => ({
      kind: "failed",
      reason: "provider-launch-failed",
      message: reason,
    }),
  };
}

export interface AutomationDispatchWindowPort {
  /** Resolve a local window that may authorize Project-bound thread creation. */
  readonly resolveWindowForProject: (projectId: string) => WindowId | undefined;
}

export interface AutomationCapacityAdmissionPort {
  readonly admit: (input: {
    readonly reservationId: string;
    readonly providerInstanceId: string;
    readonly modelId: string;
    readonly subjectThreadId: string;
  }) =>
    | { readonly kind: "admitted"; readonly release: () => void }
    | { readonly kind: "waiting"; readonly message: string };
}
