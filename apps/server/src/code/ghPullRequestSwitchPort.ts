import {
  MAX_CODE_PROJECT_PULL_REQUEST_AUTO_FIX_FAILURES,
  type CodeProjectPullRequestAutoFixFailure,
  type CodeProjectPullRequestMergeMethod,
  type CodeProjectPullRequestMergeWait,
  type PullRequestBabysitRules,
  type PullRequestBabysitStatus,
} from "@octant/contracts";
import type { CoordinatorDoneWhenPullRequestFact } from "@octant/domain";
import {
  sanitizeGhEnvironment,
  validRepository,
  type GhCommandPort,
  type GhCommandResult,
} from "./ghPullRequestPort";
import { redactHostSecrets } from "../process/secretRedaction";

/** Failed checks whose log Auto-fix fetches on one observation. */
const MAX_LOGGED_CHECKS = 4;
const REVIEW_THREADS_PAGE = 50;
/** Pages read before giving up, so a huge pull request cannot hold a pass open. */
const MAX_REVIEW_THREAD_PAGES = 10;
const MAX_COMMENT_BYTES = 2_048;

export interface GhPullRequestSwitchRequest {
  readonly owner: string;
  readonly name: string;
  readonly number: number;
}

export type GhAutoMergeSettings =
  | Readonly<{
      status: "read";
      allowAutoMerge: boolean;
      methods: Readonly<Record<CodeProjectPullRequestMergeMethod, boolean>>;
    }>
  | Readonly<{ status: "unavailable"; reason: "disconnected" | "unauthenticated" | "unavailable" }>;

export type GhAutoMergeResult =
  | Readonly<{ status: "enabled" }>
  | Readonly<{ status: "disabled" }>
  | Readonly<{ status: "refused"; reason: "not-open" | "stale" | "failed" }>
  | Readonly<{ status: "unsupported"; reason: "auto-merge-not-allowed" }>
  | Readonly<{ status: "unavailable"; reason: "disconnected" | "unauthenticated" | "unavailable" }>;

/** One failure Auto-fix found, with the outside text that explains it. */
export interface GhAutoFixFailureDetail {
  readonly failure: CodeProjectPullRequestAutoFixFailure;
  readonly outsideReviewer?: true;
  /** Forge-supplied text: a log excerpt, review comments, or a conflict notice. */
  readonly detail: string;
}

/**
 * What a watch reads on one pass: every check on the head, the review
 * decision, a conflict, and the reviews and comments with their forge text.
 */
export interface GhPullRequestActivity {
  /** `passed` and `failed` only once no check on the head is still running. */
  readonly checks: "none" | "pending" | "passed" | "failed";
  readonly failedChecks: ReadonlyArray<string>;
  readonly reviewDecision?: "approved" | "changes-requested" | "review-required";
  readonly conflicting: boolean;
  readonly requestedApproval?: string;
  readonly reviews: ReadonlyArray<{
    readonly trustedFeedback?: true;
    readonly viewerDidAuthor?: true;
    readonly id: string;
    readonly author: string;
    readonly state: string;
    readonly at: string;
    readonly body: string;
  }>;
  readonly comments: ReadonlyArray<{
    readonly trustedFeedback?: true;
    readonly id: string;
    readonly author: string;
    readonly at: string;
    readonly body: string;
  }>;
}

/**
 * Which reads one observation makes. `failures` is what Merge when ready waits
 * on and Auto-fix fixes (required checks, review threads, failed job logs);
 * `activity` is what a watch wakes on. Each costs forge calls, so a pass reads
 * only what a switch that may act needs.
 */
export interface GhPullRequestSwitchReads {
  readonly failures: boolean;
  readonly activity: boolean;
  readonly babysit?: PullRequestBabysitRules;
}

export type GhPullRequestSwitchObservation =
  | Readonly<{
      status: "observed";
      state: "open" | "merged" | "closed";
      headSha: string;
      babysitReady?: boolean;
      babysitBlocker?: PullRequestBabysitStatus;
      babysitBlockerDetail?: string;
      headBranch: string;
      baseBranch: string;
      autoMergeEnabled: boolean;
      waitingOn: ReadonlyArray<CodeProjectPullRequestMergeWait>;
      failures: ReadonlyArray<GhAutoFixFailureDetail>;
      /** GitHub GraphQL node ID of the pull request, when available. */
      pullRequestNodeId?: string;
      /** Canonical base repository (`owner/name`) observed from the pull request URL, when available. */
      baseRepository?: string;
      /** Present only when the observation was asked for activity. */
      activity?: GhPullRequestActivity;
    }>
  | Readonly<{ status: "unavailable" }>;

/**
 * Why a check named in a CI read has no log to show. `running` has not
 * finished, `expired` is past the repository's log retention, `external` is a
 * commit status or another app's check that has no Actions log, `passed`
 * did not fail, `unavailable` could not be read, `not-read` is past the
 * number of logs one read fetches, and `other-commit` links a run that is not
 * the pull request's current head.
 */
export type GhCiMissingLogReason =
  | "running"
  | "expired"
  | "external"
  | "other-commit"
  | "passed"
  | "unavailable"
  | "not-read";

export type GhCiLogEntry =
  | Readonly<{ check: string; status: "log"; log: string; truncated: boolean }>
  | Readonly<{ check: string; status: "no-log"; reason: GhCiMissingLogReason }>;

export type GhCiLogsResult =
  | Readonly<{
      status: "read";
      headSha: string;
      logs: ReadonlyArray<GhCiLogEntry>;
      /** Checks on the head that have not finished yet. */
      running: ReadonlyArray<string>;
    }>
  | Readonly<{ status: "refused"; reason: "not-open" | "no-such-check" | "pull-request-replaced" }>
  | Readonly<{ status: "unavailable" }>;

/** Why the forge will not rerun what the agent asked for. */
export type GhCiRerunRefusal =
  | "not-open"
  | "pull-request-replaced"
  | "superseded-head"
  | "no-such-check"
  | "no-failed-checks"
  | "not-failed"
  | "external-check"
  | "still-running"
  | "rerun-limit"
  | "run-changed";

/**
 * What a rerun would start, read before anyone is asked: the head it is
 * bound to, and each workflow run with the one job a named check reruns.
 */
export type GhCiRerunPlan =
  | Readonly<{
      status: "planned";
      headSha: string;
      /** The pull request's node id the plan was read on, when GitHub gave one. */
      pullRequestNodeId?: string;
      maxReruns: number;
      runs: ReadonlyArray<
        Readonly<{
          runId: string;
          jobId?: string;
          checks: ReadonlyArray<string>;
          /**
           * The run's attempt the plan was read on. A rerun someone else
           * started since changes which jobs failed, so the approval no
           * longer names what `--failed` would rerun.
           */
          attempt?: number;
        }>
      >;
    }>
  | Readonly<{ status: "refused"; reason: GhCiRerunRefusal }>
  | Readonly<{ status: "unavailable" }>;

export type GhCiRerunResult =
  | Readonly<{ status: "rerun"; checks: ReadonlyArray<string> }>
  | Readonly<{
      status: "refused";
      reason:
        | "superseded-head"
        | "pull-request-replaced"
        | "rerun-limit"
        | "still-running"
        | "run-changed";
    }>
  | Readonly<{ status: "failed"; rerun: ReadonlyArray<string> }>
  | Readonly<{ status: "unavailable" }>;

/** Failed checks one CI read fetches a log for when no check is named. */
const MAX_CI_LOGGED_CHECKS = 4;
/** Check names a CI read reports as still running. */
const MAX_CI_RUNNING_NAMES = 20;
/** How much of a failed job's log is kept from its end while it is read. */
const CI_LOG_TAIL_BYTES = 256 * 1024;

const VIEW_FIELDS =
  "id,url,state,headRefOid,headRefName,baseRefName,mergeable,autoMergeRequest,reviewDecision";
const ACTIVITY_VIEW_FIELDS = `${VIEW_FIELDS},statusCheckRollup`;
/** The newest reviews and comments a watch keeps from one read. */
const MAX_ACTIVITY_ENTRIES = 50;
/**
 * A watch's reviews and comments come from their own query, not from
 * `gh pr view --json reviews,comments`: that pages through the pull request's
 * whole history, and a long enough discussion outgrows the command's 1 MiB
 * output cap, so every pass would fail. Only the newest window is asked for.
 */
const DISCUSSION_QUERY = `query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){reviewRequests(first:8){nodes{asCodeOwner requestedReviewer{... on User{login} ... on Team{combinedSlug}}}} reviews(last:${MAX_ACTIVITY_ENTRIES}){nodes{id authorAssociation author{login __typename} state submittedAt body viewerDidAuthor}} comments(last:${MAX_ACTIVITY_ENTRIES}){nodes{id authorAssociation author{login __typename} createdAt body viewerDidAuthor}}}}}`;
/**
 * Bodies are cut inside `gh`, before they reach stdout. jq slices by code
 * point, one past the byte clamp, so a body over the clamp still reaches
 * `clampBytes` long enough to be marked cut. Control characters are dropped
 * because `tojson` escapes each to six bytes; what is left costs at most four
 * bytes per code point, so 2 × 50 bodies stay near 820 KB, under the cap
 * however long the history is. (`tojson` is printed raw; gh's own encoder
 * would also escape `<`, `>` and `&` to six bytes.)
 */
const DISCUSSION_FILTER = `def cut: (.body // "")[0:${MAX_COMMENT_BYTES + 1}] | explode | map(select(. == 9 or . == 10 or . == 13 or (. > 31 and . != 127))) | implode; .data.repository.pullRequest | {reviewRequests: (.reviewRequests.nodes // []), reviews: [(.reviews.nodes // [])[] | .body = cut], comments: [(.comments.nodes // [])[] | .body = cut]} | tojson`;
const PASSING_CHECK_CONCLUSIONS = new Set(["SUCCESS", "NEUTRAL", "SKIPPED"]);
const REVIEW_THREADS_QUERY = `query($owner:String!,$name:String!,$number:Int!,$after:String){repository(owner:$owner,name:$name){pullRequest(number:$number){reviewThreads(first:${REVIEW_THREADS_PAGE},after:$after){pageInfo{hasNextPage endCursor} nodes{id isResolved isOutdated path line comments(first:10){nodes{authorAssociation author{login __typename} body}}}}}}}`;

/**
 * The forge calls behind Merge when ready and Auto-fix, through the host's
 * own `gh` login. Turning auto-merge on is the forge's own feature: the host
 * never merges in a loop of its own. Observations only read.
 */
export class GhPullRequestSwitchPort {
  readonly #command: GhCommandPort;
  readonly #environment: NodeJS.ProcessEnv;
  readonly #logBytes: number;

  constructor(options: {
    readonly command: GhCommandPort;
    readonly inheritedEnvironment?: NodeJS.ProcessEnv;
    /** How much of the end of a failed job's log one failure carries. */
    readonly logBytes?: number;
  }) {
    this.#command = options.command;
    this.#environment = sanitizeGhEnvironment(options.inheritedEnvironment ?? process.env);
    this.#logBytes = options.logBytes ?? 4_096;
  }

