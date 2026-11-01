/**
 * Which pull-request and push actions a caller may take, decided without
 * touching Git or the forge. The server asks these before any side effect and
 * journals the answer; the renderer never decides.
 */

export type ForcePushMode = "with-lease" | "plain";

export type PushBranchRefusal = "not-own-branch" | "needs-the-persons-request" | "lease-missing";

export type PushBranchDecision =
  | { readonly decision: "allow" }
  | { readonly decision: "refuse"; readonly reason: PushBranchRefusal };

/**
 * A push names one remote branch. A thread pushes only its own delivery
 * branch. The default (base) branch and a plain force-push are the person's
 * call, made for this one act: a standing Full access grant does not stand in
 * for it, so `approvedForThisAct` is the only thing that opens them.
 *
 * A force-with-lease must name the remote head it expects to replace, so a
 * branch someone else moved in the meantime is refused by Git, not overwritten.
 */
export function decidePushBranch(input: {
  readonly remoteBranch: string;
  readonly ownBranch: string;
  readonly baseBranch: string;
  readonly force?: { readonly mode: ForcePushMode; readonly expectedRemoteOid?: string };
  readonly approvedForThisAct: boolean;
}): PushBranchDecision {
  const toBase = input.remoteBranch === input.baseBranch;
  const toOwn = input.remoteBranch === input.ownBranch;
  if (!toBase && !toOwn) {
    // Another thread's branch, a shared or protected branch: no approval
    // reaches them, because the host cannot tell which they are.
    return { decision: "refuse", reason: "not-own-branch" };
  }
  if (input.force?.mode === "with-lease" && input.force.expectedRemoteOid === undefined) {
    return { decision: "refuse", reason: "lease-missing" };
  }
  if ((toBase || input.force?.mode === "plain") && !input.approvedForThisAct) {
    return { decision: "refuse", reason: "needs-the-persons-request" };
  }
  return { decision: "allow" };
}

export type RequiredChecksState = "passing" | "failing" | "pending" | "none" | "unknown";

export type RemoteMergeRefusal =
  | "not-authorized"
  | "not-confirmed"
  | "checks-not-passing"
  | "checks-unknown";

export type RemoteMergeDecision =
  | { readonly decision: "allow" }
  | { readonly decision: "refuse"; readonly reason: RemoteMergeRefusal };

/**
 * A merge from a paired phone or web client, or an agent's merge on request or
 * on a standing permission the person stored (the Project setting or a
 * routine). Only the person's own client may ask, with an explicit confirmation
 * of the head they reviewed, or an agent holding that permission with the head
 * it read; the required checks must be passing (or the repository must require
 * none). A state the host cannot read is refused, never assumed.
 */
export function decideRemotePullRequestMerge(input: {
  readonly caller:
    | "local-window"
    | "remote-device"
    | "agent-on-request"
    | "agent-on-standing-permission"
    | "agent-on-its-own";
  readonly confirmed: boolean;
  readonly requiredChecks: RequiredChecksState;
}): RemoteMergeDecision {
  if (input.caller === "agent-on-its-own") return { decision: "refuse", reason: "not-authorized" };
  if (!input.confirmed) return { decision: "refuse", reason: "not-confirmed" };
  if (input.requiredChecks === "failing" || input.requiredChecks === "pending") {
    return { decision: "refuse", reason: "checks-not-passing" };
  }
  if (input.requiredChecks === "unknown") return { decision: "refuse", reason: "checks-unknown" };
  return { decision: "allow" };
}

export const MAX_PULL_REQUEST_STACK_MERGE = 10;

export type StackMergeRefusal = "empty" | "too-long" | "duplicate" | "not-a-chain";

export type StackMergeDecision =
  | { readonly decision: "allow" }
  | { readonly decision: "refuse"; readonly reason: StackMergeRefusal };

/**
 * A stack merges from the bottom: each pull request's base is the head branch
 * of the one before it. Anything else is not one stack and is refused whole,
 * before the first merge.
 */
export function decideStackMerge(
  items: ReadonlyArray<{
    readonly number: number;
    readonly headBranch: string;
    readonly baseBranch: string;
  }>,
): StackMergeDecision {
  if (items.length === 0) return { decision: "refuse", reason: "empty" };
  if (items.length > MAX_PULL_REQUEST_STACK_MERGE) {
    return { decision: "refuse", reason: "too-long" };
  }
  if (new Set(items.map((item) => item.number)).size !== items.length) {
    return { decision: "refuse", reason: "duplicate" };
  }
  for (let index = 1; index < items.length; index += 1) {
    if (items[index]?.baseBranch !== items[index - 1]?.headBranch) {
      return { decision: "refuse", reason: "not-a-chain" };
    }
  }
  return { decision: "allow" };
}

/**
 * Pull-request changes that need the person's approval for this one act at
 * every guardrail level, Full access included: merging, and a comment, which
 * posts under the person's name.
 */
export function pullRequestChangeNeedsPerActApproval(
  kind: "merge" | "comment" | "close" | "reopen" | "labels",
): boolean {
  return kind === "merge" || kind === "comment";
}
