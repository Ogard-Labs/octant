import type { ChatAttempt, ChatThreadView } from "@octant/contracts";

const ACTIVE_OUTCOMES = new Set(["queued", "streaming", "waiting"]);
const RETRYABLE_OUTCOMES = new Set(["failed", "interrupted"]);

/** Latest in-flight attempt on the thread (newest turn/attempt wins). */
export function latestActiveChatAttempt(view: ChatThreadView): ChatAttempt | undefined {
  for (let turnIndex = view.turns.length - 1; turnIndex >= 0; turnIndex -= 1) {
    const attempts = view.turns[turnIndex]!.attempts;
    for (let attemptIndex = attempts.length - 1; attemptIndex >= 0; attemptIndex -= 1) {
      const attempt = attempts[attemptIndex]!;
      if (ACTIVE_OUTCOMES.has(attempt.outcome)) return attempt;
    }
  }
  return undefined;
}

/** Latest failed/interrupted attempt eligible for retry-chat-turn. */
export function latestRetryableChatAttempt(view: ChatThreadView): ChatAttempt | undefined {
  for (let turnIndex = view.turns.length - 1; turnIndex >= 0; turnIndex -= 1) {
    const attempts = view.turns[turnIndex]!.attempts;
    for (let attemptIndex = attempts.length - 1; attemptIndex >= 0; attemptIndex -= 1) {
      const attempt = attempts[attemptIndex]!;
      if (RETRYABLE_OUTCOMES.has(attempt.outcome)) return attempt;
    }
  }
  return undefined;
}

export function chatAttemptStatusLabel(outcome: ChatAttempt["outcome"]): string {
  switch (outcome) {
    case "queued":
      return "Queued";
    case "streaming":
      return "Streaming";
    case "waiting":
      return "Waiting";
    case "interrupted":
      return "Interrupted";
    case "failed":
      return "Failed";
    case "cancelled":
      return "Cancelled";
    case "completed":
      return "Completed";
  }
}