  async readAutoMergeSettings(
    request: Pick<GhPullRequestSwitchRequest, "owner" | "name">,
    signal: AbortSignal,
  ): Promise<GhAutoMergeSettings> {
    const repository = `${request.owner}/${request.name}`;
    if (!validRepository(repository)) return { status: "unavailable", reason: "unavailable" };
    const result = await this.#run(["api", `repos/${repository}`], signal);
    if (result === undefined) return { status: "unavailable", reason: "disconnected" };
    if (result.exitCode !== 0) {
      const failure = classifyFailure(result);
      return {
        status: "unavailable",
        reason: failure.status === "unavailable" ? failure.reason : "unavailable",
      };
    }
    const value = parseJson(result.stdout);
    if (!isRecord(value)) return { status: "unavailable", reason: "unavailable" };
    return {
      status: "read",
      allowAutoMerge: value.allow_auto_merge === true,
      methods: {
        merge: value.allow_merge_commit === true,
        squash: value.allow_squash_merge === true,
        rebase: value.allow_rebase_merge === true,
      },
    };
  }

  /**
   * Turns on the forge's auto-merge, pinned to the head the person saw, so a
   * push between the click and the forge's merge is refused by the forge.
   */
  async enableAutoMerge(
    request: GhPullRequestSwitchRequest & {
      readonly method: CodeProjectPullRequestMergeMethod;
      readonly headSha: string;
      /**
       * Expected GitHub pull request node ID from the identity owner. When
       * supplied, verified before enabling auto-merge so a head check can
       * never pass against another pull request's row.
       */
      readonly expectedPullRequestNodeId?: string;
    },
    signal: AbortSignal,
  ): Promise<GhAutoMergeResult> {
    const repository = `${request.owner}/${request.name}`;
    if (!validRepository(repository) || !validNumber(request.number)) {
      return { status: "refused", reason: "failed" };
    }
    if (request.expectedPullRequestNodeId !== undefined) {
      const check = await this.#run(
        [
          "pr",
          "view",
          String(request.number),
          "--repo",
          repository,
          "--json",
          "id,headRefOid,state",
        ],
        signal,
      );
      if (check === undefined) return { status: "unavailable", reason: "disconnected" };
      if (check.exitCode !== 0) return classifyFailure(check);
      const parsed = parseJson(check.stdout);
      if (!isRecord(parsed)) return { status: "unavailable", reason: "unavailable" };
      if (
        typeof parsed.id === "string" &&
        /^[A-Za-z0-9+/=_-]{1,128}$/.test(parsed.id) &&
        parsed.id !== request.expectedPullRequestNodeId
      ) {
        return { status: "refused", reason: "stale" };
      }
      if (typeof parsed.headRefOid === "string" && parsed.headRefOid !== request.headSha) {
        return { status: "refused", reason: "stale" };
      }
      if (normalizeState(parsed.state) !== "open") {
        return { status: "refused", reason: "not-open" };
      }
    }
    const result = await this.#run(
      [
        "pr",
        "merge",
        String(request.number),
        "--repo",
        repository,
        "--auto",
        `--${request.method}`,
        "--match-head-commit",
        request.headSha,
      ],
      signal,
    );
    if (result === undefined) return { status: "unavailable", reason: "disconnected" };
    if (result.exitCode === 0) return { status: "enabled" };
    return classifyFailure(result);
  }

  async disableAutoMerge(
    request: GhPullRequestSwitchRequest,
    signal: AbortSignal,
  ): Promise<GhAutoMergeResult> {
    const repository = `${request.owner}/${request.name}`;
    if (!validRepository(repository) || !validNumber(request.number)) {
      return { status: "refused", reason: "failed" };
    }
    const result = await this.#run(
      ["pr", "merge", String(request.number), "--repo", repository, "--disable-auto"],
      signal,
    );
    if (result === undefined) return { status: "unavailable", reason: "disconnected" };
    if (result.exitCode === 0) return { status: "disabled" };
    return classifyFailure(result);
  }

  /**
   * One read of what the switches watch: state, head, whether the forge still
   * holds auto-merge, failed required checks with a trimmed log tail,
   * unresolved review threads with their comments, and a merge conflict; and,
   * for a watch, every check on the head with the reviews and comments.
   */
  async observe(
    request: GhPullRequestSwitchRequest,
    signal: AbortSignal,
    reads: GhPullRequestSwitchReads = { failures: true, activity: false },
  ): Promise<GhPullRequestSwitchObservation> {
    const repository = `${request.owner}/${request.name}`;
    if (!validRepository(repository) || !validNumber(request.number)) {
      return { status: "unavailable" };
    }
    let fields = reads.activity ? ACTIVITY_VIEW_FIELDS : VIEW_FIELDS;
    if (reads.babysit) fields += ",isDraft,mergeStateStatus";
    if (reads.babysit?.requiredLabel !== undefined) fields += ",labels";
    const viewArguments = [
      "pr",
      "view",
      String(request.number),
      "--repo",
      repository,
      "--json",
      fields,
    ];
    const view = await this.#run(viewArguments, signal);
    if (view === undefined || view.exitCode !== 0) return { status: "unavailable" };
    const pullRequest = parseJson(view.stdout);
    if (!isRecord(pullRequest)) return { status: "unavailable" };
    const state = normalizeState(pullRequest.state);
    const headSha = typeof pullRequest.headRefOid === "string" ? pullRequest.headRefOid : "";
    if (state === undefined || headSha === "") return { status: "unavailable" };
    const conflicting = pullRequest.mergeable === "CONFLICTING";
    const reviewsPending =
      pullRequest.reviewDecision === "REVIEW_REQUIRED" ||
      pullRequest.reviewDecision === "CHANGES_REQUESTED";
    let activity: GhPullRequestActivity | undefined;
    if (reads.activity || (reads.babysit && state === "open")) {
      const discussion = await this.#recentDiscussion(request, signal);
      if (
        discussion === undefined ||
        (reads.babysit &&
          (!Array.isArray(discussion.reviews) || !Array.isArray(discussion.comments)))
      ) {
        return { status: "unavailable" };
      }
      activity = pullRequestActivity(pullRequest, discussion, conflicting);
    }
    const pullRequestNodeId =
      typeof pullRequest.id === "string" && /^[A-Za-z0-9+/=_-]{1,128}$/.test(pullRequest.id)
        ? pullRequest.id
        : undefined;
    const baseRepository =
      typeof pullRequest.url === "string"
        ? repositoryFromPullRequestUrl(pullRequest.url)
        : undefined;
    const base = {
      status: "observed" as const,
      state,
      headSha,
      headBranch: typeof pullRequest.headRefName === "string" ? pullRequest.headRefName : "",
      baseBranch: typeof pullRequest.baseRefName === "string" ? pullRequest.baseRefName : "",
      autoMergeEnabled: isRecord(pullRequest.autoMergeRequest),
      ...(pullRequestNodeId === undefined ? {} : { pullRequestNodeId }),
      ...(baseRepository === undefined ? {} : { baseRepository }),
      ...(activity === undefined ? {} : { activity }),
    };
    if (state !== "open" || !reads.failures) return { ...base, waitingOn: [], failures: [] };

    const checks = await this.#checks(request, signal, reads.babysit?.checks);
    if (checks === undefined) return { status: "unavailable" };
    const threads = await this.#unresolvedReviewThreads(
      request,
      signal,
      reads.babysit !== undefined,
    );
    if (threads === undefined) return { status: "unavailable" };

    const failures: GhAutoFixFailureDetail[] = [];
    let logged = 0;
    for (const check of checks.failed) {
      const log =
        logged < MAX_LOGGED_CHECKS && check.jobId !== undefined
          ? await this.#failedJobLog(repository, check.jobId, signal)
          : undefined;
      if (log !== undefined) logged += 1;
      failures.push({
        failure: { kind: "check", key: check.name },
        detail: log === undefined ? "No log excerpt was available." : log,
      });
    }
    failures.push(...threads.filter((thread) => !thread.outsideReviewer));
    if (conflicting) {
      failures.push({
        failure: { kind: "conflict", key: "base" },
        detail: `The branch ${base.headBranch} conflicts with ${base.baseBranch}.`,
      });
    }
    if (reads.babysit && pullRequest.mergeStateStatus === "BEHIND" && !conflicting) {
      failures.push({
        failure: { kind: "behind", key: "base" },
        detail: "GitHub requires the branch to be brought up to date with its base.",
      });
    }
    let babysitReady = false;
    let babysitBlockerDetail: string | undefined;
    let babysitBlocker: PullRequestBabysitStatus | undefined;
    if (reads.babysit !== undefined) {
      const label = reads.babysit.requiredLabel;
      const hasLabel =
        label === undefined ||
        (Array.isArray(pullRequest.labels) &&
          pullRequest.labels.some(
            (entry) =>
              isRecord(entry) &&
              typeof entry.name === "string" &&
              entry.name.toLowerCase() === label.toLowerCase(),
          ));
      if (pullRequest.isDraft === true) babysitBlocker = "draft";
      else if (!hasLabel) babysitBlocker = "label";
      else if (pullRequest.reviewDecision === "REVIEW_REQUIRED") babysitBlocker = "approval";
      else if (checks.pending) babysitBlocker = "checks";
      else if (reviewsPending && failures.length === 0) babysitBlocker = "approval";
      else if (threads.some((entry) => entry.outsideReviewer)) babysitBlocker = "outside-review";
      else babysitBlocker = "repository";
      if (babysitBlocker === "approval") {
        babysitBlockerDetail =
          pullRequest.reviewDecision === "CHANGES_REQUESTED"
            ? "Changes requested in review"
            : activity?.requestedApproval;
      }
      if (
        babysitBlocker === "repository" &&
        pullRequest.mergeStateStatus === "BLOCKED" &&
        failures.length === 0
      ) {
        babysitBlockerDetail = await this.#requiredDeploymentBlocker(
          request,
          base.baseBranch,
          headSha,
          signal,
        );
      }
      const candidate =
        failures.length === 0 &&
        threads.length === 0 &&
        !checks.pending &&
        !reviewsPending &&
        pullRequest.isDraft === false &&
        pullRequest.mergeable === "MERGEABLE" &&
        hasLabel;
      // UNSTABLE can mean only an optional job failed. In that case check the
      // base's requirements, including any required check that has yet to report.
      babysitReady =
        candidate &&
        (pullRequest.mergeStateStatus === "CLEAN" ||
          (pullRequest.mergeStateStatus === "UNSTABLE" &&
            reads.babysit.checks === "required" &&
            (await this.#requiredChecksForCondition(
              request,
              repository,
              base.baseBranch,
              "UNSTABLE",
              signal,
            )) === "green"));
      // Checks and discussions were read separately. A push during that work
      // invalidates both a repair prompt and a ready notification.
      const latest = await this.#run(viewArguments, signal);
      const finalView = latest?.exitCode === 0 ? parseJson(latest.stdout) : undefined;
      if (
        !isRecord(finalView) ||
        finalView.headRefOid !== headSha ||
        finalView.baseRefName !== pullRequest.baseRefName ||
        finalView.state !== pullRequest.state ||
        finalView.mergeStateStatus !== pullRequest.mergeStateStatus ||
        finalView.mergeable !== pullRequest.mergeable ||
        finalView.isDraft !== pullRequest.isDraft ||
        finalView.reviewDecision !== pullRequest.reviewDecision ||
        (label !== undefined &&
          JSON.stringify(finalView.labels) !== JSON.stringify(pullRequest.labels))
      ) {
        return { status: "unavailable" };
      }
    }
    const waitingOn: CodeProjectPullRequestMergeWait[] = [];
    const mergeChecks =
      reads.babysit?.checks === "all" &&
      base.autoMergeEnabled &&
      (checks.pending || checks.failed.length > 0)
        ? await this.#checks(request, signal)
        : checks;
    if (mergeChecks === undefined) return { status: "unavailable" };
    if (mergeChecks.pending || mergeChecks.failed.length > 0) waitingOn.push("checks");
    if (reviewsPending || threads.length > 0) waitingOn.push("reviews");
    if (conflicting) waitingOn.push("conflicts");
    return {
      ...base,
      waitingOn,
      failures: failures.slice(0, MAX_CODE_PROJECT_PULL_REQUEST_AUTO_FIX_FAILURES),
      ...(babysitBlockerDetail && !babysitReady ? { babysitBlockerDetail } : {}),
      ...(babysitBlocker && !babysitReady ? { babysitBlocker } : {}),
      ...(reads.babysit === undefined ? {} : { babysitReady }),
    };
  }

  /**
   * Closed-set read for a coordinator's done-when condition: only merge state
   * and (when requested) required checks status, never PR titles, comments, or
   * check logs.
   */
  async observePullRequestCondition(
    request: GhPullRequestSwitchRequest,
    options: { readonly requiredChecks: boolean },
    signal: AbortSignal,
  ): Promise<CoordinatorDoneWhenPullRequestFact> {
    const repository = `${request.owner}/${request.name}`;
    if (!validRepository(repository) || !validNumber(request.number)) {
      return { status: "unavailable" };
    }
    const view = await this.#run(
      [
        "pr",
        "view",
        String(request.number),
        "--repo",
        repository,
        "--json",
        options.requiredChecks ? "state,baseRefName,mergeStateStatus" : "state",
      ],
      signal,
    );
    if (view === undefined || view.exitCode !== 0) return { status: "unavailable" };
    const pullRequest = parseJson(view.stdout);
    if (!isRecord(pullRequest)) return { status: "unavailable" };
    const state = normalizeState(pullRequest.state);
    if (state === undefined) return { status: "unavailable" };
    if (!options.requiredChecks) return { status: "observed", state };
    const mergeStateStatus =
      typeof pullRequest.mergeStateStatus === "string"
        ? pullRequest.mergeStateStatus.toUpperCase()
        : undefined;
    const baseBranch =
      typeof pullRequest.baseRefName === "string" && pullRequest.baseRefName.trim() !== ""
        ? pullRequest.baseRefName.trim()
        : undefined;
    const requiredChecks = await this.#requiredChecksForCondition(
      request,
      repository,
      baseBranch,
      mergeStateStatus,
      signal,
    );
    return { status: "observed", state, requiredChecks };
  }

  /**
   * Distinguishes passing required checks from unreported checks independently
   * of review or other merge gates. Because `gh pr checks --required` only
   * lists checks that have reported on the PR head (and omits GitHub App ids),
   * whenever `mergeStateStatus` is not `CLEAN` and required checks exist we
   * load the base branch's required status checks (preserving pinned GitHub
   * App ids) and inspect the GraphQL commit rollups cohesively: when
   * `potentialMergeCommit` has reported statuses it is authoritative, falling
   * back to the head commit only when the test-merge commit has none.
   */
  async #requiredChecksForCondition(
    request: GhPullRequestSwitchRequest,
    repository: string,
    baseBranch: string | undefined,
    mergeStateStatus: string | undefined,
    signal: AbortSignal,
  ): Promise<"green" | "pending" | "failing" | "unavailable"> {
    const result = await this.#run(
      [
        "pr",
        "checks",
        String(request.number),
        "--repo",
        repository,
        "--required",
        "--json",
        "name,bucket",
      ],
      signal,
    );
    if (result === undefined) return "unavailable";
    const value = parseJson(result.stdout);
    const noChecksReported = !Array.isArray(value)
      ? lacksChecksJson(result) ||
        /no required checks|no checks reported/i.test(`${result.stderr ?? ""}\n${result.stdout}`)
      : value.length === 0;
    if (!noChecksReported) {
      if (!Array.isArray(value)) return "unavailable";
      let pending = false;
      for (const entry of value) {
        if (!isRecord(entry)) return "unavailable";
        if (entry.bucket === "fail" || entry.bucket === "cancel") return "failing";
        if (entry.bucket === "pending") {
          pending = true;
        } else if (entry.bucket !== "pass" && entry.bucket !== "skipping") {
          return "unavailable";
        }
      }
      if (pending) return "pending";
    }
    if (mergeStateStatus === "CLEAN") return "green";
    const required = await this.#baseBranchRequiredChecks(repository, baseBranch, signal);
    if (required.status !== "ready") return "unavailable";
    if (required.checks.length === 0) return "green";

    const rollups = await this.#pullRequestCommitRollups(
      request.owner,
      request.name,
      request.number,
      signal,
    );
    if (rollups.status !== "ready") return "unavailable";
    if (rollups.testMergeChecks !== undefined && rollups.testMergeChecks.length > 0) {
      return evaluateCommitRequiredChecks(required.checks, rollups.testMergeChecks);
    }
    return evaluateCommitRequiredChecks(required.checks, rollups.headChecks);
  }

  /**
   * Read-only lookup of every required status check configured on `baseBranch`
   * via classic branch protection or paginated repository rulesets, preserving
   * pinned GitHub App ids (`app_id` / `integration_id`) so same-name checks
   * from distinct apps are tracked separately. Fails closed as `unknown` when
   * either endpoint cannot be read or any page/entry cannot be decoded.
   */
  async #baseBranchRequiredChecks(
    repository: string,
    baseBranch: string | undefined,
    signal: AbortSignal,
  ): Promise<
    | { readonly status: "ready"; readonly checks: ReadonlyArray<RequiredStatusCheck> }
    | { readonly status: "unknown" }
  > {
    if (
      baseBranch === undefined ||
      baseBranch.length > 255 ||
      /[\s\\?#:[\]^~*@{}\0]/.test(baseBranch) ||
      baseBranch.includes("..")
    ) {
      return { status: "unknown" };
    }
    const encodedBranch = encodeURIComponent(baseBranch);
    const checksByKey = new Map<string, RequiredStatusCheck>();
    const addRequiredCheck = (context: string, appId?: number) => {
      const key = `${context}\0${appId === undefined ? "*" : String(appId)}`;
      if (!checksByKey.has(key)) {
        checksByKey.set(key, appId === undefined ? { context } : { context, appId });
      }
    };

    const branchResult = await this.#run(
      ["api", `repos/${repository}/branches/${encodedBranch}`],
      signal,
    );
    if (branchResult === undefined || branchResult.exitCode !== 0) return { status: "unknown" };
    const branchJson = parseJson(branchResult.stdout);
    if (!isRecord(branchJson)) return { status: "unknown" };
    const protection = isRecord(branchJson.protection) ? branchJson.protection : undefined;
    const protectionChecks =
      protection?.enabled === true && isRecord(protection.required_status_checks)
        ? protection.required_status_checks
        : undefined;
    if (protectionChecks !== undefined) {
      const hasStructuredChecks =
        Array.isArray(protectionChecks.checks) && protectionChecks.checks.length > 0;
      if (hasStructuredChecks && Array.isArray(protectionChecks.checks)) {
        for (const check of protectionChecks.checks) {
          if (
            !isRecord(check) ||
            typeof check.context !== "string" ||
            check.context.trim().length === 0
          ) {
            return { status: "unknown" };
          }
          const appId = parseRequiredCheckAppId(check.app_id);
          if (appId === "invalid") return { status: "unknown" };
          addRequiredCheck(check.context, appId);
        }
      } else if (Array.isArray(protectionChecks.contexts)) {
        for (const context of protectionChecks.contexts) {
          if (typeof context !== "string" || context.trim().length === 0) {
            return { status: "unknown" };
          }
          addRequiredCheck(context);
        }
      }
    }

    const rulesResult = await this.#run(
      ["api", "--paginate", "--slurp", `repos/${repository}/rules/branches/${encodedBranch}`],
      signal,
    );
    if (rulesResult === undefined || rulesResult.exitCode !== 0) return { status: "unknown" };
    const rulesPages = parseJson(rulesResult.stdout);
    if (!Array.isArray(rulesPages)) return { status: "unknown" };
    for (const page of rulesPages) {
      if (!Array.isArray(page)) return { status: "unknown" };
      for (const rule of page) {
        if (!isRecord(rule)) return { status: "unknown" };
        if (rule.type !== "required_status_checks") continue;
        const params = isRecord(rule.parameters) ? rule.parameters : undefined;
        if (!Array.isArray(params?.required_status_checks)) return { status: "unknown" };
        for (const check of params.required_status_checks) {
          if (
            !isRecord(check) ||
            typeof check.context !== "string" ||
            check.context.trim().length === 0
          ) {
            return { status: "unknown" };
          }
          const appId = parseRequiredCheckAppId(check.integration_id);
          if (appId === "invalid") return { status: "unknown" };
          addRequiredCheck(check.context, appId);
        }
      }
    }
    return { status: "ready", checks: [...checksByKey.values()] };
  }

  /**
   * Reads the check rollups for the PR head commit and optional test merge
   * commit (`potentialMergeCommit`) so each commit can be evaluated cohesively
   * with full GitHub App identity (`checkSuite.app.databaseId`).
   */
  async #pullRequestCommitRollups(
    owner: string,
    name: string,
    number: number,
    signal: AbortSignal,
  ): Promise<
    | {
        readonly status: "ready";
        readonly headChecks: ReadonlyArray<ObservedCommitCheck>;
        readonly testMergeChecks?: ReadonlyArray<ObservedCommitCheck>;
      }
    | { readonly status: "unavailable" }
  > {
    const result = await this.#run(
      [
        "api",
        "graphql",
        "-f",
        `owner=${owner}`,
        "-f",
        `name=${name}`,
        "-F",
        `number=${String(number)}`,
        "-f",
        `query=${PR_COMMIT_ROLLUPS_QUERY}`,
      ],
      signal,
    );
    if (result === undefined || result.exitCode !== 0) return { status: "unavailable" };
    const parsed = parseJson(result.stdout);
    const data = isRecord(parsed) && isRecord(parsed.data) ? parsed.data : undefined;
    const repo = data !== undefined && isRecord(data.repository) ? data.repository : undefined;
    const pr = repo !== undefined && isRecord(repo.pullRequest) ? repo.pullRequest : undefined;
    const commits = pr !== undefined && isRecord(pr.commits) ? pr.commits : undefined;
    const commitNodes = Array.isArray(commits?.nodes) ? commits.nodes : undefined;
    const firstNode =
      commitNodes !== undefined && isRecord(commitNodes[0]) ? commitNodes[0] : undefined;
    const headCommit =
      firstNode !== undefined && isRecord(firstNode.commit) ? firstNode.commit : undefined;
    if (headCommit === undefined) return { status: "unavailable" };

    const headChecks = await this.#collectCommitRollupChecks(
      owner,
      name,
      number,
      "head",
      headCommit,
      signal,
    );
    if (headChecks === undefined) return { status: "unavailable" };

    if (pr?.potentialMergeCommit === null || pr?.potentialMergeCommit === undefined) {
      return { status: "ready", headChecks };
    }
    if (!isRecord(pr.potentialMergeCommit)) return { status: "unavailable" };
    const testMergeChecks = await this.#collectCommitRollupChecks(
      owner,
      name,
      number,
      "merge",
      pr.potentialMergeCommit,
      signal,
    );
    if (testMergeChecks === undefined) return { status: "unavailable" };
    return { status: "ready", headChecks, testMergeChecks };
  }

  async #collectCommitRollupChecks(
    owner: string,
    name: string,
    number: number,
    target: "head" | "merge",
    commit: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<ReadonlyArray<ObservedCommitCheck> | undefined> {
    const collected: ObservedCommitCheck[] = [];
    const firstPage = parseCommitRollupPage(commit.statusCheckRollup);
    if (firstPage === "invalid") return undefined;
    if (firstPage === "empty") return collected;
    collected.push(...firstPage.checks);
    let hasNextPage = firstPage.hasNextPage;
    let cursor = firstPage.endCursor;
    const expectedOid =
      typeof commit.oid === "string" && commit.oid.length > 0 ? commit.oid : undefined;
    let pagesRead = 1;
    while (hasNextPage) {
      if (expectedOid === undefined || cursor === undefined || pagesRead >= MAX_ROLLUP_PAGES) {
        return undefined;
      }
      const nextResult = await this.#run(
        [
          "api",
          "graphql",
          "-f",
          `owner=${owner}`,
          "-f",
          `name=${name}`,
          "-F",
          `number=${String(number)}`,
          "-f",
          `cursor=${cursor}`,
          "-f",
          `query=${target === "head" ? PR_HEAD_ROLLUP_PAGE_QUERY : PR_MERGE_ROLLUP_PAGE_QUERY}`,
        ],
        signal,
      );
      if (nextResult === undefined || nextResult.exitCode !== 0) return undefined;
      const nextParsed = parseJson(nextResult.stdout);
      const data = isRecord(nextParsed) && isRecord(nextParsed.data) ? nextParsed.data : undefined;
      const repo = data !== undefined && isRecord(data.repository) ? data.repository : undefined;
      const pr = repo !== undefined && isRecord(repo.pullRequest) ? repo.pullRequest : undefined;
      let nextCommit: Record<string, unknown> | undefined;
      if (target === "head") {
        const commits = pr !== undefined && isRecord(pr.commits) ? pr.commits : undefined;
        const nodes = Array.isArray(commits?.nodes) ? commits.nodes : undefined;
        const first = nodes !== undefined && isRecord(nodes[0]) ? nodes[0] : undefined;
        nextCommit = first !== undefined && isRecord(first.commit) ? first.commit : undefined;
      } else {
        nextCommit =
          pr !== undefined && isRecord(pr.potentialMergeCommit)
            ? pr.potentialMergeCommit
            : undefined;
      }
      if (nextCommit === undefined || nextCommit.oid !== expectedOid) return undefined;
      const page = parseCommitRollupPage(nextCommit.statusCheckRollup);
      if (page === "invalid" || page === "empty") return undefined;
      collected.push(...page.checks);
      hasNextPage = page.hasNextPage;
      cursor = page.endCursor;
      pagesRead += 1;
    }
    return collected;
  }

  async #checks(
    request: GhPullRequestSwitchRequest,
    signal: AbortSignal,
    scope?: "required" | "all",
  ): Promise<
    | {
        readonly pending: boolean;
        readonly failed: ReadonlyArray<{ readonly name: string; readonly jobId?: string }>;
      }
    | undefined
  > {
    const result = await this.#run(
      [
        "pr",
        "checks",
        String(request.number),
        "--repo",
        `${request.owner}/${request.name}`,
        ...(scope === "all" ? [] : ["--required"]),
        "--json",
        "name,bucket,link",
      ],
      signal,
    );
    if (result === undefined) return undefined;
    if (lacksChecksJson(result)) {
      const rollups = await this.#pullRequestCommitRollups(
        request.owner,
        request.name,
        request.number,
        signal,
      );
      if (rollups.status !== "ready") return undefined;
      const latest = selectLatestCommitChecks(
        rollups.testMergeChecks?.length ? rollups.testMergeChecks : rollups.headChecks,
      );
      if (scope !== "all" && latest.some((check) => check.isRequired === undefined))
        return undefined;
      const selected = scope === "all" ? latest : latest.filter((check) => check.isRequired);
      return {
        pending:
          (scope === "all" && selected.length === 0) ||
          selected.some((check) => check.bucket === "pending"),
        failed: selected
          .filter((check) => check.bucket === "failing")
          .map((check) => ({
            name: check.context.slice(0, 512),
            ...(check.jobId === undefined ? {} : { jobId: check.jobId }),
          })),
      };
    }
    // `gh pr checks` exits non-zero while a check is failing or pending, and
    // also when the repository requires none; only unreadable output is a
    // failed observation.
    const value = parseJson(result.stdout);
    if (!Array.isArray(value)) {
      return /no required checks|no checks reported/i.test(
        `${result.stderr ?? ""}\n${result.stdout}`,
      )
        ? { pending: scope === "all", failed: [] }
        : undefined;
    }
    const failed: Array<{ readonly name: string; readonly jobId?: string }> = [];
    let pending = scope === "all" && value.length === 0;
    for (const entry of value) {
      if (!isRecord(entry) || typeof entry.name !== "string" || entry.name.trim() === "") {
        if (scope !== undefined) return undefined;
        continue;
      }
      if (
        scope !== undefined &&
        !["pass", "pending", "fail", "cancel", "skipping"].includes(String(entry.bucket))
      )
        return undefined;
      if (entry.bucket === "pending") pending = true;
      if (entry.bucket !== "fail" && entry.bucket !== "cancel") continue;
      const jobId =
        typeof entry.link === "string"
          ? /\/actions\/runs\/\d+\/job\/(\d+)/.exec(entry.link)?.[1]
          : undefined;
      failed.push({
        name: entry.name.trim().slice(0, 512),
        ...(jobId === undefined ? {} : { jobId }),
      });
    }
    return { pending, failed };
  }

  /** Explain a blocked head only when an active base rule and its deployment evidence agree. */
  async #requiredDeploymentBlocker(
    request: GhPullRequestSwitchRequest,
    branch: string,
    head: string,
    signal: AbortSignal,
  ): Promise<string | undefined> {
    if (!branch || branch.includes("..") || !/^[0-9a-f]{40}$/i.test(head)) return;
    const rules = await this.#run(
      [
        "api",
        `repos/${request.owner}/${request.name}/rules/branches/${encodeURIComponent(branch)}`,
      ],
      signal,
    );
    const rows = rules?.exitCode === 0 ? parseJson(rules.stdout) : undefined;
    if (!Array.isArray(rows)) return;
    const environments = rows
      .filter(isRecord)
      .filter((r) => r.type === "required_deployments")
      .flatMap((rule) => {
        const names = readPath(rule, ["parameters", "required_deployment_environments"]);
        return Array.isArray(names)
          ? names.filter(
              (name): name is string =>
                typeof name === "string" &&
                name.length > 0 &&
                name.length <= 100 &&
                !/\p{Cc}/u.test(name),
            )
          : [];
      });
    if (!environments.length) return;
    const wanted = [...new Set(environments)].slice(0, 10);
    const query =
      "query($owner:String!,$repo:String!,$head:String!,$env:[String!]!){repository(owner:$owner,name:$repo){object(expression:$head){... on Commit{deployments(first:50,environments:$env,orderBy:{field:CREATED_AT,direction:DESC}){nodes{environment latestStatus{state}} pageInfo{hasNextPage}}}}}}";
    const result = await this.#run(
      [
        "api",
        "graphql",
        "-f",
        `query=${query}`,
        "-f",
        `owner=${request.owner}`,
        "-f",
        `repo=${request.name}`,
        "-f",
        `head=${head}`,
        ...wanted.flatMap((name) => ["-f", `env[]=${name}`]),
      ],
      signal,
    );
    const deployments =
      result?.exitCode === 0
        ? readPath(parseJson(result.stdout), ["data", "repository", "object", "deployments"])
        : undefined;
    if (!isRecord(deployments) || !Array.isArray(deployments.nodes)) return;
    for (const name of wanted) {
      const latest = deployments.nodes.find(
        (entry) => isRecord(entry) && entry.environment === name,
      );
      if (
        latest
          ? readPath(latest, ["latestStatus", "state"]) !== "SUCCESS"
          : readPath(deployments, ["pageInfo", "hasNextPage"]) === false
      )
        return `Waiting for required deployment to ${name}`;
    }
    return;
  }

  async #unresolvedReviewThreads(
    request: GhPullRequestSwitchRequest,
    signal: AbortSignal,
    verifyComplete: boolean,
  ): Promise<ReadonlyArray<GhAutoFixFailureDetail> | undefined> {
    const threads: GhAutoFixFailureDetail[] = [];
    let outsideThread: GhAutoFixFailureDetail | undefined;
    let after: string | undefined;
    // Resolved and outdated threads count against a page, so an unresolved one
    // can sit past the first page: follow the cursor until there is enough to
    // report or no more pages.
    for (let page = 0; page < MAX_REVIEW_THREAD_PAGES; page += 1) {
      const result = await this.#run(
        [
          "api",
          "graphql",
          "-f",
          `query=${REVIEW_THREADS_QUERY}`,
          "-F",
          `owner=${request.owner}`,
          "-F",
          `name=${request.name}`,
          "-F",
          `number=${request.number}`,
          ...(after === undefined ? [] : ["-f", `after=${after}`]),
        ],
        signal,
      );
      if (result === undefined || result.exitCode !== 0) return undefined;
      const connection = readPath(parseJson(result.stdout), [
        "data",
        "repository",
        "pullRequest",
        "reviewThreads",
      ]);
      const nodes = readPath(connection, ["nodes"]);
      if (!Array.isArray(nodes)) return undefined;
      for (const node of nodes) {
        if (
          verifyComplete &&
          (!isRecord(node) ||
            typeof node.id !== "string" ||
            typeof node.isResolved !== "boolean" ||
            typeof node.isOutdated !== "boolean")
        )
          return undefined;
        const thread = reviewThreadFailure(node, verifyComplete);
        if (thread?.outsideReviewer) outsideThread ??= thread;
        else if (thread) threads.push(thread);
      }
      if (threads.length >= MAX_CODE_PROJECT_PULL_REQUEST_AUTO_FIX_FAILURES) break;
      const next = readPath(connection, ["pageInfo", "endCursor"]);
      const more = readPath(connection, ["pageInfo", "hasNextPage"]);
      if (
        verifyComplete &&
        threads.length === 0 &&
        outsideThread === undefined &&
        (typeof more !== "boolean" ||
          (more && (typeof next !== "string" || page + 1 === MAX_REVIEW_THREAD_PAGES)))
      )
        return undefined;
      if (more !== true || typeof next !== "string") {
        break;
      }
      after = next;
    }
    // One outside thread is enough to explain the human gate. Keep repair slots for eligible findings.
    if (outsideThread) threads.push(outsideThread);
    return threads;
  }

  /** The newest reviews and comments, bodies already cut by `DISCUSSION_FILTER`. */
  async #recentDiscussion(
    request: GhPullRequestSwitchRequest,
    signal: AbortSignal,
  ): Promise<Record<string, unknown> | undefined> {
    const result = await this.#run(
      [
        "api",
        "graphql",
        "-f",
        `query=${DISCUSSION_QUERY}`,
        "-F",
        `owner=${request.owner}`,
        "-F",
        `name=${request.name}`,
        "-F",
        `number=${request.number}`,
        "--jq",
        DISCUSSION_FILTER,
      ],
      signal,
    );
    if (result === undefined || result.exitCode !== 0) return undefined;
    const discussion = parseJson(result.stdout);
    return isRecord(discussion) ? discussion : undefined;
  }

  /**
   * The ends of the failed jobs' logs on the pull request's current head, for
   * the thread's agent. Only the head's checks are read, so a log from a
   * superseded push never reaches it. Every log is redacted before it leaves.
   */
  async readCiLogs(
    request: GhPullRequestSwitchRequest,
    input: {
      readonly check?: string;
      readonly tailLines: number;
      readonly maxBytes: number;
      readonly expectedPullRequestNodeId?: string;
    },
    signal: AbortSignal,
  ): Promise<GhCiLogsResult> {
    const repository = `${request.owner}/${request.name}`;
    if (!validRepository(repository) || !validNumber(request.number)) {
      return { status: "unavailable" };
    }
    const head = await this.#openHead(request, signal, input.expectedPullRequestNodeId);
    if (head.status !== "open") return head;
    const checks = await this.#ciChecks(request, signal);
    if (checks === undefined) return { status: "unavailable" };
    const running = checks
      .filter((check) => check.bucket === "pending")
      .map((check) => check.name)
      .slice(0, MAX_CI_RUNNING_NAMES);
    let selected: ReadonlyArray<CiCheck>;
    if (input.check !== undefined) {
      const wanted = checkName(input.check);
      const named = checks.filter((check) => check.name === wanted);
      if (named.length === 0) return { status: "refused", reason: "no-such-check" };
      selected = named;
    } else {
      selected = checks.filter((check) => check.bucket === "fail" || check.bucket === "cancel");
    }
    const failedWithLog = selected.filter(
      (check) => (check.bucket === "fail" || check.bucket === "cancel") && check.jobId,
    ).length;
    const perLogBytes = Math.max(
      1_024,
      Math.floor(input.maxBytes / Math.max(1, Math.min(failedWithLog, MAX_CI_LOGGED_CHECKS))),
    );
    const logs: GhCiLogEntry[] = [];
    // A run is read once per log read, however many of its jobs failed.
    const runHeads = new Map<string, CiRunState | undefined>();
    let read = 0;
    for (const check of selected) {
      if (check.bucket === "pending") {
        logs.push({ check: check.name, status: "no-log", reason: "running" });
        continue;
      }
      if (check.bucket !== "fail" && check.bucket !== "cancel") {
        logs.push({ check: check.name, status: "no-log", reason: "passed" });
        continue;
      }
      if (check.jobId === undefined || check.runId === undefined) {
        logs.push({ check: check.name, status: "no-log", reason: "external" });
        continue;
      }
      if (read >= MAX_CI_LOGGED_CHECKS) {
        logs.push({ check: check.name, status: "no-log", reason: "not-read" });
        continue;
      }
      read += 1;
      // A commit status can link any run in the repository; only a run of the
      // current head is this pull request's CI.
      if (!runHeads.has(check.runId)) {
        runHeads.set(check.runId, await this.#runState(repository, check.runId, signal));
      }
      const run = runHeads.get(check.runId);
      if (run === undefined) {
        logs.push({ check: check.name, status: "no-log", reason: "unavailable" });
        continue;
      }
      if (run.headSha !== head.headSha) {
        logs.push({ check: check.name, status: "no-log", reason: "other-commit" });
        continue;
      }
      // The link names its run and job separately, and a commit status can
      // pair the head's run with any job of the repository's: only a job of
      // that run is this pull request's.
      if (!run.jobIds.has(check.jobId)) {
        logs.push({ check: check.name, status: "no-log", reason: "external" });
        continue;
      }
      const log = await this.#jobLog(repository, check.jobId, signal, check.bucket === "cancel");
      if (log.status !== "log") {
        logs.push({ check: check.name, status: "no-log", reason: log.status });
        continue;
      }
      const tail = tailLinesAndBytes(redactHostSecrets(log.text), input.tailLines, perLogBytes);
      logs.push({ check: check.name, status: "log", log: tail.text, truncated: tail.truncated });
    }
    return { status: "read", headSha: head.headSha, logs, running };
  }

  /**
   * Reads what a rerun would start, without starting it: every run must
   * belong to the pull request's current head, have finished, and have fewer
   * than `maxReruns` reruns already. GitHub's own run attempt counts the
   * reruns, so the cap holds across restarts and counts reruns started
   * elsewhere.
   */
  async planCiRerun(
    request: GhPullRequestSwitchRequest,
    input: {
      readonly check?: string;
      readonly headSha?: string;
      readonly maxReruns: number;
      readonly expectedPullRequestNodeId?: string;
    },
    signal: AbortSignal,
  ): Promise<GhCiRerunPlan> {
    const repository = `${request.owner}/${request.name}`;
    if (!validRepository(repository) || !validNumber(request.number)) {
      return { status: "unavailable" };
    }
    const head = await this.#openHead(request, signal, input.expectedPullRequestNodeId);
    if (head.status !== "open") return head;
    if (input.headSha !== undefined && input.headSha !== head.headSha) {
      return { status: "refused", reason: "superseded-head" };
    }
    const checks = await this.#ciChecks(request, signal);
    if (checks === undefined) return { status: "unavailable" };
    let selected: ReadonlyArray<CiCheck>;
    if (input.check !== undefined) {
      const wanted = checkName(input.check);
      const named = checks.filter((check) => check.name === wanted);
      if (named.length === 0) return { status: "refused", reason: "no-such-check" };
      // Two workflows may report a job of the same name, as ci-logs shows;
      // the rerun takes every failed one, never whichever GitHub listed first.
      const failed = named.filter((check) => check.bucket === "fail" || check.bucket === "cancel");
      const rerunnable = failed.filter(
        (check) => check.runId !== undefined && check.jobId !== undefined,
      );
      if (rerunnable.length > 0) selected = rerunnable;
      else if (failed.length > 0) return { status: "refused", reason: "external-check" };
      else if (named.some((check) => check.bucket === "pending")) {
        return { status: "refused", reason: "still-running" };
      } else return { status: "refused", reason: "not-failed" };
    } else {
      const failed = checks.filter((check) => check.bucket === "fail" || check.bucket === "cancel");
      if (failed.length === 0) return { status: "refused", reason: "no-failed-checks" };
      selected = failed.filter((check) => check.runId !== undefined);
      if (selected.length === 0) return { status: "refused", reason: "external-check" };
    }
    // A named check reruns its job alone; a run keyed by job keeps two
    // same-named jobs of one run apart.
    const byRun = new Map<string, { runId: string; jobId?: string; checks: string[] }>();
    for (const check of selected) {
      if (check.runId === undefined) continue;
      const jobId = input.check === undefined ? undefined : check.jobId;
      const key = jobId === undefined ? check.runId : `${check.runId}/${jobId}`;
      const entry = byRun.get(key) ?? {
        runId: check.runId,
        ...(jobId === undefined ? {} : { jobId }),
        checks: [],
      };
      entry.checks.push(check.name);
      byRun.set(key, entry);
    }
    const runs: Array<{
      runId: string;
      jobId?: string;
      checks: ReadonlyArray<string>;
      attempt: number;
    }> = [];
    for (const entry of byRun.values()) {
      const checked = await this.#rerunnable(
        repository,
        entry.runId,
        head.headSha,
        input.maxReruns,
        signal,
        entry.jobId,
      );
      if (checked.status !== "rerunnable") return checked;
      runs.push({ ...entry, attempt: checked.attempt });
    }
    return {
      status: "planned",
      headSha: head.headSha,
      ...(head.pullRequestNodeId === undefined
        ? {}
        : { pullRequestNodeId: head.pullRequestNodeId }),
      maxReruns: input.maxReruns,
      runs,
    };
  }

  /**
   * Starts a planned rerun, but only while the pull request's head is still
   * the one the plan was read on: a push since then supersedes every run in it.
   */
  async rerunCi(
    request: GhPullRequestSwitchRequest,
    plan: Extract<GhCiRerunPlan, { status: "planned" }>,
    signal: AbortSignal,
  ): Promise<GhCiRerunResult> {
    const repository = `${request.owner}/${request.name}`;
    if (!validRepository(repository) || !validNumber(request.number)) {
      return { status: "unavailable" };
    }
    const head = await this.#openHead(request, signal, plan.pullRequestNodeId);
    if (head.status === "unavailable") return head;
    if (head.status === "refused" && head.reason === "pull-request-replaced") {
      return { status: "refused", reason: "pull-request-replaced" };
    }
    if (head.status !== "open" || head.headSha !== plan.headSha) {
      return { status: "refused", reason: "superseded-head" };
    }
    // The person may have answered long after the plan was read, and another
    // approved rerun may have run meanwhile: every run is checked again.
    for (const run of plan.runs) {
      const checked = await this.#rerunnable(
        repository,
        run.runId,
        plan.headSha,
        plan.maxReruns,
        signal,
        run.jobId,
      );
      if (checked.status === "unavailable") return checked;
      if (checked.status === "refused") {
        return {
          status: "refused",
          reason:
            checked.reason === "rerun-limit" || checked.reason === "still-running"
              ? checked.reason
              : checked.reason === "external-check"
                ? "run-changed"
                : "superseded-head",
        };
      }
      // Someone reran the run while the person read the approval: the jobs
      // `--failed` would rerun now are not the ones the approval named.
      if (run.attempt !== undefined && checked.attempt !== run.attempt) {
        return { status: "refused", reason: "run-changed" };
      }
    }
    const rerun: string[] = [];
    for (const run of plan.runs) {
      if (
        !/^\d{1,20}$/.test(run.runId) ||
        (run.jobId !== undefined && !/^\d{1,20}$/.test(run.jobId))
      ) {
        return { status: "failed", rerun };
      }
      const result = await this.#run(
        run.jobId === undefined
          ? ["run", "rerun", run.runId, "--failed", "--repo", repository]
          : ["run", "rerun", "--job", run.jobId, "--repo", repository],
        signal,
      );
      if (result === undefined || result.exitCode !== 0) return { status: "failed", rerun };
      rerun.push(...run.checks);
    }
    return { status: "rerun", checks: rerun };
  }

  /**
   * Whether one run may be rerun now: on this head, finished, under the
   * limit, and holding the named job. Answers the run's attempt when it may.
   */
  async #rerunnable(
    repository: string,
    runId: string,
    headSha: string,
    maxReruns: number,
    signal: AbortSignal,
    jobId?: string,
  ): Promise<
    | Readonly<{
        status: "refused";
        reason: "superseded-head" | "still-running" | "rerun-limit" | "external-check";
      }>
    | Readonly<{ status: "unavailable" }>
    | Readonly<{ status: "rerunnable"; attempt: number }>
  > {
    const run = await this.#runState(repository, runId, signal);
    if (run === undefined) return { status: "unavailable" };
    if (run.headSha !== headSha) return { status: "refused", reason: "superseded-head" };
    // A link pairing the head's run with another run's job reaches no job of this pull request.
    if (jobId !== undefined && !run.jobIds.has(jobId)) {
      return { status: "refused", reason: "external-check" };
    }
    // The limit first: a rerun another approval just started is both, and the
    // limit is what tells the agent not to try again.
    if (run.attempt - 1 >= maxReruns) return { status: "refused", reason: "rerun-limit" };
    if (run.status !== "completed") return { status: "refused", reason: "still-running" };
    return { status: "rerunnable", attempt: run.attempt };
  }

  async #runState(
    repository: string,
    runId: string,
    signal: AbortSignal,
  ): Promise<CiRunState | undefined> {
    if (!/^\d{1,20}$/.test(runId)) return undefined;
    const run = await this.#run(
      ["run", "view", runId, "--repo", repository, "--json", "headSha,attempt,status,jobs"],
      signal,
    );
    if (run === undefined || run.exitCode !== 0) return undefined;
    const value = parseJson(run.stdout);
    if (!isRecord(value) || typeof value.headSha !== "string") return undefined;
    const jobIds = new Set<string>();
    if (Array.isArray(value.jobs)) {
      for (const job of value.jobs) {
        if (isRecord(job) && typeof job.databaseId === "number") jobIds.add(String(job.databaseId));
      }
    }
    return {
      headSha: value.headSha,
      status: typeof value.status === "string" ? value.status : "",
      attempt: typeof value.attempt === "number" ? value.attempt : 1,
      jobIds,
    };
  }

  /**
   * The pull request's current head, refused when the number now names a
   * different pull request than the one linked: a link's node id is its
   * identity, and owner, name and number only find it.
   */
  async #openHead(
    request: GhPullRequestSwitchRequest,
    signal: AbortSignal,
    expectedPullRequestNodeId?: string,
  ): Promise<
    | { readonly status: "open"; readonly headSha: string; readonly pullRequestNodeId?: string }
    | { readonly status: "refused"; readonly reason: "not-open" | "pull-request-replaced" }
    | { readonly status: "unavailable" }
  > {
    const view = await this.#run(
      [
        "pr",
        "view",
        String(request.number),
        "--repo",
        `${request.owner}/${request.name}`,
        "--json",
        "id,state,headRefOid",
      ],
      signal,
    );
    if (view === undefined || view.exitCode !== 0) return { status: "unavailable" };
    const value = parseJson(view.stdout);
    if (!isRecord(value) || typeof value.headRefOid !== "string" || value.headRefOid === "") {
      return { status: "unavailable" };
    }
    const pullRequestNodeId =
      typeof value.id === "string" && /^[A-Za-z0-9+/=_-]{1,128}$/.test(value.id)
        ? value.id
        : undefined;
    if (
      expectedPullRequestNodeId !== undefined &&
      pullRequestNodeId !== undefined &&
      pullRequestNodeId !== expectedPullRequestNodeId
    ) {
      return { status: "refused", reason: "pull-request-replaced" };
    }
    if (normalizeState(value.state) !== "open") return { status: "refused", reason: "not-open" };
    return {
      status: "open",
      headSha: value.headRefOid,
      ...(pullRequestNodeId === undefined ? {} : { pullRequestNodeId }),
    };
  }

  /** Every check on the head, with the Actions run and job behind it when it has one. */
  async #ciChecks(
    request: GhPullRequestSwitchRequest,
    signal: AbortSignal,
  ): Promise<ReadonlyArray<CiCheck> | undefined> {
    const result = await this.#run(
      [
        "pr",
        "checks",
        String(request.number),
        "--repo",
        `${request.owner}/${request.name}`,
        "--json",
        "name,bucket,link",
      ],
      signal,
    );
    if (result === undefined) return undefined;
    const value = parseJson(result.stdout);
    // `gh pr checks` exits non-zero while a check fails or runs, so only
    // unreadable output is a failed read.
    if (!Array.isArray(value)) {
      return /no checks reported/i.test(`${result.stderr ?? ""}\n${result.stdout}`)
        ? []
        : undefined;
    }
    const checks: CiCheck[] = [];
    for (const entry of value) {
      if (!isRecord(entry) || typeof entry.name !== "string") continue;
      const name = checkName(entry.name);
      if (name === "") continue;
      const bucket = String(entry.bucket);
      if (!["pass", "pending", "fail", "cancel", "skipping"].includes(bucket)) continue;
      // Only a job in this repository's Actions is this pull request's to
      // read or rerun; any other link is treated as an outside service's.
      const ids =
        typeof entry.link === "string"
          ? /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/actions\/runs\/(\d+)\/job\/(\d+)(?:[/?#].*)?$/.exec(
              entry.link,
            )
          : null;
      const sameRepository =
        ids !== null &&
        ids[1]?.toLowerCase() === request.owner.toLowerCase() &&
        ids[2]?.toLowerCase() === request.name.toLowerCase();
      checks.push({
        name,
        bucket: bucket as CiCheck["bucket"],
        ...(sameRepository && ids?.[3] !== undefined ? { runId: ids[3] } : {}),
        ...(sameRepository && ids?.[4] !== undefined ? { jobId: ids[4] } : {}),
      });
    }
    return checks;
  }

  async #failedJobLog(
    repository: string,
    jobId: string,
    signal: AbortSignal,
  ): Promise<string | undefined> {
    const log = await this.#jobLog(repository, jobId, signal);
    return log.status === "log" ? tailBytes(log.text, this.#logBytes) : undefined;
  }

  /**
   * The failed steps' log of one job, and why there is none when there is
   * not. A cancelled job often has no failed step, so its whole log is read
   * when the failed steps' is empty.
   */
  async #jobLog(
    repository: string,
    jobId: string,
    signal: AbortSignal,
    cancelled = false,
  ): Promise<
    | { readonly status: "log"; readonly text: string }
    | { readonly status: "expired" | "unavailable" | "running" }
  > {
    const read = async (flag: "--log-failed" | "--log") => {
      const result = await this.#run(
        ["run", "view", "--repo", repository, "--job", jobId, flag],
        signal,
        CI_LOG_TAIL_BYTES,
      );
      if (result === undefined) return { status: "unavailable" } as const;
      if (result.exitCode !== 0) {
        const output = `${result.stderr ?? ""}\n${result.stdout}`;
        // gh gives no job's log until its whole workflow run has finished.
        if (/still in progress|logs will be available when it is complete/i.test(output)) {
          return { status: "running" } as const;
        }
        // GitHub answers 410 Gone once a log is past the repository's retention.
        return /HTTP 410|log not found|expired|no longer available/i.test(output)
          ? ({ status: "expired" } as const)
          : ({ status: "unavailable" } as const);
      }
      if (result.stdout.trim() === "") return { status: "unavailable" } as const;
      return { status: "log", text: result.stdout } as const;
    };
    const failed = await read("--log-failed");
    return cancelled && failed.status === "unavailable" ? read("--log") : failed;
  }

  async #run(arguments_: readonly string[], signal: AbortSignal, stdoutTailBytes?: number) {
    try {
      const result = await this.#command.run(
        arguments_,
        {
          environment: this.#environment,
          stdin: undefined,
          ...(stdoutTailBytes === undefined ? {} : { stdoutTailBytes }),
        },
        signal,
      );
      return result.timedOut === true ? undefined : result;
    } catch {
      return undefined;
    }
  }
}

