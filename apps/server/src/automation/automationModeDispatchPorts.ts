import type {
  AutomationDigest,
  AutomationFirstTurnRequestId,
  AutomationRun,
  AutomationThreadId,
  ChatThreadId,
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
    /** The routine host scope; a routine never acts through a window. */
    readonly scopeId: WindowId;
  }) => Promise<AutomationThreadCreationOutcome>;
  readonly startOrRecoverFirstTurn: (input: {
    readonly run: AutomationRun;
    readonly threadId: CodeThreadId;
    readonly firstTurnRequestId: AutomationFirstTurnRequestId;
    readonly promptDigest: AutomationDigest;
    /** The routine host scope; a routine never acts through a window. */
    readonly scopeId: WindowId;
  }) => Promise<AutomationFirstTurnLaunchOutcome>;
}

/**
 * Work adapter behind the ordinary create-thread / first-turn path.
 * Production wiring uses {@link createAutomationWorkDispatchPort}.
 */
export interface AutomationWorkDispatchPort {
  readonly available: boolean;
  readonly unavailableReason: string | undefined;
  readonly createThread: (input: {
    readonly run: AutomationRun;
    readonly threadId: WorkThreadId;
    readonly title: string;
    /** The routine host scope; a routine never acts through a window. */
    readonly scopeId: WindowId;
  }) => Promise<AutomationThreadCreationOutcome>;
  readonly startOrRecoverFirstTurn: (input: {
    readonly run: AutomationRun;
    readonly threadId: WorkThreadId;
    readonly firstTurnRequestId: AutomationFirstTurnRequestId;
    readonly promptDigest: AutomationDigest;
    /** The routine host scope; a routine never acts through a window. */
    readonly scopeId: WindowId;
  }) => Promise<AutomationFirstTurnLaunchOutcome>;
}

/**
 * Chat adapter behind the ordinary create-thread / send-turn path. A Chat
 * routine keeps Chat's authority, so the adapter hands the host's own Chat
 * service nothing a Chat thread could not already do.
 */
export interface AutomationChatDispatchPort {
  readonly createThread: (input: {
    readonly run: AutomationRun;
    readonly threadId: ChatThreadId;
    readonly title: string;
  }) => Promise<AutomationThreadCreationOutcome>;
  readonly startOrRecoverFirstTurn: (input: {
    readonly run: AutomationRun;
    readonly threadId: ChatThreadId;
    readonly firstTurnRequestId: AutomationFirstTurnRequestId;
    readonly promptDigest: AutomationDigest;
  }) => Promise<AutomationFirstTurnLaunchOutcome>;
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
