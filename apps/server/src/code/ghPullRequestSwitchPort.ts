import {
  MAX_CODE_PROJECT_PULL_REQUEST_AUTO_FIX_FAILURES,
  type CodeProjectPullRequestAutoFixFailure,
  type CodeProjectPullRequestMergeMethod,
  type CodeProjectPullRequestMergeWait,
} from "@octant/contracts";
import {
  sanitizeGhEnvironment,
  validRepository,
  type GhCommandPort,
  type GhCommandResult,
} from "./ghPullRequestPort";

/** Failed checks whose log Auto-fix fetches on one observation. */
const MAX_LOGGED_CHECKS = 4;
const MAX_REVIEW_THREADS = 50;
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

export type GhPullRequestSwitchObservation =
  | Readonly<{
      status: "observed";
      state: "open" | "merged" | "closed";
      headSha: string;
      headBranch: string;
      baseBranch: string;
      autoMergeEnabled: boolean;
      waitingOn: ReadonlyArray<CodeProjectPullRequestMergeWait>;
      failures: ReadonlyArray<GhAutoFixFailureDetail>;
    }>
  | Readonly<{ status: "unavailable" }>;

const VIEW_FIELDS =
  "state,headRefOid,headRefName,baseRefName,mergeable,autoMergeRequest,reviewDecision";
const REVIEW_THREADS_QUERY = `query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){reviewThreads(first:${MAX_REVIEW_THREADS}){nodes{id isResolved isOutdated path line comments(first:10){nodes{author{login} body}}}}}}}`;

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
    },
    signal: AbortSignal,
  ): Promise<GhAutoMergeResult> {
    const repository = `${request.owner}/${request.name}`;
    if (!validRepository(repository) || !validNumber(request.number)) {
      return { status: "refused", reason: "failed" };
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
   * unresolved review threads with their comments, and a merge conflict.
   */
  async observe(
    request: GhPullRequestSwitchRequest,
    signal: AbortSignal,
  ): Promise<GhPullRequestSwitchObservation> {
    const repository = `${request.owner}/${request.name}`;
    if (!validRepository(repository) || !validNumber(request.number)) {
      return { status: "unavailable" };
    }
    const view = await this.#run(
      ["pr", "view", String(request.number), "--repo", repository, "--json", VIEW_FIELDS],
      signal,
    );
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
    const base = {
      status: "observed" as const,
      state,
      headSha,
      headBranch: typeof pullRequest.headRefName === "string" ? pullRequest.headRefName : "",
      baseBranch: typeof pullRequest.baseRefName === "string" ? pullRequest.baseRefName : "",
      autoMergeEnabled: isRecord(pullRequest.autoMergeRequest),
    };
    if (state !== "open") return { ...base, waitingOn: [], failures: [] };

    const checks = await this.#requiredChecks(repository, request.number, signal);
    if (checks === undefined) return { status: "unavailable" };
    const threads = await this.#unresolvedReviewThreads(request, signal);
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
    const waitingOn: CodeProjectPullRequestMergeWait[] = [];
    if (checks.pending || checks.failed.length > 0) waitingOn.push("checks");
    if (reviewsPending || threads.length > 0) waitingOn.push("reviews");
    if (conflicting) waitingOn.push("conflicts");
    return {
      ...base,
      waitingOn,
      failures: failures.slice(0, MAX_CODE_PROJECT_PULL_REQUEST_AUTO_FIX_FAILURES),
    };
  }

  async #requiredChecks(
    repository: string,
    number: number,
    signal: AbortSignal,
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
        String(number),
        "--repo",
        repository,
        "--required",
        "--json",
        "name,bucket,link",
      ],
      signal,
    );
    if (result === undefined) return undefined;
    // `gh pr checks` exits non-zero while a check is failing or pending, and
    // also when the repository requires none; only unreadable output is a
    // failed observation.
    const value = parseJson(result.stdout);
    if (!Array.isArray(value)) {
      return /no required checks|no checks reported/i.test(
        `${result.stderr ?? ""}\n${result.stdout}`,
      )
        ? { pending: false, failed: [] }
        : undefined;
    }
    const failed: Array<{ readonly name: string; readonly jobId?: string }> = [];
    let pending = false;
    for (const entry of value) {
      if (!isRecord(entry) || typeof entry.name !== "string" || entry.name.trim() === "") continue;
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
  ): Promise<ReadonlyArray<GhAutoFixFailureDetail> | undefined> {
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
      ],
      signal,
    );
    if (result === undefined || result.exitCode !== 0) return undefined;
    const nodes = readPath(parseJson(result.stdout), [
      "data",
      "repository",
      "pullRequest",
      "reviewThreads",
      "nodes",
    ]);
    if (!Array.isArray(nodes)) return undefined;
    const threads: GhAutoFixFailureDetail[] = [];
    for (const node of nodes) {
      if (!isRecord(node) || typeof node.id !== "string" || node.id === "") continue;
      if (node.isResolved === true || node.isOutdated === true) continue;
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
      threads.push({
        failure: { kind: "review-thread", key: node.id.slice(0, 512) },
        detail: `On ${where}:\n${lines.join("\n")}`,
      });
    }
    return threads;
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