function trustedFeedback(item: unknown): boolean {
  if (
    !isRecord(item) ||
    !isRecord(item.author) ||
    typeof item.author.login !== "string" ||
    !item.author.login.trim()
  )
    return false;
  return (
    item.author.__typename === "Bot" ||
    ["OWNER", "MEMBER", "COLLABORATOR"].includes(String(item.authorAssociation))
  );
}

function requestedApproval(requests: unknown): string | undefined {
  if (!Array.isArray(requests)) return undefined;
  const names = requests.filter(isRecord).flatMap((entry) => {
    const actor = entry.requestedReviewer;
    if (!isRecord(actor)) return [];
    const name = actor.login ?? actor.combinedSlug;
    return typeof name === "string" &&
      /^[a-zA-Z0-9_.-]{1,100}(?:\/[a-zA-Z0-9_.-]{1,100})?$/.test(name) &&
      name.length <= 120
      ? [{ name, owner: entry.asCodeOwner === true }]
      : [];
  });
  const owners = names.filter((entry) => entry.owner);
  const selected = owners.length ? owners : names;
  if (!selected.length) return undefined;
  return `Approval required · ${owners.length ? "Code owner review" : "Review"} requested from ${selected
    .slice(0, 3)
    .map(({ name }) => "@" + name)
    .join(", ")}`;
}

