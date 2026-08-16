import type { WorkPromotionStatus } from "@octant/contracts/work-promotion";
import type { ProviderExecutionPolicy } from "@octant/contracts/providers";
import type { ProjectType } from "@octant/contracts/projects";

/**
 * Re-exported promotion status so the pure promotion authority has one
 * discoverable entry point alongside the confinement authority.
 */
export type { WorkPromotionStatus };

/**
 * The only Code execution policy a promotion may propose. A promoted Code
 * thread starts approval-gated regardless of any remembered Code Project
 * access; `full-access` and `plan` are never carried into Code by a
 * promotion. This constant is the single source of truth the server compares
 * against before journaling an approval.
 */
export const WORK_PROMOTION_REQUIRED_CODE_EXECUTION_POLICY =
  "approval-gated" as const satisfies ProviderExecutionPolicy;

/**
 * Decide whether a proposed Code execution policy satisfies the
 * approval-gated invariant. The contract structurally restricts the proposal
 * to `approval-gated`; this pure check is the server-side defense-in-depth
 * that re-validates any externally supplied policy before journaling.
 */
export function isApprovalGatedCodeExecutionPolicy(policy: ProviderExecutionPolicy): boolean {
  return policy === WORK_PROMOTION_REQUIRED_CODE_EXECUTION_POLICY;
}

export type WorkPromotionContextLeakage = "clean" | "leaked";

/**
 * Detect Work filesystem authority leakage in a promotion context
 * selection. The host supplies the canonical Work root so the policy can
 * confirm neither the summary nor any opaque artifact ref carries it; the
 * summary is already path-separator- and scheme-free by contract, so this
 * pure check is the runtime defense against a host path or binding root
 * reaching the Code Project through the selected context. A leaked context
 * fails closed and never journals a proposal.
 */
export function detectPromotionContextLeakage(input: {
  readonly summary: string;
  readonly artifactRefs: ReadonlyArray<string>;
  readonly workCanonicalRoot?: string;
}): WorkPromotionContextLeakage {
  const root = input.workCanonicalRoot;
  if (root !== undefined && root.length > 0) {
    if (input.summary.includes(root)) return "leaked";
    for (const ref of input.artifactRefs) {
      if (ref.includes(root)) return "leaked";
    }
  }
  return "clean";
}

/**
 * Validate a promotion context selection for authority leakage using the
 * host-supplied canonical Work root. Convenience wrapper that mirrors the
 * confinement authority's fail-closed shape.
 */
export function validatePromotionContextAuthority(input: {
  readonly summary: string;
  readonly artifactRefs: ReadonlyArray<string>;
  readonly workCanonicalRoot?: string;
}): WorkPromotionContextLeakage {
  return detectPromotionContextLeakage({
    summary: input.summary,
    artifactRefs: input.artifactRefs,
    ...(input.workCanonicalRoot !== undefined
      ? { workCanonicalRoot: input.workCanonicalRoot }
      : {}),
  });
}

export type WorkPromotionTransition = "approve" | "dismiss" | "expire";

/**
 * Decide whether a promotion transition may proceed. Only a `proposed`
 * proposal may be approved, dismissed, or expired; an already-approved,
 * dismissed, or expired proposal is terminal and cannot be re-transitioned.
 * This prevents a stale or replayed command from silently re-opening a
 * closed promotion or creating a second linked Code thread.
 */
export function classifyPromotionTransition(input: {
  readonly currentStatus: WorkPromotionStatus;
  readonly transition: WorkPromotionTransition;
}): "allow" | "deny" {
  void input.transition;
  return input.currentStatus === "proposed" ? "allow" : "deny";
}

export type WorkPromotionAuthorityDecision = "allow" | "deny";

/**
 * Decide whether a Work-to-Code promotion may proceed. This is the pure
 * authority check the server runs before journaling a proposal or approval.
 * Fails closed (`deny`) when the origin is not a Work Project, the target
 * is not a Code Project, the proposed Code execution policy is not
 * approval-gated, or the selected context leaks Work filesystem authority.
 * The check never grants authority; it only confirms the promotion is
 * well-formed and carries no inherited Work authority into Code.
 */
export function classifyPromotionAuthority(input: {
  readonly originProjectType: ProjectType;
  readonly targetProjectType: ProjectType;
  readonly proposedCodeExecutionPolicy: ProviderExecutionPolicy;
  readonly contextLeakage: WorkPromotionContextLeakage;
}): WorkPromotionAuthorityDecision {
  if (input.originProjectType !== "work") return "deny";
  if (input.targetProjectType !== "code") return "deny";
  if (!isApprovalGatedCodeExecutionPolicy(input.proposedCodeExecutionPolicy)) return "deny";
  if (input.contextLeakage === "leaked") return "deny";
  return "allow";
}
