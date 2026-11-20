/**
 * The pull request reviewer contribution seam.
 *
 * A pull request reviewer inspects one pushed head of a Code thread's pull
 * request through narrow, host-mediated capabilities:
 * - read-only access to the host-verified PR diff snapshot,
 * - an optional host-enforced, research-only, read-only child review turn at
 *   Plan's read-only gate (whatever the parent thread's guardrail level),
 * - validated recording of findings into the host's `CodeReviewFinding` journal,
 * - an optional single summary comment on the PR (only when the per-Project
 *   opt-in is enabled; formal forge reviews — approve or request changes — are
 *   never exposed), and
 * - an optional blocking-findings hand-back to the worker thread (only when the
 *   per-PR opt-in is enabled, through the host's outside-content-marked wake
 *   path).
 *
 * A reviewer receives no raw filesystem path, shell handle, credential, forge
 * token, or direct server service reference. Effectiveness, head staleness,
 * Plan's read-only gate, spend ceilings, authorship, and opt-in switches stay
 * host-enforced on every call.
 */
import type { AgentRunId } from "@octant/contracts/agent-run";
import type { CodeReviewFindingId } from "@octant/contracts/code";
import type { CodeReviewFinding } from "@octant/contracts/code-operations";
import type { ProviderInstanceId, ProviderModelId } from "@octant/contracts/providers";
import type {
  PullRequestReviewDiffSnapshot,
  PullRequestReviewFindingProposal,
  PullRequestReviewOutcome,
  PullRequestReviewRequest,
  PullRequestReviewTurnRefusalReason,
} from "@octant/contracts/pull-request-reviewer";

export {
  MAX_PULL_REQUEST_REVIEW_COMMENT_BYTES,
  MAX_PULL_REQUEST_REVIEW_DIFF_FILES,
  MAX_PULL_REQUEST_REVIEW_FILE_PATCH_BYTES,
  MAX_PULL_REQUEST_REVIEW_FINDINGS_PER_RUN,
  MAX_PULL_REQUEST_REVIEW_PROMPT_BYTES,
  PullRequestReviewDiffFile,
  PullRequestReviewDiffSnapshot,
  PullRequestReviewFindingProposal,
  PullRequestReviewId,
  PullRequestReviewOptIns,
  PullRequestReviewOutcome,
  PullRequestReviewRequest,
  PullRequestReviewRoute,
  PullRequestReviewTarget,
  PullRequestReviewTurnRefusalReason,
  PullRequestReviewWorkerRoute,
  PullRequestReviewerId,
  decodePullRequestReviewDiffSnapshot,
  decodePullRequestReviewFindingProposal,
  decodePullRequestReviewId,
  decodePullRequestReviewOutcome,
  decodePullRequestReviewRequest,
  decodePullRequestReviewerId,
} from "@octant/contracts/pull-request-reviewer";
export type { AgentRunId } from "@octant/contracts/agent-run";
export type { CodeReviewFindingId } from "@octant/contracts/code";
export type { CodeReviewFinding, CodeReviewLocation } from "@octant/contracts/code-operations";
export type { ProviderInstanceId, ProviderModelId } from "@octant/contracts/providers";

export const PULL_REQUEST_REVIEWER_CONTRIBUTION_KIND = "pull-request-reviewer" as const;
export type PullRequestReviewerContributionKind = typeof PULL_REQUEST_REVIEWER_CONTRIBUTION_KIND;

export type PullRequestReviewDiffResult =
  | { readonly status: "ready"; readonly diff: PullRequestReviewDiffSnapshot }
  | { readonly status: "stale"; readonly currentHeadSha?: string }
  | { readonly status: "unavailable"; readonly reason: "not-effective" | "unavailable" };

export interface PullRequestReviewTurnInput {
  readonly prompt: string;
  readonly systemInstructions?: string;
}

/**
 * The answer to a host-enforced, research-only, read-only child review turn on
 * the PR head. The host runs the turn at Plan's read-only gate under the
 * configured reviewer route, never falls back silently to another model, and
 * counts usage against the parent thread's spend ceiling and turn metrics.
 */