function reviewThreadFailure(
  node: unknown,
  babysitting: boolean,
): GhAutoFixFailureDetail | undefined {
  if (!isRecord(node) || typeof node.id !== "string" || node.id === "") return undefined;
  if (node.isResolved === true || node.isOutdated === true) return undefined;
  const comments = readPath(node, ["comments", "nodes"]);
  const entries = Array.isArray(comments) ? comments : [];
  const outsideReviewer = babysitting && !trustedFeedback(entries[0]);
  const lines = entries
    .filter(isRecord)
    .filter((comment) => !babysitting || trustedFeedback(comment))
    .map((comment) => {
      const author = readPath(comment, ["author", "login"]);
      const body = typeof comment.body === "string" ? comment.body : "";
      return `${typeof author === "string" ? author : "someone"}: ${clampBytes(body, MAX_COMMENT_BYTES)}`;
    });
  const where =
    typeof node.path === "string"
      ? `${node.path}${typeof node.line === "number" ? `:${node.line}` : ""}`
      : "the pull request";
  return {
    failure: { kind: "review-thread", key: node.id.slice(0, 512) },
    ...(outsideReviewer && { outsideReviewer: true as const }),
    detail: `On ${where}:\n${lines.join("\n")}`,
  };
}

function pullRequestActivity(
  pullRequest: Record<string, unknown>,
  discussion: Record<string, unknown>,
  conflicting: boolean,
): GhPullRequestActivity {
  let pending = false;
  const failedChecks: string[] = [];
  const rollup = Array.isArray(pullRequest.statusCheckRollup) ? pullRequest.statusCheckRollup : [];
  // A rollup entry is either a check run (status, then conclusion) or a
  // commit status (one state); both name what they report on the head.
  for (const entry of rollup.filter(isRecord)) {
    const name =
      typeof entry.name === "string"
        ? entry.name
        : typeof entry.context === "string"
          ? entry.context
          : "a check";
    if (entry.__typename === "StatusContext" || typeof entry.context === "string") {
      if (entry.state === "PENDING" || entry.state === "EXPECTED") pending = true;
      else if (entry.state !== "SUCCESS") failedChecks.push(name.slice(0, 512));
      continue;
    }
    if (entry.status !== "COMPLETED") pending = true;
    else if (
      typeof entry.conclusion !== "string" ||
      !PASSING_CHECK_CONCLUSIONS.has(entry.conclusion)
    ) {
      failedChecks.push(name.slice(0, 512));
    }
  }
  const checks =
    rollup.length === 0
      ? "none"
      : pending
        ? "pending"
        : failedChecks.length > 0
          ? "failed"
          : "passed";
  const reviewDecision =
    pullRequest.reviewDecision === "APPROVED"
      ? "approved"
      : pullRequest.reviewDecision === "CHANGES_REQUESTED"
        ? "changes-requested"
        : pullRequest.reviewDecision === "REVIEW_REQUIRED"
          ? "review-required"
          : undefined;
  const reviews = (Array.isArray(discussion.reviews) ? discussion.reviews : [])
    .filter(isRecord)
    .flatMap((review) =>
      // A pending review is the reviewer's unsent draft: nobody said it yet.
      typeof review.id !== "string" ||
      review.id === "" ||
      typeof review.submittedAt !== "string" ||
      review.state === "PENDING"
        ? []
        : [
            {
              id: review.id.slice(0, 512),
              ...(review.viewerDidAuthor === true ? { viewerDidAuthor: true as const } : {}),
              author: authorLogin(review),
              ...(trustedFeedback(review) && { trustedFeedback: true as const }),
              state:
                typeof review.state === "string"
                  ? review.state.toLowerCase().replaceAll("_", " ")
                  : "commented",
              at: review.submittedAt,
              body: clampBytes(
                typeof review.body === "string" ? review.body : "",
                MAX_COMMENT_BYTES,
              ),
            },
          ],
    )
    .slice(-MAX_ACTIVITY_ENTRIES);
  const comments = (Array.isArray(discussion.comments) ? discussion.comments : [])
    .filter(isRecord)
    .flatMap((comment) =>
      // The host's own login wrote it: the person, or the agent posting under
      // their name with their approval. Neither is news to the thread.
      typeof comment.id !== "string" ||
      comment.id === "" ||
      typeof comment.createdAt !== "string" ||
      comment.viewerDidAuthor === true
        ? []
        : [
            {
              id: comment.id.slice(0, 512),
              author: authorLogin(comment),
              ...(trustedFeedback(comment) && { trustedFeedback: true as const }),
              at: comment.createdAt,
              body: clampBytes(
                typeof comment.body === "string" ? comment.body : "",
                MAX_COMMENT_BYTES,
              ),
            },
          ],
    )
    .slice(-MAX_ACTIVITY_ENTRIES);
  const approval = requestedApproval(discussion.reviewRequests);
  return {
    checks,
    ...(approval && { requestedApproval: approval }),
    failedChecks,
    ...(reviewDecision === undefined ? {} : { reviewDecision }),
    conflicting,
    reviews,
    comments,
  };
}

