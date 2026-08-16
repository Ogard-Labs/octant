/**
 * Pure mergeability gate for Mobile A / BE1 clean PR merges.
 * The client never invents merge policy; the host evaluates these facts.
 */

export type PullRequestMergeMethod = "merge" | "squash" | "rebase";

export interface PullRequestMergeabilityInput {
  readonly state: "open" | "merged" | "closed" | "draft";
  readonly mergeable: boolean | null;
  readonly headSha: string;
  readonly expectedHeadSha: string;
  readonly requiredChecksPassing: boolean;
  readonly mergeMethod: PullRequestMergeMethod;
  readonly advertisedMergeMethods: ReadonlyArray<PullRequestMergeMethod>;
}

export type PullRequestMergeabilityDecision =
  | { readonly decision: "allow" }
  | {
      readonly decision: "deny";
      readonly code:
        | "not-open"
        | "draft"
        | "conflict"
        | "unknown-mergeable"
        | "checks"
        | "sha-mismatch"
        | "method-unsupported";
    };

export function decidePullRequestMergeability(
  input: PullRequestMergeabilityInput,
): PullRequestMergeabilityDecision {
  if (input.state === "draft") return { decision: "deny", code: "draft" };
  if (input.state !== "open") return { decision: "deny", code: "not-open" };
  if (input.mergeable === null) return { decision: "deny", code: "unknown-mergeable" };
  if (input.mergeable === false) return { decision: "deny", code: "conflict" };
  if (!input.requiredChecksPassing) return { decision: "deny", code: "checks" };
  if (input.headSha !== input.expectedHeadSha) return { decision: "deny", code: "sha-mismatch" };
  if (!input.advertisedMergeMethods.includes(input.mergeMethod)) {
    return { decision: "deny", code: "method-unsupported" };
  }
  return { decision: "allow" };
}
