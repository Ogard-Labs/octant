import {
  CODE_PROJECT_PULL_REQUEST_AUTO_FIX_MAX_ATTEMPTS,
  type ProjectId,
  type ProviderExecutionPolicy,
  type ProviderInstanceId,
  type ProviderModelId,
  type PullRequestReviewEffectiveConfig,
  type PullRequestReviewRoute,
  type PullRequestReviewTarget,
  type PullRequestReviewThreadOverrideMode,
  type PullRequestReviewerId,
} from "@octant/contracts";
import { actsAsHostPerson, type PrincipalKind } from "./remoteAccessPolicy";

export const PULL_REQUEST_REVIEW_STRICT_MAX_HAND_BACK_ATTEMPTS =
  CODE_PROJECT_PULL_REQUEST_AUTO_FIX_MAX_ATTEMPTS;

/**
 * Actions a reviewer turn or tool surface might ask to perform. Only the
 * read-only inspection actions are ever permitted; every mutating or recursive
 * action is refused at Plan's read-only gate regardless of the parent thread's
 * guardrail level.
 */
export type PullRequestReviewerActionKind =
  | "read-file"
  | "read-diff"
  | "search-files"
  | "read-git-status"
  | "edit-file"
  | "write-file"
  | "delete-file"
  | "shell-write"
  | "git-write"
  | "forge-write"
  | "forge-review"
  | "spawn-child-run";

const ALLOWED_REVIEWER_ACTIONS: ReadonlySet<PullRequestReviewerActionKind> = new Set([
  "read-file",
  "read-diff",
  "search-files",
  "read-git-status",
]);

export interface PullRequestReviewerExecutionAuthority {
  readonly executionPolicy: "plan";
  readonly role: "research";
  readonly readOnly: true;
  readonly filesystemWrite: false;
  readonly shellWrite: false;
  readonly gitWrite: false;
  readonly forgeWrite: false;
  readonly allowChildRuns: false;
}

/**
 * The fixed authority a pull request reviewer run always executes under:
 * Plan's read-only research gate, whatever the parent Code thread's level
 * (including Full access).
 */
export function pullRequestReviewerExecutionPolicy(
  _threadExecutionPolicy: ProviderExecutionPolicy,
): PullRequestReviewerExecutionAuthority {
  return {
    executionPolicy: "plan",
    role: "research",
    readOnly: true,
    filesystemWrite: false,
    shellWrite: false,
    gitWrite: false,
    forgeWrite: false,
    allowChildRuns: false,
  };
}

export type PullRequestReviewerActionDecision =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly reason: "plan-read-only-gate" };

/**
 * Decides whether a pull request reviewer run may perform an action. Every
 * file edit, shell write, Git mutation, forge write/review, and child-run
 * spawn is refused at every thread level, Full access included.
 */
export function decidePullRequestReviewerAction(input: {
  readonly threadExecutionPolicy: ProviderExecutionPolicy;
  readonly action: PullRequestReviewerActionKind;
}): PullRequestReviewerActionDecision {
  const authority = pullRequestReviewerExecutionPolicy(input.threadExecutionPolicy);
  if (authority.readOnly && ALLOWED_REVIEWER_ACTIONS.has(input.action)) {
    return { allowed: true };
  }
  return { allowed: false, reason: "plan-read-only-gate" };
}

export type PullRequestReviewHeadCurrency =
  | { readonly status: "current" }
  | { readonly status: "stale"; readonly currentHeadSha?: string };

/**
 * A pull request review is bound to the exact head SHA it read. Any missing or
 * moved head renders the invocation stale so findings are never shown as
 * current and no summary comment or worker hand-back proceeds.
 */
export function evaluatePullRequestReviewHeadCurrency(input: {
  readonly reviewedHeadSha: string;
  readonly currentHeadSha: string | undefined;
}): PullRequestReviewHeadCurrency {
  if (input.currentHeadSha === input.reviewedHeadSha) {
    return { status: "current" };
  }
  return input.currentHeadSha === undefined
    ? { status: "stale" }
    : { status: "stale", currentHeadSha: input.currentHeadSha };
}

export type PullRequestReviewSettingAuthorization =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly reason: "host-person-required" };

/**
 * Every pull request reviewer setting (Project, thread override, or per-PR
 * opt-in) may only be changed from a local window or a device the host's own
 * person paired. Hub-introduced and restricted devices are refused.
 */
export function authorizePullRequestReviewSettingChange(
  principalKind: PrincipalKind,
): PullRequestReviewSettingAuthorization {
  return actsAsHostPerson(principalKind)
    ? { allowed: true }
    : { allowed: false, reason: "host-person-required" };
}