function authorLogin(entry: Record<string, unknown>): string {
  const login = readPath(entry, ["author", "login"]);
  return typeof login === "string" && login !== "" ? login.slice(0, 128) : "someone";
}

// Older GitHub CLI releases provide check data through GraphQL but lack the
// structured output option on the checks command itself.
function lacksChecksJson(result: GhCommandResult): boolean {
  return result.exitCode !== 0 && /unknown flag: --json\b/.test(result.stderr ?? "");
}

function classifyFailure(result: GhCommandResult):
  | Readonly<{ status: "refused"; reason: "not-open" | "stale" | "failed" }>
  | Readonly<{ status: "unsupported"; reason: "auto-merge-not-allowed" }>
  | Readonly<{
      status: "unavailable";
      reason: "disconnected" | "unauthenticated" | "unavailable";
    }> {
  const diagnostic = `${result.stderr ?? ""}\n${result.stdout}`;
  if (/HTTP 401|bad credentials|authentication required|not logged in/i.test(diagnostic)) {
    return { status: "unavailable", reason: "unauthenticated" };
  }
  if (
    /Could not resolve host|no such host|connection refused|network is unreachable|TLS handshake|connection reset/i.test(
      diagnostic,
    )
  ) {
    return { status: "unavailable", reason: "disconnected" };
  }
  if (
    /auto[- ]?merge is not allowed|auto merge is not allowed|enablePullRequestAutoMerge/i.test(
      diagnostic,
    )
  ) {
    return { status: "unsupported", reason: "auto-merge-not-allowed" };
  }
  if (/expected head|head commit|not at the expected|head branch was modified/i.test(diagnostic)) {
    return { status: "refused", reason: "stale" };
  }
  if (/is closed|already merged|not open/i.test(diagnostic)) {
    return { status: "refused", reason: "not-open" };
  }
  return { status: "refused", reason: "failed" };
}