export type PullRequestReviewTurnResult =
  | {
      readonly status: "completed";
      readonly runId: AgentRunId;
      readonly providerInstanceId: ProviderInstanceId;
      readonly modelId: ProviderModelId;
      readonly sessionId: string;
      readonly text: string;
    }
  | {
      readonly status: "refused";
      readonly reason: PullRequestReviewTurnRefusalReason;
      readonly detail: string;
    }
  | { readonly status: "cancelled" }
  | { readonly status: "failed"; readonly detail: string };

export interface PullRequestReviewRecordFindingsInput {
  readonly findings: ReadonlyArray<PullRequestReviewFindingProposal>;
  /**
   * Optional child run id returned by `runReadOnlyReviewTurn` during this same
   * review invocation. The host verifies ownership and stamps authorship and
   * provenance from its own run receipt.
   */
  readonly runId?: AgentRunId;
}

export type PullRequestReviewRecordFindingsResult =
  | { readonly status: "recorded"; readonly findings: ReadonlyArray<CodeReviewFinding> }
  | { readonly status: "stale"; readonly currentHeadSha?: string }
  | {
      readonly status: "refused";
      readonly reason:
        | "not-effective"
        | "invalid-findings"
        | "unknown-run"
        | "limit-exceeded"
        | "unavailable";
      readonly detail?: string;
    };

export interface PullRequestReviewSummaryCommentInput {
  readonly body: string;
}

export type PullRequestReviewSummaryCommentResult =
  | { readonly status: "posted"; readonly commentId?: string }
  | { readonly status: "disabled" }
  | { readonly status: "stale"; readonly currentHeadSha?: string }
  | {
      readonly status: "refused";
      readonly reason: "not-effective" | "already-posted" | "invalid-body" | "not-authorized";
    }
  | {
      readonly status: "unavailable";
      readonly reason: "disconnected" | "unauthenticated" | "unavailable";
    };

export interface PullRequestReviewHandBackInput {
  /** Blocking (`error`) finding ids previously recorded by the host in this review run. */
  readonly findingIds: ReadonlyArray<CodeReviewFindingId>;
}

export type PullRequestReviewHandBackResult =
  | { readonly status: "handed-back"; readonly attempt: number }
  | { readonly status: "disabled" }
  | { readonly status: "stale"; readonly currentHeadSha?: string }
  | { readonly status: "attempt-limit" }
  | {
      readonly status: "refused";
      readonly reason:
        | "not-effective"
        | "no-blocking-findings"
        | "unknown-finding"
        | "unmarked"
        | "turn-refused"
        | "already-handed-back";
    };

/**
 * Capability-scoped host port handed to a pull request reviewer for one review
 * invocation on one PR head. Exposes no filesystem path, shell, credential, or
 * formal forge review action.
 */
export interface PullRequestReviewHostPort {
  readonly isHeadCurrent: (signal?: AbortSignal) => Promise<boolean>;
  readonly readPullRequestDiff: (signal?: AbortSignal) => Promise<PullRequestReviewDiffResult>;
  readonly runReadOnlyReviewTurn: (
    input: PullRequestReviewTurnInput,
    signal?: AbortSignal,
  ) => Promise<PullRequestReviewTurnResult>;
  readonly recordFindings: (
    input: PullRequestReviewRecordFindingsInput,
    signal?: AbortSignal,
  ) => Promise<PullRequestReviewRecordFindingsResult>;
  readonly postSummaryComment: (
    input: PullRequestReviewSummaryCommentInput,
    signal?: AbortSignal,
  ) => Promise<PullRequestReviewSummaryCommentResult>;
  readonly handBackBlockingFindings: (
    input: PullRequestReviewHandBackInput,
    signal?: AbortSignal,
  ) => Promise<PullRequestReviewHandBackResult>;
}

/** A pull request reviewer plugin contribution. */
export interface PullRequestReviewer {
  readonly kind: PullRequestReviewerContributionKind;
  readonly review: (
    request: PullRequestReviewRequest,
    host: PullRequestReviewHostPort,
    signal: AbortSignal,
  ) => Promise<PullRequestReviewOutcome>;
}
