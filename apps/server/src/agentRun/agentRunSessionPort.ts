import type {
  AgentRun,
  AgentRunId,
  AgentRunResultEvidence,
  ProviderFailure,
} from "@octant/contracts";

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
  | "spend-ceiling-exhausted"
  | "workspace-unavailable"
  | "authority-drift"
  | "resume-unavailable";

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
export type AgentRunSessionOutcome = (
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
  | { readonly kind: "interrupted"; readonly reason: string }
) & { readonly evidence?: AgentRunResultEvidence };

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

export type AgentRunResumeReadiness =
  | { readonly status: "ready" }
  | { readonly status: "refused"; readonly message: string };

/** Resources reserved before lifecycle admission; release is safe after start or refusal. */
export interface AgentRunPreparedResume {
  readonly start: (run: AgentRun) => AgentRunSessionHandle;
  readonly release: () => void;
}

/**
 * Provider-agnostic seam between AgentRun supervision and whatever actually
 * executes a managed child. Keeping the supervisor behind this interface is
 * what lets orchestration stay unaware of drivers, capacity, and context: the
 * design forbids core child semantics from depending on any one provider.
 */
export interface AgentRunSessionPort {
  /** Checks persisted identity/cursor and current capability without starting or reserving execution. */
  readonly checkResume?: (
    run: AgentRun,
  ) => AgentRunResumeReadiness | Promise<AgentRunResumeReadiness>;
  /** Resolves synchronous execution prerequisites and reserves resources without launching. */
  readonly prepareResume?: (
    run: AgentRun,
    input?: { readonly message?: string },
  ) => AgentRunPreparedResume;
  /**
   * Starts one managed session. Implementations resolve every start-time
   * dependency before returning and throw {@link AgentRunSessionError} when one
   * is missing, so an unstartable child fails closed instead of appearing live.
   */
  readonly start: (run: AgentRun) => AgentRunSessionHandle;
  /** Continues a recorded conversation; refusal must never fall back to start. */
  readonly resume?: (run: AgentRun, input?: { readonly message?: string }) => AgentRunSessionHandle;
  /**
   * Stops a managed session and resolves only once its execution is confirmed
   * stopped. Cancellation is durable only after that confirmation, so a port
   * must not resolve optimistically. Stopping an unknown run is a no-op.
   */
  readonly stop: (runId: AgentRunId) => Promise<void>;
  readonly steer?: (input: {
    readonly runId: AgentRunId;
    readonly message: string;
  }) => Promise<"steered" | "unsupported">;
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
