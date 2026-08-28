import type { ChatAttempt } from "@octant/contracts/chat";

export type ProviderSessionDisposition =
  | { readonly kind: "retain" }
  | { readonly kind: "reap"; readonly resumable: boolean };

export interface ProviderSessionReapInput {
  readonly attempt: Pick<ChatAttempt, "outcome" | "updatedAt" | "resumeCursor">;
  /** True when this process still owns the running provider turn. */
  readonly ownedByThisProcess: boolean;
  readonly now: number;
  readonly staleAfterMs: number;
}

export function reapsStaleProviderSession(
  input: ProviderSessionReapInput,
): ProviderSessionDisposition {
  if (
    input.attempt.outcome === "completed" ||
    input.attempt.outcome === "failed" ||
    input.attempt.outcome === "cancelled" ||
    input.attempt.outcome === "interrupted" ||
    input.attempt.outcome === "waiting" ||
    input.ownedByThisProcess
  ) {
    return { kind: "retain" };
  }
  const updatedAt = Date.parse(input.attempt.updatedAt);
  // Corrupt historical timestamps cannot prove an active session is safe to keep.
  const stale = !Number.isFinite(updatedAt) || input.now - updatedAt >= input.staleAfterMs;
  return stale
    ? { kind: "reap", resumable: input.attempt.resumeCursor !== undefined }
    : { kind: "retain" };
}
