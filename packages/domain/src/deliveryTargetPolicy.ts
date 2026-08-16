import type { CodeDeliveryOutcomeKind } from "@octant/contracts/code";

export type { CodeDeliveryOutcomeKind };

/**
 * The confirmed delivery outcomes a Code thread can target, ordered from least
 * to most ambitious. The ordering is authoritative for classifying whether an
 * agent proposal raises or lowers the confirmed target.
 */
export const CODE_DELIVERY_OUTCOME_ORDER = [
  "investigation-result",
  "local-implementation",
  "opened-pr",
  "merged-pr",
] as const satisfies ReadonlyArray<CodeDeliveryOutcomeKind>;

export function codeDeliveryOutcomeRank(kind: CodeDeliveryOutcomeKind): number {
  return CODE_DELIVERY_OUTCOME_ORDER.indexOf(kind);
}

/**
 * Suggest a delivery outcome from the creation prompt. This is only a
 * suggestion: the user always confirms the outcome in the create flow. The
 * suggestion is deterministic and biased toward the least ambitious outcome the
 * prompt clearly justifies, so it never over-commits the user.
 */
export function suggestCodeDeliveryOutcome(prompt: string): CodeDeliveryOutcomeKind {
  const text = prompt.toLowerCase();
  if (/\bmerge(s|d|r|rs)?\b/.test(text)) return "merged-pr";
  if (/\bpull request\b/.test(text) || /\bprs?\b/.test(text)) return "opened-pr";
  if (
    /\b(investigat\w*|research\w*|analy[sz]e\w*|diagnos\w*|explor\w*|explain\w*|assess\w*|understand\w*|figure out|find out|root cause|why (?:is|does|are|do)|how (?:does|do))\b/.test(
      text,
    )
  ) {
    return "investigation-result";
  }
  return "local-implementation";
}

export type OutcomeProposalDirection = "unchanged" | "raise" | "lower";

export function classifyCodeDeliveryOutcomeProposal(
  current: CodeDeliveryOutcomeKind,
  proposed: CodeDeliveryOutcomeKind,
): OutcomeProposalDirection {
  const currentRank = codeDeliveryOutcomeRank(current);
  const proposedRank = codeDeliveryOutcomeRank(proposed);
  if (proposedRank === currentRank) return "unchanged";
  return proposedRank > currentRank ? "raise" : "lower";
}

export interface OutcomeProposalDecision {
  /** Whether the proposal changes anything and can therefore be recorded. */
  readonly admissible: boolean;
  readonly direction: OutcomeProposalDirection;
  /**
   * Always true for an admissible proposal: an agent may propose an outcome
   * change but can never raise, lower, or redefine the confirmed outcome
   * without explicit user confirmation.
   */
  readonly requiresUserConfirmation: boolean;
}

export function evaluateCodeDeliveryOutcomeProposal(
  current: CodeDeliveryOutcomeKind,
  proposed: CodeDeliveryOutcomeKind,
): OutcomeProposalDecision {
  const direction = classifyCodeDeliveryOutcomeProposal(current, proposed);
  const admissible = direction !== "unchanged";
  return { admissible, direction, requiresUserConfirmation: admissible };
}

export type EvidenceFreshness = "fresh" | "stale";

export interface DeliveryInvestigationEvidence {
  readonly resultDelivered: boolean;
  readonly freshness: EvidenceFreshness;
}

export interface DeliveryLocalChangeEvidence {
  readonly committedAhead: number;
  readonly workingTreeClean: boolean;
  readonly freshness: EvidenceFreshness;
}

export type DeliveryPullRequestPresence = "none" | "open" | "merged" | "closed";

export interface DeliveryPullRequestEvidence {
  readonly presence: DeliveryPullRequestPresence;
  readonly matchesDeliveryBranch: boolean;
  readonly freshness: EvidenceFreshness;
}

export interface DeliveryChildAgentEvidence {
  /** Non-terminal child runs (queued/starting/running/waiting). */
  readonly active: number;
  /** Terminal child runs whose required result the user has not acknowledged. */
  readonly unacknowledgedResults: number;
}

export interface DeliveryTargetEvidence {
  readonly investigation?: DeliveryInvestigationEvidence;
  readonly localChanges?: DeliveryLocalChangeEvidence;
  readonly pullRequest?: DeliveryPullRequestEvidence;
  readonly childAgents?: DeliveryChildAgentEvidence;
}

/**
 * The objective satisfaction of a delivery target:
 * - `done`: the confirmed outcome is objectively satisfied by fresh,
 *   unambiguous evidence with no outstanding child-agent work;
 * - `waiting`: evidence is stale or ambiguous (including outstanding child-agent
 *   results), so the target must never be declared done and needs attention;
 * - `pending`: the criteria are simply not yet met.
 */
export type CodeDeliverySatisfaction = "pending" | "waiting" | "done";

function childWorkOutstanding(childAgents: DeliveryChildAgentEvidence | undefined): boolean {
  if (childAgents === undefined) return false;
  return childAgents.active > 0 || childAgents.unacknowledgedResults > 0;
}

function evaluateOutcome(
  outcomeKind: CodeDeliveryOutcomeKind,
  evidence: DeliveryTargetEvidence,
): CodeDeliverySatisfaction {
  switch (outcomeKind) {
    case "investigation-result": {
      const investigation = evidence.investigation;
      if (investigation === undefined || !investigation.resultDelivered) return "pending";
      if (investigation.freshness === "stale") return "waiting";
      return "done";
    }
    case "local-implementation": {
      const local = evidence.localChanges;
      if (local === undefined) return "pending";
      if (local.freshness === "stale") return "waiting";
      if (local.committedAhead <= 0) return "pending";
      // Committed work exists but uncommitted edits remain: it is ambiguous
      // whether the implementation is complete.
      if (!local.workingTreeClean) return "waiting";
      return "done";
    }
    case "opened-pr": {
      const pr = evidence.pullRequest;
      if (pr === undefined || pr.presence === "none") return "pending";
      // Stale GitHub metadata can never independently satisfy a target.
      if (pr.freshness === "stale") return "waiting";
      if (!pr.matchesDeliveryBranch) return "waiting";
      if (pr.presence === "open" || pr.presence === "merged") return "done";
      // A PR closed without merging is a regression from the target.
      return "waiting";
    }
    case "merged-pr": {
      const pr = evidence.pullRequest;
      if (pr === undefined || pr.presence === "none") return "pending";
      if (pr.freshness === "stale") return "waiting";
      if (!pr.matchesDeliveryBranch) return "waiting";
      if (pr.presence === "merged") return "done";
      if (pr.presence === "open") return "pending";
      return "waiting";
    }
  }
}

export function evaluateCodeDeliverySatisfaction(
  outcomeKind: CodeDeliveryOutcomeKind,
  evidence: DeliveryTargetEvidence,
): CodeDeliverySatisfaction {
  const base = evaluateOutcome(outcomeKind, evidence);
  // Outstanding child-agent work makes an otherwise-satisfied target ambiguous:
  // the result could still change or has not been accounted for by the user.
  if (base === "done" && childWorkOutstanding(evidence.childAgents)) return "waiting";
  return base;
}