/** Legacy `owner/name#number` key used before pull requests carried a GitHub node ID. */
export function pullRequestReviewLegacyTargetKey(target: PullRequestReviewTarget): string {
  return `${String(target.projectId)}:${String(target.repositoryOwner).toLowerCase()}/${String(target.repositoryName).toLowerCase()}#${target.number}`;
}

/** Stable node-ID key for one pull request on a Project; survives repository renames and name reuse. */
export function pullRequestReviewNodeTargetKey(
  projectId: ProjectId | string,
  pullRequestNodeId: string,
): string {
  return `${String(projectId)}:node:${pullRequestNodeId}`;
}

export interface ParsedPullRequestReviewLegacyTargetKey {
  readonly projectId: string;
  readonly repositoryOwner: string;
  readonly repositoryName: string;
  readonly number: number;
}

/**
 * Parses a legacy `projectId:owner/name#number` key. Returns `undefined` for
 * node-ID keys (`projectId:node:…`) or malformed values.
 */
export function parsePullRequestReviewLegacyTargetKey(
  key: string,
): ParsedPullRequestReviewLegacyTargetKey | undefined {
  const colon = key.indexOf(":");
  if (colon <= 0) return undefined;
  const projectId = key.slice(0, colon);
  const rest = key.slice(colon + 1);
  if (rest.startsWith("node:")) return undefined;
  const slash = rest.indexOf("/");
  const hash = rest.lastIndexOf("#");
  if (slash <= 0 || hash <= slash + 1 || hash === rest.length - 1) return undefined;
  const repositoryOwner = rest.slice(0, slash);
  const repositoryName = rest.slice(slash + 1, hash);
  const numberText = rest.slice(hash + 1);
  if (!/^[1-9]\d*$/.test(numberText)) return undefined;
  const number = Number(numberText);
  if (!Number.isSafeInteger(number) || number <= 0) return undefined;
  return { projectId, repositoryOwner, repositoryName, number };
}

/**
 * Stable key for one pull request target on a Project. Uses the linked pull
 * request's GitHub node ID when known so repository renames keep reviews and
 * guides and reused repository names never collide; falls back to the legacy
 * `owner/name#number` coordinate key when no node ID is known.
 */
export function pullRequestReviewTargetKey(
  target: PullRequestReviewTarget,
  pullRequestNodeId?: string,
): string {
  const nodeId = pullRequestNodeId ?? target.pullRequestNodeId;
  if (nodeId !== undefined) {
    return pullRequestReviewNodeTargetKey(target.projectId, nodeId);
  }
  return pullRequestReviewLegacyTargetKey(target);
}

export interface ResolveEffectivePullRequestReviewConfigInput {
  readonly projectEnabled: boolean;
  readonly projectReviewerId?: PullRequestReviewerId | undefined;
  readonly projectRoute?: PullRequestReviewRoute | undefined;
  readonly postSummaryComment: boolean;
  readonly threadMode: PullRequestReviewThreadOverrideMode;
  readonly threadRoute?: PullRequestReviewRoute | undefined;
  readonly sendBlockingFindingsToWorker: boolean;
  readonly defaultReviewerId: PullRequestReviewerId;
  readonly reviewerOffered: boolean;
}

/**
 * Resolves the effective pull request review posture for a thread/PR from the
 * Project settings, per-thread override, per-PR opt-in, and live plugin
 * effectiveness. Off by default and carries no default model: an enabled
 * review with no picked route stays unable to run with an explicit reason.
 */
export function resolveEffectivePullRequestReviewConfig(
  input: ResolveEffectivePullRequestReviewConfigInput,
): PullRequestReviewEffectiveConfig {
  const desiredEnabled =
    input.threadMode === "enabled"
      ? true
      : input.threadMode === "disabled"
        ? false
        : input.projectEnabled;
  const reviewerId = input.projectReviewerId ?? input.defaultReviewerId;
  const route = input.threadRoute ?? input.projectRoute;

  if (!desiredEnabled) {
    return {
      enabled: false,
      reviewerId,
      ...(route === undefined ? {} : { route }),
      postSummaryComment: input.postSummaryComment,
      sendBlockingFindingsToWorker: input.sendBlockingFindingsToWorker,
    };
  }

  if (!input.reviewerOffered) {
    return {
      enabled: false,
      reviewerId,
      ...(route === undefined ? {} : { route }),
      postSummaryComment: input.postSummaryComment,
      sendBlockingFindingsToWorker: input.sendBlockingFindingsToWorker,
      unavailableReason: "not-effective",
      unavailableDetail:
        "The pull request reviewer plugin is disabled or untrusted, so no automatic review can run.",
    };
  }

  if (route === undefined) {
    return {
      enabled: false,
      reviewerId,
      postSummaryComment: input.postSummaryComment,
      sendBlockingFindingsToWorker: input.sendBlockingFindingsToWorker,
      unavailableReason: "no-route-configured",
      unavailableDetail:
        "Pick a reviewer provider and model before pull request reviews can run. Octant never falls back silently to another model.",
    };
  }

  return {
    enabled: true,
    reviewerId,
    route,
    postSummaryComment: input.postSummaryComment,
    sendBlockingFindingsToWorker: input.sendBlockingFindingsToWorker,
  };
}

