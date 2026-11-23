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
  readonly reviews: ReadonlyArray<{
    readonly viewerDidAuthor?: true;
    readonly id: string;
    readonly author: string;
    readonly state: string;
    readonly at: string;
    readonly body: string;
  }>;
  readonly comments: ReadonlyArray<{
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
const DISCUSSION_QUERY = `query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){reviews(last:${MAX_ACTIVITY_ENTRIES}){nodes{id author{login} state submittedAt body viewerDidAuthor}} comments(last:${MAX_ACTIVITY_ENTRIES}){nodes{id author{login} createdAt body viewerDidAuthor}}}}}`;
/**
 * Bodies are cut inside `gh`, before they reach stdout. jq slices by code
 * point, one past the byte clamp, so a body over the clamp still reaches
 * `clampBytes` long enough to be marked cut. Control characters are dropped
 * because `tojson` escapes each to six bytes; what is left costs at most four
 * bytes per code point, so 2 × 50 bodies stay near 820 KB, under the cap
 * however long the history is. (`tojson` is printed raw; gh's own encoder
 * would also escape `<`, `>` and `&` to six bytes.)
 */
const DISCUSSION_FILTER = `def cut: (.body // "")[0:${MAX_COMMENT_BYTES + 1}] | explode | map(select(. == 9 or . == 10 or . == 13 or (. > 31 and . != 127))) | implode; .data.repository.pullRequest | {reviews: [(.reviews.nodes // [])[] | .body = cut], comments: [(.comments.nodes // [])[] | .body = cut]} | tojson`;
const PASSING_CHECK_CONCLUSIONS = new Set(["SUCCESS", "NEUTRAL", "SKIPPED"]);
const REVIEW_THREADS_QUERY = `query($owner:String!,$name:String!,$number:Int!,$after:String){repository(owner:$owner,name:$name){pullRequest(number:$number){reviewThreads(first:${REVIEW_THREADS_PAGE},after:$after){pageInfo{hasNextPage endCursor} nodes{id isResolved isOutdated path line comments(first:10){nodes{author{login} body}}}}}}}`;

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
    failures.push(...threads);
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
      else babysitBlocker = "repository";
      const candidate =
        failures.length === 0 &&
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

  async #unresolvedReviewThreads(
    request: GhPullRequestSwitchRequest,
    signal: AbortSignal,
    verifyComplete: boolean,
  ): Promise<ReadonlyArray<GhAutoFixFailureDetail> | undefined> {
    const threads: GhAutoFixFailureDetail[] = [];
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
        const thread = reviewThreadFailure(node);
        if (thread !== undefined) threads.push(thread);
      }
      if (threads.length >= MAX_CODE_PROJECT_PULL_REQUEST_AUTO_FIX_FAILURES) break;
      const next = readPath(connection, ["pageInfo", "endCursor"]);
      const more = readPath(connection, ["pageInfo", "hasNextPage"]);
      if (
        verifyComplete &&
        threads.length === 0 &&
        (typeof more !== "boolean" ||
          (more && (typeof next !== "string" || page + 1 === MAX_REVIEW_THREAD_PAGES)))
      )
        return undefined;
      if (more !== true || typeof next !== "string") {
        break;
      }
      after = next;
    }
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

  async #failedJobLog(
    repository: string,
    jobId: string,
    signal: AbortSignal,
  ): Promise<string | undefined> {
    const result = await this.#run(
      ["run", "view", "--repo", repository, "--job", jobId, "--log-failed"],
      signal,
    );
    if (result === undefined || result.exitCode !== 0 || result.stdout.trim() === "") {
      return undefined;
    }
    return tailBytes(result.stdout, this.#logBytes);
  }

  async #run(arguments_: readonly string[], signal: AbortSignal) {
    try {
      const result = await this.#command.run(
        arguments_,
        { environment: this.#environment, stdin: undefined },
        signal,
      );
      return result.timedOut === true ? undefined : result;
    } catch {
      return undefined;
    }
  }
}

function reviewThreadFailure(node: unknown): GhAutoFixFailureDetail | undefined {
  if (!isRecord(node) || typeof node.id !== "string" || node.id === "") return undefined;
  if (node.isResolved === true || node.isOutdated === true) return undefined;
  const comments = readPath(node, ["comments", "nodes"]);
  const lines = (Array.isArray(comments) ? comments : []).filter(isRecord).map((comment) => {
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
              at: comment.createdAt,
              body: clampBytes(
                typeof comment.body === "string" ? comment.body : "",
                MAX_COMMENT_BYTES,
              ),
            },
          ],
    )
    .slice(-MAX_ACTIVITY_ENTRIES);
  return {
    checks,
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