function normalizeState(value: unknown): "open" | "merged" | "closed" | undefined {
  if (value === "OPEN") return "open";
  if (value === "MERGED") return "merged";
  if (value === "CLOSED") return "closed";
  return undefined;
}

function validNumber(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function readPath(value: unknown, path: ReadonlyArray<string>): unknown {
  let current = value;
  for (const key of path) {
    if (!isRecord(current)) return undefined;
    current = current[key];
  }
  return current;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function clampBytes(value: string, maxBytes: number): string {
  const bytes = Buffer.from(value, "utf8");
  return bytes.byteLength <= maxBytes ? value : `${bytes.subarray(0, maxBytes).toString("utf8")}…`;
}

/**
 * A check's name as a single line: a job name is the repository's text, and
 * it is shown whole in a rerun approval, so line breaks, control and format
 * characters (bidirectional overrides among them) cannot reshape that prompt.
 */
function checkName(value: string): string {
  return value
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\s]+/gu, " ")
    .trim()
    .slice(0, 512);
}

/** One Actions run as `gh run view` reads it. */
interface CiRunState {
  readonly headSha: string;
  readonly status: string;
  readonly attempt: number;
  readonly jobIds: ReadonlySet<string>;
}

interface CiCheck {
  readonly name: string;
  readonly bucket: "pass" | "pending" | "fail" | "cancel" | "skipping";
  readonly runId?: string;
  readonly jobId?: string;
}