export type PullRequestReviewStartDecision =
  | { readonly start: true }
  | {
      readonly start: false;
      readonly reason: "worker-turn-active" | "already-reviewed" | "already-in-flight";
    };

/**
 * A pull request reviewer runs at most once per pushed head SHA, after the
 * worker thread's active turn settles.
 */
export function shouldStartPullRequestReviewForHead(input: {
  readonly headSha: string;
  readonly reviewedHeadShas: ReadonlySet<string>;
  readonly inFlightHeadSha?: string | undefined;
  readonly workerTurnActive: boolean;
}): PullRequestReviewStartDecision {
  if (input.workerTurnActive) return { start: false, reason: "worker-turn-active" };
  if (input.inFlightHeadSha === input.headSha) return { start: false, reason: "already-in-flight" };
  if (input.reviewedHeadShas.has(input.headSha)) {
    return { start: false, reason: "already-reviewed" };
  }
  return { start: true };
}

export type PullRequestReviewHandBackDecision =
  | { readonly action: "disabled" }
  | { readonly action: "none" }
  | { readonly action: "attempt-limit"; readonly maxAttempts: number }
  | { readonly action: "hand-back"; readonly attempt: number };

/**
 * Decides whether blocking reviewer findings may wake the worker thread.
 * Off by default; outside Strict there is no attempt cap; under Strict,
 * Auto-fix's attempt cap (default 3) applies.
 */
export function decidePullRequestReviewHandBack(input: {
  readonly sendBlockingFindingsToWorker: boolean;
  readonly blockingFindingCount: number;
  readonly strict: boolean;
  readonly attemptsUsed: number;
  readonly maxStrictAttempts?: number | undefined;
}): PullRequestReviewHandBackDecision {
  if (!input.sendBlockingFindingsToWorker) return { action: "disabled" };
  if (input.blockingFindingCount <= 0) return { action: "none" };
  const maxAttempts = input.maxStrictAttempts ?? PULL_REQUEST_REVIEW_STRICT_MAX_HAND_BACK_ATTEMPTS;
  if (input.strict && input.attemptsUsed >= maxAttempts) {
    return { action: "attempt-limit", maxAttempts };
  }
  return { action: "hand-back", attempt: input.attemptsUsed + 1 };
}

export interface PullRequestReviewerRouteCandidate {
  readonly providerInstanceId: ProviderInstanceId;
  readonly providerDisplayName: string;
  readonly modelId: ProviderModelId;
  readonly modelDisplayName: string;
  readonly apiKey?: boolean | undefined;
}

export interface RankedPullRequestReviewerRoute extends PullRequestReviewerRouteCandidate {
  /** True when the candidate uses a different provider instance than the worker thread. */
  readonly suggested: boolean;
}

/**
 * Orders reviewer route choices so providers different from the worker are
 * suggested first while still keeping the worker's own provider selectable.
 * Never invents a default route.
 */
export function rankPullRequestReviewerRoutes(input: {
  readonly candidates: ReadonlyArray<PullRequestReviewerRouteCandidate>;
  readonly workerProviderInstanceId?: ProviderInstanceId | undefined;
}): ReadonlyArray<RankedPullRequestReviewerRoute> {
  const workerId =
    input.workerProviderInstanceId === undefined
      ? undefined
      : String(input.workerProviderInstanceId);
  const annotated = input.candidates.map((candidate) => ({
    ...candidate,
    suggested: workerId !== undefined && String(candidate.providerInstanceId) !== workerId,
  }));
  return [...annotated].sort((left, right) => {
    if (left.suggested !== right.suggested) return left.suggested ? -1 : 1;
    const providerOrder = left.providerDisplayName.localeCompare(right.providerDisplayName);
    if (providerOrder !== 0) return providerOrder;
    return left.modelDisplayName.localeCompare(right.modelDisplayName);
  });
}
