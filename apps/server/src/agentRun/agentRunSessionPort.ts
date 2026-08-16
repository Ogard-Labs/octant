import type { AgentRun, AgentRunId, ProviderFailure } from "@octant/contracts";

/**
 * Why a managed AgentRun could not be started at all.
 *
 * These are start-time preconditions, not provider verdicts: the child never
 * reached the provider, so nothing about a model response may be implied. Each
 * reason names the exact missing dependency so the host can report the honest
 * setup requirement the design requires instead of a generic failure.
 */
export type AgentRunSessionFailureReason =
  | "provider-unavailable"
  | "context-unavailable"
  | "capacity-unavailable"
  | "workspace-unavailable"
  | "authority-drift";

export class AgentRunSessionError extends Error {
  override readonly name = "AgentRunSessionError";
  readonly reason: AgentRunSessionFailureReason;

  constructor(reason: AgentRunSessionFailureReason, message: string) {
    super(message);
    this.reason = reason;
  }
}

/**
 * The single terminal fact of one managed session.
 *
 * `completed` is the only outcome that may be treated as a delivered result.
 * Every other kind keeps the ambiguity the approved design demands: a session
 * that ended without a visible reply is `failed`, a provider that stopped
 * generating and expects input is `waiting`, and an end we cannot classify is
 * `interrupted` — never silently upgraded to completion.
 */
export type AgentRunSessionOutcome =
  | {
      readonly kind: "completed";
      readonly responseText: string;
      readonly usage?: {
        readonly inputTokens: number;
        readonly outputTokens: number;
      };
    }
  | { readonly kind: "waiting"; readonly reason: string }
  | { readonly kind: "cancelled" }
  | { readonly kind: "failed"; readonly failure: ProviderFailure }
  | { readonly kind: "interrupted"; readonly reason: string };

export interface AgentRunSessionHandle {
  readonly runId: AgentRunId;
  /**
   * Observes the one terminal outcome of this session. A listener registered
   * after the session already settled is invoked immediately with the recorded
   * outcome, so a late subscriber can never miss the only signal it gets.
   */
  readonly onSettled: (listener: (outcome: AgentRunSessionOutcome) => void) => void;
  /**
   * Resolves once startup side effects the supervisor must observe have
   * completed. A rejection is treated as a controlled session death, mirroring
   * how the out-of-process supervisor observes a failed spawn receipt.
   */
  readonly startupReady?: Promise<void>;
}

/**
 * Provider-agnostic seam between AgentRun supervision and whatever actually
 * executes a managed child. Keeping the supervisor behind this interface is
 * what lets orchestration stay unaware of drivers, capacity, and context: the
 * design forbids core child semantics from depending on any one provider.
 */
export interface AgentRunSessionPort {
  /**
   * Starts one managed session. Implementations resolve every start-time
   * dependency before returning and throw {@link AgentRunSessionError} when one
   * is missing, so an unstartable child fails closed instead of appearing live.
   */
  readonly start: (run: AgentRun) => AgentRunSessionHandle;
  /**
   * Stops a managed session and resolves only once its execution is confirmed
   * stopped. Cancellation is durable only after that confirmation, so a port
   * must not resolve optimistically. Stopping an unknown run is a no-op.
   */
  readonly stop: (runId: AgentRunId) => Promise<void>;
  /** Optional provider-side cleanup performed once at host startup. */
  readonly reconcile?: () => Promise<void>;
}

/**
 * A managed session lives inside this process, so any terminal outcome other
 * than a clean completion leaves the run unable to continue on its own. The
 * supervisor reports those as process death, which is the only channel
 * `AgentRunProcessSupervisorPort` exposes for "this child is no longer live".
 */
export function isAgentRunSessionDeath(outcome: AgentRunSessionOutcome): boolean {
  return outcome.kind !== "completed";
}