/** The last `lines` lines of a log, then at most `maxBytes` of their end. */
function tailLinesAndBytes(
  value: string,
  lines: number,
  maxBytes: number,
): { readonly text: string; readonly truncated: boolean } {
  const all = value.replace(/\n$/, "").split("\n");
  const kept = all.length > lines ? all.slice(all.length - lines).join("\n") : all.join("\n");
  const text = tailBytes(kept, maxBytes);
  return { text, truncated: all.length > lines || text !== kept };
}

/** The end of a log is where a failure is reported, so the tail is kept. */
function tailBytes(value: string, maxBytes: number): string {
  const bytes = Buffer.from(value, "utf8");
  return bytes.byteLength <= maxBytes
    ? value
    : `…${bytes.subarray(bytes.byteLength - maxBytes).toString("utf8")}`;
}

function repositoryFromPullRequestUrl(url: string): string | undefined {
  const match = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/\d+(?:\/.*)?$/.exec(url);
  if (match === null) return undefined;
  const full = `${match[1]}/${match[2]}`;
  return validRepository(full) ? full : undefined;
}

interface RequiredStatusCheck {
  readonly context: string;
  readonly appId?: number;
}

interface ObservedCommitCheck {
  readonly kind: "check-run" | "status-context";
  readonly databaseId?: number;
  readonly context: string;
  readonly appId?: number;
  readonly checkSuiteId?: string;
  readonly workflowId?: string;
  readonly isRequired?: boolean;
  readonly jobId?: string;
  readonly timestampMs?: number;
  readonly bucket: "pass" | "pending" | "failing";
}

const MAX_ROLLUP_PAGES = 20;

const ROLLUP_CONTEXT_NODES_SELECTION = `
  nodes {
    __typename
    ... on CheckRun {
      detailsUrl
      databaseId
      name
      status
      conclusion
      startedAt
      completedAt
      isRequired(pullRequestNumber: $number)
      checkSuite {
        id
        app { databaseId }
        workflowRun { workflow { id } }
      }
    }
    ... on StatusContext {
      context
      state
      createdAt
      isRequired(pullRequestNumber: $number)
    }
  }
  pageInfo { hasNextPage endCursor }
`;

const PR_COMMIT_ROLLUPS_QUERY = `
  query($owner: String!, $name: String!, $number: Int!) {
    repository(owner: $owner, name: $name) {
      pullRequest(number: $number) {
        commits(last: 1) {
          nodes {
            commit {
              oid
              statusCheckRollup {
                contexts(first: 100) {
                  ${ROLLUP_CONTEXT_NODES_SELECTION}
                }
              }
            }
          }
        }
        potentialMergeCommit {
          oid
          statusCheckRollup {
            contexts(first: 100) {
              ${ROLLUP_CONTEXT_NODES_SELECTION}
            }
          }
        }
      }
    }
  }
`;

const PR_HEAD_ROLLUP_PAGE_QUERY = `
  query($owner: String!, $name: String!, $number: Int!, $cursor: String) {
    repository(owner: $owner, name: $name) {
      pullRequest(number: $number) {
        commits(last: 1) {
          nodes {
            commit {
              oid
              statusCheckRollup {
                contexts(first: 100, after: $cursor) {
                  ${ROLLUP_CONTEXT_NODES_SELECTION}
                }
              }
            }
          }
        }
      }
    }
  }
`;

const PR_MERGE_ROLLUP_PAGE_QUERY = `
  query($owner: String!, $name: String!, $number: Int!, $cursor: String) {
    repository(owner: $owner, name: $name) {
      pullRequest(number: $number) {
        potentialMergeCommit {
          oid
          statusCheckRollup {
            contexts(first: 100, after: $cursor) {
              ${ROLLUP_CONTEXT_NODES_SELECTION}
            }
          }
        }
      }
    }
  }
`;

