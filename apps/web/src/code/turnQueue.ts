import type {
  CodeAttachmentReference,
  MentionableThreadId,
  ProviderExecutionPolicy,
} from "@octant/contracts";

/**
 * A follow-up the user wrote while a turn was still running.
 *
 * The host admits one provider turn per thread at a time, so a second prompt
 * cannot simply be sent. Rather than making the user wait at the keyboard, the
 * composer parks it here and the controller sends it once the running turn
 * settles. Nothing here bypasses host authority: a queued turn is sent as an
 * ordinary follow-up, and is only ever sent when the host would admit it.
 */
export interface QueuedCodeTurn {
  readonly id: string;
  readonly prompt: string;
  readonly threadMentionIds: ReadonlyArray<MentionableThreadId>;
  /** Images already staged with the host for this turn. */
  readonly attachments: ReadonlyArray<CodeAttachmentReference>;
  /** The posture this queued follow-up asked to run under. */
  readonly executionPolicy?: ProviderExecutionPolicy;
}

export type CodeTurnQueues = ReadonlyMap<string, ReadonlyArray<QueuedCodeTurn>>;

export const EMPTY_CODE_TURN_QUEUES: CodeTurnQueues = new Map<
  string,
  ReadonlyArray<QueuedCodeTurn>
>();

export function queuedTurnsFor(
  queues: CodeTurnQueues,
  threadId: string,
): ReadonlyArray<QueuedCodeTurn> {
  return queues.get(threadId) ?? [];
}

export function enqueueCodeTurn(
  queues: CodeTurnQueues,
  threadId: string,
  turn: QueuedCodeTurn,
): CodeTurnQueues {
  const next = new Map(queues);
  next.set(threadId, [...queuedTurnsFor(queues, threadId), turn]);
  return next;
}

export function removeQueuedCodeTurn(
  queues: CodeTurnQueues,
  threadId: string,
  turnId: string,
): CodeTurnQueues {
  const remaining = queuedTurnsFor(queues, threadId).filter((turn) => turn.id !== turnId);
  const next = new Map(queues);
  if (remaining.length === 0) next.delete(threadId);
  else next.set(threadId, remaining);
  return next;
}

export function clearQueuedCodeTurns(queues: CodeTurnQueues, threadId: string): CodeTurnQueues {
  if (!queues.has(threadId)) return queues;
  const next = new Map(queues);
  next.delete(threadId);
  return next;
}
