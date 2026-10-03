import type {
  ThreadMessageQueueCommand,
  ThreadMessageQueueHoldReason,
  ThreadMessageQueuePayload,
  ThreadMessageQueueRefusalReason,
  ThreadMessageQueueScope,
  ThreadQueueMessageId,
  WindowId,
} from "@octant/contracts";

export interface ThreadMessageQueueTail {
  readonly id: string;
  readonly status: "active" | "completed" | "failed" | "cancelled";
}
export interface ThreadMessageQueueInspectionInput {
  readonly scope: ThreadMessageQueueScope;
  readonly windowId: WindowId;
  readonly intent: "read" | "dispatch" | ThreadMessageQueueCommand["kind"];
  readonly payload?: ThreadMessageQueuePayload;
}
export type ThreadMessageQueueInspection =
  | {
      readonly status: "ready" | "busy";
      readonly binding: string;
      readonly tail?: ThreadMessageQueueTail;
      readonly privateContextJson?: string;
    }
  | { readonly status: "held"; readonly reason: ThreadMessageQueueRefusalReason };

export const MAX_THREAD_MESSAGE_QUEUE_PRIVATE_CONTEXT_BYTES = 64 * 1024;
export interface ThreadMessageQueueResource {
  readonly scope: ThreadMessageQueueScope;
  readonly messageId: ThreadQueueMessageId;
  readonly payload: ThreadMessageQueuePayload;
  readonly privateContextJson?: string;
}

/**
 * Mode admission remains the authority boundary. Inspection authorizes the
 * exact live window on every read and command; dispatch rechecks the same
 * provider, model/options, Project/root and execution-policy fingerprint.
 * Tail identity is separate: a normal completion must not change that binding.
 */
export interface ThreadMessageQueueModePort {
  /** Synchronous pins close the discard race before the atomic private write. */
  readonly retain: (
    input: ThreadMessageQueueResource & {
      readonly reason: "enqueue" | "restore";
    },
  ) =>
    | { readonly status: "retained"; readonly privateContextJson?: string }
    | { readonly status: "refused"; readonly reason: ThreadMessageQueueRefusalReason };
  /** Transfer staging ownership only after the queue append commits. */
  readonly commit: (input: ThreadMessageQueueResource) => void;
  /** A refused cleanup keeps the private record for an idempotent retry. */
  readonly release: (
    input: ThreadMessageQueueResource & {
      readonly reason: "accepted" | "removed" | "purged" | "rollback";
    },
  ) => Promise<{ readonly status: "released" } | { readonly status: "refused" }>;

  readonly inspect: (
    input: ThreadMessageQueueInspectionInput,
  ) => Promise<ThreadMessageQueueInspection>;
  /**
   * Use messageId as the ordinary mode's stable submission/turn identity.
   * Return accepted when admission is durable, without waiting for the reply.
   * Private context is host-produced metadata, never execution authority.
   */
  readonly admit: (input: {
    readonly scope: ThreadMessageQueueScope;
    readonly messageId: ThreadQueueMessageId;
    readonly payload: ThreadMessageQueuePayload;
    readonly binding: string;
    readonly windowId: WindowId;
    readonly privateContextJson?: string;
    readonly signal: AbortSignal;
  }) => Promise<
    | { readonly status: "accepted" }
    | { readonly status: "refused"; readonly reason: ThreadMessageQueueHoldReason }
    | { readonly status: "unknown" }
  >;
  /** not-admitted is proof from durable mode state, never an absent live handle. */
  readonly reconcile: (input: {
    readonly scope: ThreadMessageQueueScope;
    readonly messageId: ThreadQueueMessageId;
  }) => Promise<{
    readonly status: "not-admitted" | "accepted" | "completed" | "failed" | "cancelled" | "unknown";
  }>;
}