function parseRequiredCheckAppId(value: unknown): number | undefined | "invalid" {
  if (value === undefined || value === null || value === -1) return undefined;
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return value;
  return "invalid";
}

function parseTimestampMs(value: unknown): number | undefined {
  if (typeof value !== "string" || value.length === 0) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function parseCommitRollupPage(rollup: unknown):
  | "empty"
  | "invalid"
  | {
      readonly checks: ReadonlyArray<ObservedCommitCheck>;
      readonly hasNextPage: boolean;
      readonly endCursor?: string;
    } {
  if (rollup === null || rollup === undefined) return "empty";
  if (!isRecord(rollup) || !isRecord(rollup.contexts)) return "invalid";
  const nodes = rollup.contexts.nodes;
  const pageInfo = rollup.contexts.pageInfo;
  if (!Array.isArray(nodes) || !isRecord(pageInfo) || typeof pageInfo.hasNextPage !== "boolean") {
    return "invalid";
  }
  const checks: ObservedCommitCheck[] = [];
  for (const node of nodes) {
    if (!isRecord(node)) return "invalid";
    if (node.__typename === "CheckRun") {
      if (typeof node.name !== "string" || node.name.length === 0) return "invalid";
      const bucket = classifyCheckRun(node.status, node.conclusion);
      if (bucket === undefined) return "invalid";
      const databaseId =
        typeof node.databaseId === "number" &&
        Number.isSafeInteger(node.databaseId) &&
        node.databaseId > 0
          ? node.databaseId
          : undefined;
      const suite = isRecord(node.checkSuite) ? node.checkSuite : undefined;
      const checkSuiteId =
        typeof suite?.id === "string" && suite.id.length > 0 ? suite.id : undefined;
      const app = suite !== undefined && isRecord(suite.app) ? suite.app : undefined;
      const appId =
        typeof app?.databaseId === "number" &&
        Number.isSafeInteger(app.databaseId) &&
        app.databaseId > 0
          ? app.databaseId
          : undefined;
      const workflowRun =
        suite !== undefined && isRecord(suite.workflowRun) ? suite.workflowRun : undefined;
      const workflow =
        workflowRun !== undefined && isRecord(workflowRun.workflow)
          ? workflowRun.workflow
          : undefined;
      const workflowId =
        typeof workflow?.id === "string" && workflow.id.length > 0 ? workflow.id : undefined;
      const isRequired = typeof node.isRequired === "boolean" ? node.isRequired : undefined;
      const timestampMs = parseTimestampMs(node.completedAt) ?? parseTimestampMs(node.startedAt);
      const jobId =
        typeof node.detailsUrl === "string"
          ? /\/actions\/runs\/\d+\/job\/(\d+)/.exec(node.detailsUrl)?.[1]
          : undefined;
      checks.push({
        ...(jobId === undefined ? {} : { jobId }),
        kind: "check-run",
        context: node.name,
        bucket,
        ...(databaseId === undefined ? {} : { databaseId }),
        ...(appId === undefined ? {} : { appId }),
        ...(checkSuiteId === undefined ? {} : { checkSuiteId }),
        ...(workflowId === undefined ? {} : { workflowId }),
        ...(isRequired === undefined ? {} : { isRequired }),
        ...(timestampMs === undefined ? {} : { timestampMs }),
      });
      continue;
    }
    if (node.__typename === "StatusContext") {
      if (typeof node.context !== "string" || node.context.length === 0) return "invalid";
      const bucket = classifyStatusContext(node.state);
      if (bucket === undefined) return "invalid";
      const isRequired = typeof node.isRequired === "boolean" ? node.isRequired : undefined;
      const timestampMs = parseTimestampMs(node.createdAt);
      checks.push({
        kind: "status-context",
        context: node.context,
        bucket,
        ...(isRequired === undefined ? {} : { isRequired }),
        ...(timestampMs === undefined ? {} : { timestampMs }),
      });
      continue;
    }
    return "invalid";
  }
  const endCursor =
    typeof pageInfo.endCursor === "string" && pageInfo.endCursor.length > 0
      ? pageInfo.endCursor
      : undefined;
  return endCursor === undefined
    ? { checks, hasNextPage: pageInfo.hasNextPage }
    : { checks, hasNextPage: pageInfo.hasNextPage, endCursor };
}

function classifyCheckRun(
  status: unknown,
  conclusion: unknown,
): "pass" | "pending" | "failing" | undefined {
  if (typeof status !== "string") return undefined;
  const normalizedStatus = status.toUpperCase();
  if (normalizedStatus !== "COMPLETED") {
    return normalizedStatus === "QUEUED" ||
      normalizedStatus === "IN_PROGRESS" ||
      normalizedStatus === "WAITING" ||
      normalizedStatus === "PENDING" ||
      normalizedStatus === "REQUESTED"
      ? "pending"
      : undefined;
  }
  if (typeof conclusion !== "string") return undefined;
  const normalizedConclusion = conclusion.toUpperCase();
  if (
    normalizedConclusion === "SUCCESS" ||
    normalizedConclusion === "SKIPPED" ||
    normalizedConclusion === "NEUTRAL"
  ) {
    return "pass";
  }
  if (
    normalizedConclusion === "FAILURE" ||
    normalizedConclusion === "TIMED_OUT" ||
    normalizedConclusion === "CANCELLED" ||
    normalizedConclusion === "ACTION_REQUIRED" ||
    normalizedConclusion === "STALE" ||
    normalizedConclusion === "STARTUP_FAILURE"
  ) {
    return "failing";
  }
  return undefined;
}

function classifyStatusContext(state: unknown): "pass" | "pending" | "failing" | undefined {
  if (typeof state !== "string") return undefined;
  const normalized = state.toUpperCase();
  if (normalized === "SUCCESS") return "pass";
  if (normalized === "PENDING" || normalized === "EXPECTED") return "pending";
  if (normalized === "FAILURE" || normalized === "ERROR") return "failing";
  return undefined;
}

function commitCheckRecencyKey(entry: ObservedCommitCheck): number {
  if (entry.timestampMs !== undefined) return entry.timestampMs;
  // Undated pending or failing runs fail-closed and outrank any dated run
  // regardless of input order; an undated pass cannot claim to supersede a
  // dated run.
  return entry.bucket === "pass" ? Number.NEGATIVE_INFINITY : Number.POSITIVE_INFINITY;
}

function commitCheckBucketRank(bucket: ObservedCommitCheck["bucket"]): number {
  if (bucket === "pending") return 2;
  if (bucket === "failing") return 1;
  return 0;
}

function compareNumberKey(left: number, right: number): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function pickNewerCommitCheckById(
  existing: ObservedCommitCheck,
  candidate: ObservedCommitCheck,
): ObservedCommitCheck {
  const compare =
    compareNumberKey(existing.databaseId ?? -1, candidate.databaseId ?? -1) ||
    compareNumberKey(commitCheckRecencyKey(existing), commitCheckRecencyKey(candidate)) ||
    compareNumberKey(
      commitCheckBucketRank(existing.bucket),
      commitCheckBucketRank(candidate.bucket),
    );
  return compare < 0 ? candidate : existing;
}

function pickNewerCommitCheckByRecency(
  existing: ObservedCommitCheck,
  candidate: ObservedCommitCheck,
): ObservedCommitCheck {
  const compare =
    compareNumberKey(commitCheckRecencyKey(existing), commitCheckRecencyKey(candidate)) ||
    compareNumberKey(
      commitCheckBucketRank(existing.bucket),
      commitCheckBucketRank(candidate.bucket),
    );
  return compare < 0 ? candidate : existing;
}

function selectLatestCommitChecks(
  observed: ReadonlyArray<ObservedCommitCheck>,
): ReadonlyArray<ObservedCommitCheck> {
  const groupsByIdentity = new Map<string, ObservedCommitCheck[]>();
  for (let index = 0; index < observed.length; index += 1) {
    const entry = observed[index];
    if (entry === undefined) continue;
    let key: string;
    if (entry.kind === "status-context") {
      key = `status-context\0${entry.context}`;
    } else if (entry.workflowId !== undefined) {
      key = `check-run-workflow\0${entry.context}\0${entry.appId === undefined ? "*" : String(entry.appId)}\0${entry.workflowId}`;
    } else if (entry.checkSuiteId !== undefined) {
      key = `check-run-suite\0${entry.context}\0${entry.appId === undefined ? "*" : String(entry.appId)}\0${entry.checkSuiteId}`;
    } else {
      // Without a workflow id or check-suite id, keep runs distinct so
      // unrelated failing checks cannot be collapsed by another run.
      key = `check-run-unkeyed\0${String(index)}`;
    }
    const group = groupsByIdentity.get(key);
    if (group === undefined) {
      groupsByIdentity.set(key, [entry]);
    } else {
      group.push(entry);
    }
  }
  const latest: ObservedCommitCheck[] = [];
  for (const group of groupsByIdentity.values()) {
    let bestWithId: ObservedCommitCheck | undefined;
    let bestWithoutId: ObservedCommitCheck | undefined;
    for (const entry of group) {
      if (entry.databaseId !== undefined) {
        bestWithId = bestWithId === undefined ? entry : pickNewerCommitCheckById(bestWithId, entry);
      } else {
        bestWithoutId =
          bestWithoutId === undefined ? entry : pickNewerCommitCheckByRecency(bestWithoutId, entry);
      }
    }
    if (bestWithId !== undefined && bestWithoutId !== undefined) {
      latest.push(pickNewerCommitCheckByRecency(bestWithId, bestWithoutId));
    } else if (bestWithId !== undefined) {
      latest.push(bestWithId);
    } else if (bestWithoutId !== undefined) {
      latest.push(bestWithoutId);
    }
  }
  return latest;
}

function evaluateCommitRequiredChecks(
  required: ReadonlyArray<RequiredStatusCheck>,
  observed: ReadonlyArray<ObservedCommitCheck>,
): "green" | "pending" | "failing" {
  const latest = selectLatestCommitChecks(observed);
  const ruleCountByContext = new Map<string, number>();
  for (const requirement of required) {
    ruleCountByContext.set(
      requirement.context,
      (ruleCountByContext.get(requirement.context) ?? 0) + 1,
    );
  }
  let pending = false;
  for (const requirement of required) {
    // Only allow StatusContext.isRequired to satisfy an app-pinned rule when
    // no other rule (any-source or another app pin) shares the same context
    // name, so isRequired unambiguously attributes to this pinned app.
    const allowsRequiredStatusContext =
      requirement.appId !== undefined && (ruleCountByContext.get(requirement.context) ?? 0) === 1;
    const matches = latest.filter((entry) => {
      if (entry.context !== requirement.context) return false;
      if (requirement.appId === undefined) return true;
      if (entry.kind === "check-run") return entry.appId === requirement.appId;
      return allowsRequiredStatusContext && entry.isRequired === true;
    });
    if (matches.length === 0) {
      pending = true;
      continue;
    }
    if (matches.some((entry) => entry.bucket === "failing")) return "failing";
    if (matches.some((entry) => entry.bucket === "pending")) pending = true;
  }
  return pending ? "pending" : "green";
}
