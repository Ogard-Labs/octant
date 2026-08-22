import { spawn } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import type { CodeThreadId } from "@octant/contracts";
import { decidePullRequestMergeability } from "@octant/domain/pull-request-mergeability-policy";

const MAX_GH_OUTPUT_BYTES = 1_048_576;
const MAX_TITLE_BYTES = 512;
const MAX_BODY_BYTES = 1_048_576;
const DEFAULT_GH_TIMEOUT_MS = 30_000;
const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const BRANCH_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;

export interface GhCommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr?: string;
  readonly timedOut?: boolean;
}

export interface GhCommandOptions {
  readonly environment: NodeJS.ProcessEnv;
  readonly stdin: string | undefined;
}

export interface GhCommandPort {
  run(
    arguments_: readonly string[],
    options: GhCommandOptions,
    signal: AbortSignal,
  ): Promise<GhCommandResult>;
}

export interface GhPullRequestRequest {
  readonly threadId: CodeThreadId;
  readonly title: string;
  readonly body: string;
}

export interface GhDeliveryTarget {
  readonly authorization: "confirmed-delivery-target";
  readonly baseRepository: string;
  readonly baseBranch: string;
  readonly head: string;
}

export interface GhPullRequestIdentity {
  readonly number: number;
  readonly url: string;
  readonly state: "open";
  readonly baseRepository: string;
  readonly baseBranch: string;
  readonly headOwner: string;
  readonly headBranch: string;
}

export type GhPullRequestResult =
  | Readonly<{
      status: "existing" | "created";
      pullRequest: GhPullRequestIdentity;
    }>
  | Readonly<{
      status: "unavailable";
      code: "invalid-target" | "pr-observation-unavailable" | "pr-create-unavailable";
    }>;

export type GhPullRequestReviewSection =
  | "description"
  | "commits"
  | "files"
  | "diff"
  | "checks"
  | "reviews"
  | "comments";

export type GhPullRequestReviewResult =
  | Readonly<{
      status: "observed";
      freshness: "fresh" | "stale";
      ambiguous: boolean;
      staleSections: readonly GhPullRequestReviewSection[];
      pullRequest: Readonly<{
        number: number;
        url: string;
        title: string;
        state: "open" | "merged" | "closed" | "draft";
        baseRepository: string;
        baseBranch: string;
        headRepository: string;
        headBranch: string;
        author: string;
        matchesDeliveryBranch: boolean;
      }>;
      description: string;
      diff: string;
      diffTruncated: boolean;
      commits: readonly Readonly<{ oid: string; messageHeadline: string; author: string }>[];
      files: readonly Readonly<{ path: string; additions: number; deletions: number }>[];
      checks: readonly Readonly<{
        name: string;
        state: "success" | "failure" | "pending" | "neutral" | "unknown";
      }>[];
      reviews: readonly Readonly<{
        author: string;
        state: "approved" | "changes-requested" | "commented" | "dismissed" | "pending" | "unknown";
        body: string;
      }>[];
      comments: readonly Readonly<{ author: string; body: string }>[];
      mergePreview?: Readonly<{
        headSha: string;
        mergeable: boolean | null;
        requiredChecksPassing: boolean;
        advertisedMergeMethods: readonly ("merge" | "squash" | "rebase")[];
      }>;
    }>
  | Readonly<{ status: "none" }>
  | Readonly<{ status: "unavailable" }>;

export type GhPullRequestMergeMethod = "merge" | "squash" | "rebase";

export type GhPullRequestMergeFailureCode =
  | "conflict"
  | "checks"
  | "auth"
  | "not-found"
  | "sha-mismatch"
  | "dirty"
  | "not-mergeable";

export interface GhPullRequestMergeRequest {
  readonly threadId: CodeThreadId;
  readonly expectedHeadSha: string;
  readonly mergeMethod: GhPullRequestMergeMethod;
  readonly confirmation: Readonly<{
    number: number;
    baseRepository: string;
    baseBranch: string;
    headBranch: string;
    mergeMethod: GhPullRequestMergeMethod;
    expectedHeadSha: string;
  }>;
}

export interface GhActivePullRequestRow {
  readonly number: number;
  readonly title: string;
  readonly draft: boolean;
  readonly author: string;
  readonly baseBranch: string;
  readonly headBranch: string;
  readonly updatedAt: string;
  readonly url: string;
  readonly checks: "unknown" | "pending" | "passing" | "failing";
  readonly review: "unknown" | "none" | "pending" | "approved" | "changes-requested";
}

export type GhActivePullRequestListResult =
  | { readonly status: "ok"; readonly rows: ReadonlyArray<GhActivePullRequestRow> }
  | {
      readonly status: "rate-limited";
      readonly retryAfterSeconds?: number;
    }
  | { readonly status: "timeout" }
  | { readonly status: "malformed" }
  | { readonly status: "disconnected" }
  | { readonly status: "unauthorized" };

const ACTIVE_PR_LIST_FIELDS = [
  "number",
  "title",
  "isDraft",
  "author",
  "updatedAt",
  "url",
  "baseRefName",
  "headRefName",
  "statusCheckRollup",
  "reviewDecision",
].join(",");

export type GhPullRequestMergeResult =
  | Readonly<{
      status: "merged";
      pullRequest: Readonly<{
        number: number;
        url: string;
        baseRepository: string;
        baseBranch: string;
        headOwner: string;
        headBranch: string;
      }>;
    }>
  | Readonly<{
      status: "unavailable" | "failed";
      code?: GhPullRequestMergeFailureCode;
    }>;

const MAX_PR_REVIEW_ITEMS = 500;
const MAX_PR_DESCRIPTION_BYTES = 256 * 1024;
const PR_VIEW_FIELDS = [
  "number",
  "title",
  "state",
  "isDraft",
  "body",
  "author",
  "baseRefName",
  "headRefName",
  "headRefOid",
  "mergeable",
  "mergeStateStatus",
  "url",
  "commits",
  "files",
  "statusCheckRollup",
  "reviews",
  "comments",
].join(",");
const PR_MERGE_VIEW_FIELDS = [
  "number",
  "url",
  "title",
  "state",
  "isDraft",
  "baseRefName",
  "headRefName",
  "headRefOid",
  "mergeable",
  "mergeStateStatus",
  "headRepositoryOwner",
].join(",");

export class GhPullRequestPort {
  readonly #command: GhCommandPort;
  readonly #resolveTarget: (threadId: CodeThreadId) => Promise<GhDeliveryTarget | undefined>;
  readonly #environment: NodeJS.ProcessEnv;

  constructor(options: {
    readonly command: GhCommandPort;
    readonly resolveTarget: (threadId: CodeThreadId) => Promise<GhDeliveryTarget | undefined>;
    readonly inheritedEnvironment?: NodeJS.ProcessEnv;
  }) {
    this.#command = options.command;
    this.#resolveTarget = options.resolveTarget;
    this.#environment = sanitizeGhEnvironment(options.inheritedEnvironment ?? process.env);
  }

  async ensure(request: GhPullRequestRequest, signal: AbortSignal): Promise<GhPullRequestResult> {
    if (!validText(request.title, MAX_TITLE_BYTES) || !validBody(request.body)) {
      return { status: "unavailable", code: "invalid-target" };
    }
    let deliveryTarget: GhDeliveryTarget | undefined;
    try {
      deliveryTarget = await this.#resolveTarget(request.threadId);
    } catch {
      return { status: "unavailable", code: "invalid-target" };
    }
    const target = validateTarget(deliveryTarget);
    if (deliveryTarget === undefined || target === undefined) {
      return { status: "unavailable", code: "invalid-target" };
    }

    const before = await this.#observe(deliveryTarget, target, signal);
    if (before.status === "unavailable") return before;
    if (before.pullRequest !== undefined) {
      return { status: "existing", pullRequest: before.pullRequest };
    }

    let createExitCode = 1;
    try {
      const created = await this.#command.run(
        [
          "pr",
          "create",
          "--repo",
          deliveryTarget.baseRepository,
          "--base",
          deliveryTarget.baseBranch,
          "--head",
          deliveryTarget.head,
          "--title",
          request.title,
          "--body-file",
          "-",
        ],
        { environment: this.#environment, stdin: request.body },
        signal,
      );
      createExitCode = created.exitCode;
    } catch {
      // Creation may have reached GitHub before the local command failed. Re-observe exactly once.
    }
    const after = await this.#observe(deliveryTarget, target, signal);
    if (after.status === "unavailable") return after;
    if (after.pullRequest === undefined) {
      return { status: "unavailable", code: "pr-create-unavailable" };
    }
    return {
      status: createExitCode === 0 ? "created" : "existing",
      pullRequest: after.pullRequest,
    };
  }

  /**
   * Observe every read-only section of the pull request linked to the thread's
   * delivery branch: description, commits, changed files, diff, checks, reviews,
   * and comments. This never mutates GitHub. Any section GitHub could not
   * refresh is reported in `staleSections` and makes the observation `ambiguous`
   * so the review window shows `Waiting` instead of a settled result.
   */
  async observeReview(
    request: { readonly threadId: CodeThreadId; readonly maxDiffBytes: number },
    signal: AbortSignal,
  ): Promise<GhPullRequestReviewResult> {
    let deliveryTarget: GhDeliveryTarget | undefined;
    try {
      deliveryTarget = await this.#resolveTarget(request.threadId);
    } catch {
      return { status: "unavailable" };
    }
    const target = validateTarget(deliveryTarget);
    if (deliveryTarget === undefined || target === undefined) return { status: "unavailable" };

    const observed = await this.#observe(deliveryTarget, target, signal);
    if (observed.status === "unavailable") return { status: "unavailable" };
    if (observed.pullRequest === undefined) return { status: "none" };
    const identity = observed.pullRequest;

    const staleSections: GhPullRequestReviewSection[] = [];
    const detail = await this.#viewReviewDetail(
      deliveryTarget.baseRepository,
      identity.number,
      signal,
    );
    const diff = await this.#reviewDiff(
      deliveryTarget.baseRepository,
      identity.number,
      request.maxDiffBytes,
      signal,
    );

    if (detail === undefined) {
      staleSections.push("description", "commits", "files", "checks", "reviews", "comments");
    }
    if (diff === undefined) staleSections.push("diff");

    const advertisedMergeMethods =
      detail === undefined
        ? undefined
        : await this.#advertisedMergeMethods(deliveryTarget.baseRepository, signal);
    const mergePreview =
      detail?.mergePreview === undefined || advertisedMergeMethods === undefined
        ? undefined
        : {
            ...detail.mergePreview,
            advertisedMergeMethods,
          };

    return {
      status: "observed",
      freshness: staleSections.length === 0 ? "fresh" : "stale",
      ambiguous: staleSections.length > 0,
      staleSections,
      pullRequest: {
        number: identity.number,
        url: identity.url,
        title: detail?.title ?? "",
        state: detail?.state ?? "open",
        baseRepository: identity.baseRepository,
        baseBranch: identity.baseBranch,
        headRepository: identity.headOwner,
        headBranch: identity.headBranch,
        author: detail?.author ?? "",
        matchesDeliveryBranch: true,
      },
      description: detail?.description ?? "",
      diff: diff?.text ?? "",
      diffTruncated: diff?.truncated ?? false,
      commits: detail?.commits ?? [],
      files: detail?.files ?? [],
      checks: detail?.checks ?? [],
      reviews: detail?.reviews ?? [],
      comments: detail?.comments ?? [],
      ...(mergePreview === undefined ? {} : { mergePreview }),
    };
  }

  /**
   * List open and draft pull requests for one server-resolved github.com
   * repository. This never mutates GitHub.
   */
  async listActive(
    request: {
      readonly owner: string;
      readonly name: string;
      readonly limit: number;
    },
    signal: AbortSignal,
  ): Promise<GhActivePullRequestListResult> {
    const repository = `${request.owner}/${request.name}`;
    if (
      !validRepository(repository) ||
      !Number.isSafeInteger(request.limit) ||
      request.limit < 1 ||
      request.limit > 101
    ) {
      return { status: "malformed" };
    }
    let result: GhCommandResult;
    try {
      result = await this.#command.run(
        [
          "pr",
          "list",
          "--repo",
          repository,
          "--state",
          "open",
          "--limit",
          String(request.limit),
          "--json",
          ACTIVE_PR_LIST_FIELDS,
        ],
        { environment: this.#environment, stdin: undefined },
        signal,
      );
    } catch {
      return { status: "disconnected" };
    }
    if (result.timedOut === true) return { status: "timeout" };
    if (result.exitCode !== 0) return classifyActiveListFailure(result);
    const rows = decodeActivePullRequests(result.stdout);
    return rows === undefined ? { status: "malformed" } : { status: "ok", rows };
  }

  /**
   * Clean-merge the delivery-branch PR when host mergeability facts allow it.
   * Never force, never admin-bypass, never merge with a mismatched head SHA.
   */
  async merge(
    request: GhPullRequestMergeRequest,
    signal: AbortSignal,
  ): Promise<GhPullRequestMergeResult> {
    if (
      request.confirmation.mergeMethod !== request.mergeMethod ||
      request.confirmation.expectedHeadSha !== request.expectedHeadSha
    ) {
      return { status: "failed", code: "dirty" };
    }

    let deliveryTarget: GhDeliveryTarget | undefined;
    try {
      deliveryTarget = await this.#resolveTarget(request.threadId);
    } catch {
      return { status: "unavailable", code: "not-found" };
    }
    const target = validateTarget(deliveryTarget);
    if (deliveryTarget === undefined || target === undefined) {
      return { status: "unavailable", code: "not-found" };
    }
    if (
      deliveryTarget.baseRepository !== request.confirmation.baseRepository ||
      deliveryTarget.baseBranch !== request.confirmation.baseBranch ||
      target.headBranch !== request.confirmation.headBranch
    ) {
      return { status: "failed", code: "not-found" };
    }

    const observed = await this.#observe(deliveryTarget, target, signal);
    if (observed.status === "unavailable") {
      return { status: "unavailable", code: "not-found" };
    }
    if (
      observed.pullRequest === undefined ||
      observed.pullRequest.number !== request.confirmation.number
    ) {
      // Idempotent success: confirmation may already be merged.
      const merged = await this.#viewMergeDetail(
        deliveryTarget.baseRepository,
        request.confirmation.number,
        signal,
      );
      if (
        merged !== undefined &&
        merged.state === "merged" &&
        merged.baseRefName === request.confirmation.baseBranch &&
        merged.headRefName === request.confirmation.headBranch
      ) {
        return {
          status: "merged",
          pullRequest: {
            number: merged.number,
            url: merged.url,
            baseRepository: deliveryTarget.baseRepository,
            baseBranch: deliveryTarget.baseBranch,
            headOwner: target.headOwner,
            headBranch: target.headBranch,
          },
        };
      }
      return { status: "failed", code: "not-found" };
    }

    const identity = observed.pullRequest;
    const detail = await this.#viewMergeDetail(
      deliveryTarget.baseRepository,
      identity.number,
      signal,
    );
    if (detail === undefined) return { status: "unavailable", code: "not-found" };

    const advertisedMergeMethods = await this.#advertisedMergeMethods(
      deliveryTarget.baseRepository,
      signal,
    );
    if (advertisedMergeMethods === undefined) {
      return { status: "unavailable", code: "not-mergeable" };
    }

    const decision = decidePullRequestMergeability({
      state: detail.state,
      mergeable: detail.mergeable,
      headSha: detail.headSha,
      expectedHeadSha: request.expectedHeadSha,
      requiredChecksPassing: detail.requiredChecksPassing,
      mergeMethod: request.mergeMethod,
      advertisedMergeMethods,
    });
    if (decision.decision === "deny") {
      return { status: "failed", code: mapMergeDenyCode(decision.code) };
    }

    const methodFlag =
      request.mergeMethod === "squash"
        ? "--squash"
        : request.mergeMethod === "rebase"
          ? "--rebase"
          : "--merge";
    let mergeExitCode = 1;
    try {
      const merged = await this.#command.run(
        [
          "pr",
          "merge",
          String(identity.number),
          "--repo",
          deliveryTarget.baseRepository,
          methodFlag,
          "--match-head-commit",
          request.expectedHeadSha,
        ],
        { environment: this.#environment, stdin: undefined },
        signal,
      );
      mergeExitCode = merged.exitCode;
    } catch {
      // Re-observe once — merge may have landed before the local command failed.
    }

    const after = await this.#viewMergeDetail(
      deliveryTarget.baseRepository,
      identity.number,
      signal,
    );
    if (after?.state === "merged") {
      return {
        status: "merged",
        pullRequest: {
          number: identity.number,
          url: after.url || identity.url,
          baseRepository: identity.baseRepository,
          baseBranch: identity.baseBranch,
          headOwner: identity.headOwner,
          headBranch: identity.headBranch,
        },
      };
    }
    if (mergeExitCode !== 0) {
      return { status: "failed", code: "auth" };
    }
    return { status: "failed", code: "not-mergeable" };
  }

  async #advertisedMergeMethods(
    baseRepository: string,
    signal: AbortSignal,
  ): Promise<readonly GhPullRequestMergeMethod[] | undefined> {
    let result: GhCommandResult;
    try {
      result = await this.#command.run(
        [
          "api",
          `repos/${baseRepository}`,
          "--jq",
          "{allow_merge_commit,allow_squash_merge,allow_rebase_merge}",
        ],
        { environment: this.#environment, stdin: undefined },
        signal,
      );
    } catch {
      return undefined;
    }
    if (result.exitCode !== 0) return undefined;
    return decodeAdvertisedMergeMethods(result.stdout);
  }

  async #viewMergeDetail(
    baseRepository: string,
    number: number,
    signal: AbortSignal,
  ): Promise<GhPullRequestMergeDetail | undefined> {
    let result: GhCommandResult;
    try {
      result = await this.#command.run(
        ["pr", "view", String(number), "--repo", baseRepository, "--json", PR_MERGE_VIEW_FIELDS],
        { environment: this.#environment, stdin: undefined },
        signal,
      );
    } catch {
      return undefined;
    }
    if (result.exitCode !== 0) return undefined;
    return decodeMergeDetail(result.stdout);
  }

  async #viewReviewDetail(
    baseRepository: string,
    number: number,
    signal: AbortSignal,
  ): Promise<GhPullRequestReviewDetail | undefined> {
    let result: GhCommandResult;
    try {
      result = await this.#command.run(
        ["pr", "view", String(number), "--repo", baseRepository, "--json", PR_VIEW_FIELDS],
        { environment: this.#environment, stdin: undefined },
        signal,
      );
    } catch {
      return undefined;
    }
    if (result.exitCode !== 0) return undefined;
    return decodeReviewDetail(result.stdout);
  }

  async #reviewDiff(
    baseRepository: string,
    number: number,
    maxDiffBytes: number,
    signal: AbortSignal,
  ): Promise<{ readonly text: string; readonly truncated: boolean } | undefined> {
    let result: GhCommandResult;
    try {
      result = await this.#command.run(
        ["pr", "diff", String(number), "--repo", baseRepository],
        { environment: this.#environment, stdin: undefined },
        signal,
      );
    } catch {
      return undefined;
    }
    if (result.exitCode !== 0) return undefined;
    const bytes = Buffer.from(result.stdout, "utf8");
    if (bytes.byteLength <= maxDiffBytes) return { text: result.stdout, truncated: false };
    const truncated = bytes.subarray(0, maxDiffBytes).toString("utf8");
    return { text: truncated, truncated: true };
  }

  async #observe(
    request: GhDeliveryTarget,
    target: Readonly<{ headOwner: string; headBranch: string }>,
    signal: AbortSignal,
  ): Promise<
    | Readonly<{ status: "observed"; pullRequest: GhPullRequestIdentity | undefined }>
    | Readonly<{ status: "unavailable"; code: "pr-observation-unavailable" }>
  > {
    let result: GhCommandResult;
    try {
      result = await this.#command.run(
        [
          "pr",
          "list",
          "--repo",
          request.baseRepository,
          "--base",
          request.baseBranch,
          "--head",
          request.head,
          "--state",
          "open",
          "--limit",
          "2",
          "--json",
          "number,url,state,baseRefName,headRefName,headRepositoryOwner",
        ],
        { environment: this.#environment, stdin: undefined },
        signal,
      );
    } catch {
      return { status: "unavailable", code: "pr-observation-unavailable" };
    }
    if (result.exitCode !== 0) {
      return { status: "unavailable", code: "pr-observation-unavailable" };
    }
    const decoded = decodePullRequests(result.stdout, request, target);
    return decoded === undefined
      ? { status: "unavailable", code: "pr-observation-unavailable" }
      : { status: "observed", pullRequest: decoded ?? undefined };
  }
}

export function createGhCommandPort(options: {
  readonly ghPath: string;
  readonly outputLimitBytes?: number;
  readonly timeoutMs?: number;
}): GhCommandPort {
  if (!isAbsolute(options.ghPath)) throw new Error("gh path must be absolute");
  const metadata = statSync(options.ghPath);
  accessSync(options.ghPath, constants.X_OK);
  if (!metadata.isFile()) throw new Error("gh path must be executable");
  const limit = options.outputLimitBytes ?? MAX_GH_OUTPUT_BYTES;
  const timeoutMs = options.timeoutMs ?? DEFAULT_GH_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 300_000) {
    throw new Error("gh timeout is invalid");
  }
  return {
    run: (arguments_, commandOptions, signal) =>
      runGh(options.ghPath, arguments_, commandOptions, signal, limit, timeoutMs),
  };
}

function validateTarget(
  request: GhDeliveryTarget | undefined,
): Readonly<{ headOwner: string; headBranch: string }> | undefined {
  if (request === undefined || request.authorization !== "confirmed-delivery-target") {
    return undefined;
  }
  if (!validRepository(request.baseRepository) || !validBranch(request.baseBranch)) {
    return undefined;
  }
  const separator = request.head.indexOf(":");
  if (separator <= 0 || separator !== request.head.lastIndexOf(":")) return undefined;
  const headOwner = request.head.slice(0, separator);
  const headBranch = request.head.slice(separator + 1);
  return /^[A-Za-z0-9_.-]+$/.test(headOwner) && validBranch(headBranch)
    ? { headOwner, headBranch }
    : undefined;
}

function validRepository(value: string): boolean {
  return REPOSITORY_PATTERN.test(value) && !value.includes("..") && !value.includes("//");
}

function validBranch(value: string): boolean {
  return (
    value.length <= 255 &&
    BRANCH_PATTERN.test(value) &&
    !value.includes("..") &&
    !value.includes("@{") &&
    !value.includes("//") &&
    !value.endsWith("/") &&
    !value.endsWith(".") &&
    !value.endsWith(".lock")
  );
}

function validText(value: string, maximumBytes: number): boolean {
  return (
    !value.includes("\0") &&
    value.trim() === value &&
    value.length > 0 &&
    Buffer.byteLength(value) <= maximumBytes
  );
}

function validBody(value: string): boolean {
  return !value.includes("\0") && Buffer.byteLength(value) <= MAX_BODY_BYTES;
}

function sanitizeGhEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const sanitized = { ...environment };
  delete sanitized.GH_TOKEN;
  delete sanitized.GITHUB_TOKEN;
  delete sanitized.GH_ENTERPRISE_TOKEN;
  delete sanitized.GIT_ASKPASS;
  delete sanitized.SSH_ASKPASS;
  sanitized.GIT_TERMINAL_PROMPT = "0";
  sanitized.GH_PROMPT_DISABLED = "1";
  sanitized.NO_COLOR = "1";
  return sanitized;
}

function decodePullRequests(
  output: string,
  request: GhDeliveryTarget,
  target: Readonly<{ headOwner: string; headBranch: string }>,
): GhPullRequestIdentity | undefined | null {
  let value: unknown;
  try {
    value = JSON.parse(output);
  } catch {
    return undefined;
  }
  if (!Array.isArray(value) || value.length > 1) return undefined;
  if (value.length === 0) return null;
  const item = value[0];
  if (
    !isRecord(item) ||
    !exactKeys(item, [
      "number",
      "url",
      "state",
      "baseRefName",
      "headRefName",
      "headRepositoryOwner",
    ])
  )
    return undefined;
  const owner = item.headRepositoryOwner;
  if (
    !Number.isSafeInteger(item.number) ||
    (item.number as number) <= 0 ||
    typeof item.url !== "string" ||
    !item.url.startsWith("https://") ||
    item.state !== "OPEN" ||
    item.baseRefName !== request.baseBranch ||
    item.headRefName !== target.headBranch ||
    !isRecord(owner) ||
    !exactKeys(owner, ["login"]) ||
    owner.login !== target.headOwner
  ) {
    return undefined;
  }
  return {
    number: item.number as number,
    url: item.url,
    state: "open",
    baseRepository: request.baseRepository,
    baseBranch: request.baseBranch,
    headOwner: target.headOwner,
    headBranch: target.headBranch,
  };
}

interface GhPullRequestReviewDetail {
  readonly title: string;
  readonly state: "open" | "merged" | "closed" | "draft";
  readonly author: string;
  readonly description: string;
  readonly commits: readonly Readonly<{ oid: string; messageHeadline: string; author: string }>[];
  readonly files: readonly Readonly<{ path: string; additions: number; deletions: number }>[];
  readonly checks: readonly Readonly<{
    name: string;
    state: "success" | "failure" | "pending" | "neutral" | "unknown";
  }>[];
  readonly reviews: readonly Readonly<{
    author: string;
    state: "approved" | "changes-requested" | "commented" | "dismissed" | "pending" | "unknown";
    body: string;
  }>[];
  readonly comments: readonly Readonly<{ author: string; body: string }>[];
  readonly mergePreview?: Readonly<{
    headSha: string;
    mergeable: boolean | null;
    requiredChecksPassing: boolean;
  }>;
}

interface GhPullRequestMergeDetail {
  readonly number: number;
  readonly url: string;
  readonly state: "open" | "merged" | "closed" | "draft";
  readonly baseRefName: string;
  readonly headRefName: string;
  readonly headSha: string;
  readonly mergeable: boolean | null;
  readonly requiredChecksPassing: boolean;
}

function decodeReviewDetail(output: string): GhPullRequestReviewDetail | undefined {
  let value: unknown;
  try {
    value = JSON.parse(output);
  } catch {
    return undefined;
  }
  if (!isRecord(value)) return undefined;
  const isDraft = value.isDraft === true;
  const rawState = typeof value.state === "string" ? value.state.toUpperCase() : "";
  const state: GhPullRequestReviewDetail["state"] = isDraft
    ? "draft"
    : rawState === "MERGED"
      ? "merged"
      : rawState === "CLOSED"
        ? "closed"
        : "open";
  const mergePreview = decodeMergePreviewFacts(value);
  return {
    title: clampBytes(value.title, 1_024),
    state,
    author: loginOf(value.author),
    description: clampBytes(value.body, MAX_PR_DESCRIPTION_BYTES),
    commits: decodeCommits(value.commits),
    files: decodeFiles(value.files),
    checks: decodeChecks(value.statusCheckRollup),
    reviews: decodeReviews(value.reviews),
    comments: decodeComments(value.comments),
    ...(mergePreview === undefined ? {} : { mergePreview }),
  };
}

function decodeMergeDetail(output: string): GhPullRequestMergeDetail | undefined {
  let value: unknown;
  try {
    value = JSON.parse(output);
  } catch {
    return undefined;
  }
  if (!isRecord(value)) return undefined;
  const number =
    typeof value.number === "number" && Number.isSafeInteger(value.number) ? value.number : 0;
  const url = typeof value.url === "string" && value.url.startsWith("https://") ? value.url : "";
  const baseRefName = typeof value.baseRefName === "string" ? value.baseRefName : "";
  const headRefName = typeof value.headRefName === "string" ? value.headRefName : "";
  if (number <= 0 || url === "" || baseRefName === "" || headRefName === "") return undefined;
  const isDraft = value.isDraft === true;
  const rawState = typeof value.state === "string" ? value.state.toUpperCase() : "";
  const state: GhPullRequestMergeDetail["state"] = isDraft
    ? "draft"
    : rawState === "MERGED"
      ? "merged"
      : rawState === "CLOSED"
        ? "closed"
        : "open";
  const facts = decodeMergePreviewFacts(value);
  if (facts === undefined) return undefined;
  return {
    number,
    url,
    state,
    baseRefName,
    headRefName,
    headSha: facts.headSha,
    mergeable: facts.mergeable,
    requiredChecksPassing: facts.requiredChecksPassing,
  };
}

function decodeMergePreviewFacts(value: Record<string, unknown>):
  | Readonly<{
      headSha: string;
      mergeable: boolean | null;
      requiredChecksPassing: boolean;
    }>
  | undefined {
  const headSha = typeof value.headRefOid === "string" ? value.headRefOid.trim() : "";
  if (!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(headSha)) return undefined;
  const mergeable = decodeMergeable(value.mergeable);
  const mergeStateStatus =
    typeof value.mergeStateStatus === "string" ? value.mergeStateStatus.toUpperCase() : "";
  return {
    headSha,
    mergeable,
    requiredChecksPassing: mergeStateStatus === "CLEAN",
  };
}

function decodeMergeable(value: unknown): boolean | null {
  if (typeof value === "boolean") return value;
  if (typeof value !== "string") return null;
  const normalized = value.toUpperCase();
  if (normalized === "MERGEABLE") return true;
  if (normalized === "CONFLICTING") return false;
  return null;
}

function decodeAdvertisedMergeMethods(
  output: string,
): readonly GhPullRequestMergeMethod[] | undefined {
  let value: unknown;
  try {
    value = JSON.parse(output);
  } catch {
    return undefined;
  }
  if (!isRecord(value)) return undefined;
  const methods: GhPullRequestMergeMethod[] = [];
  if (value.allow_merge_commit === true) methods.push("merge");
  if (value.allow_squash_merge === true) methods.push("squash");
  if (value.allow_rebase_merge === true) methods.push("rebase");
  return methods;
}

function classifyActiveListFailure(result: GhCommandResult): GhActivePullRequestListResult {
  const diagnostic = `${result.stderr ?? ""}\n${result.stdout}`;
  if (/rate limit/i.test(diagnostic)) {
    const retryAfter = /retry.after[:\s]+(\d{1,6})/i.exec(diagnostic)?.[1];
    return {
      status: "rate-limited",
      ...(retryAfter === undefined ? {} : { retryAfterSeconds: Number(retryAfter) }),
    };
  }
  if (/HTTP 401|bad credentials|authentication required|not logged in/i.test(diagnostic)) {
    return { status: "unauthorized" };
  }
  if (
    /Could not resolve host|no such host|connection refused|network is unreachable|TLS handshake|connection reset/i.test(
      diagnostic,
    )
  ) {
    return { status: "disconnected" };
  }
  return { status: "disconnected" };
}

function decodeActivePullRequests(
  output: string,
): ReadonlyArray<GhActivePullRequestRow> | undefined {
  let value: unknown;
  try {
    value = JSON.parse(output);
  } catch {
    return undefined;
  }
  if (!Array.isArray(value)) return undefined;
  const rows: GhActivePullRequestRow[] = [];
  for (const item of value) {
    if (!isRecord(item)) return undefined;
    const number =
      typeof item.number === "number" && Number.isSafeInteger(item.number) ? item.number : 0;
    const title = clampBytes(item.title, 256).trim();
    const author = loginOf(item.author).trim();
    const baseBranch = typeof item.baseRefName === "string" ? item.baseRefName : "";
    const headBranch = typeof item.headRefName === "string" ? item.headRefName : "";
    const updatedAt = typeof item.updatedAt === "string" ? item.updatedAt : "";
    const url = typeof item.url === "string" ? item.url : "";
    if (
      number <= 0 ||
      title.length === 0 ||
      author.length === 0 ||
      !validBranch(baseBranch) ||
      !validBranch(headBranch) ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/.test(updatedAt) ||
      !url.startsWith("https://github.com/")
    ) {
      return undefined;
    }
    rows.push({
      number,
      title,
      draft: item.isDraft === true,
      author,
      baseBranch,
      headBranch,
      updatedAt,
      url,
      checks: summarizeChecks(item.statusCheckRollup),
      review: summarizeReview(item.reviewDecision),
    });
  }
  return rows;
}

function summarizeChecks(value: unknown): GhActivePullRequestRow["checks"] {
  if (!Array.isArray(value) || value.length === 0) return "unknown";
  let pending = false;
  let failing = false;
  let passing = false;
  for (const entry of value) {
    if (!isRecord(entry)) continue;
    const state = normalizeCheckState(entry);
    if (state === "failure") failing = true;
    else if (state === "pending") pending = true;
    else if (state === "success") passing = true;
  }
  if (failing) return "failing";
  if (pending) return "pending";
  if (passing) return "passing";
  return "unknown";
}

function summarizeReview(value: unknown): GhActivePullRequestRow["review"] {
  const decision = typeof value === "string" ? value.toUpperCase() : "";
  if (decision === "APPROVED") return "approved";
  if (decision === "CHANGES_REQUESTED") return "changes-requested";
  if (decision === "REVIEW_REQUIRED") return "pending";
  if (decision === "") return "none";
  return "unknown";
}

function mapMergeDenyCode(
  code: Extract<
    ReturnType<typeof decidePullRequestMergeability>,
    { readonly decision: "deny" }
  >["code"],
): GhPullRequestMergeFailureCode {
  switch (code) {
    case "conflict":
      return "conflict";
    case "checks":
      return "checks";
    case "sha-mismatch":
      return "sha-mismatch";
    case "draft":
    case "not-open":
    case "unknown-mergeable":
    case "method-unsupported":
      return "not-mergeable";
  }
}

function decodeCommits(value: unknown): GhPullRequestReviewDetail["commits"] {
  if (!Array.isArray(value)) return [];
  const commits: { oid: string; messageHeadline: string; author: string }[] = [];
  for (const entry of value.slice(0, MAX_PR_REVIEW_ITEMS)) {
    if (!isRecord(entry)) continue;
    const oid = typeof entry.oid === "string" ? entry.oid.trim().slice(0, 64) : "";
    if (oid.length === 0) continue;
    const authors = Array.isArray(entry.authors) ? entry.authors : [];
    const firstAuthor = authors.length > 0 && isRecord(authors[0]) ? authors[0] : undefined;
    commits.push({
      oid,
      messageHeadline: clampBytes(entry.messageHeadline, 1_024),
      author:
        firstAuthor === undefined
          ? ""
          : clampBytes(firstAuthor.login ?? firstAuthor.name ?? "", 255),
    });
  }
  return commits;
}

function decodeFiles(value: unknown): GhPullRequestReviewDetail["files"] {
  if (!Array.isArray(value)) return [];
  const files: { path: string; additions: number; deletions: number }[] = [];
  for (const entry of value.slice(0, MAX_PR_REVIEW_ITEMS)) {
    if (!isRecord(entry)) continue;
    const path = clampBytes(entry.path, 4_096).trim();
    if (path.length === 0) continue;
    files.push({
      path,
      additions: nonNegativeInteger(entry.additions),
      deletions: nonNegativeInteger(entry.deletions),
    });
  }
  return files;
}

function decodeChecks(value: unknown): GhPullRequestReviewDetail["checks"] {
  if (!Array.isArray(value)) return [];
  const checks: { name: string; state: GhPullRequestReviewDetail["checks"][number]["state"] }[] =
    [];
  for (const entry of value.slice(0, MAX_PR_REVIEW_ITEMS)) {
    if (!isRecord(entry)) continue;
    const rawName = typeof entry.name === "string" ? entry.name : entry.context;
    const name = clampBytes(rawName, 512).trim();
    if (name.length === 0) continue;
    checks.push({ name, state: normalizeCheckState(entry) });
  }
  return checks;
}

function decodeReviews(value: unknown): GhPullRequestReviewDetail["reviews"] {
  if (!Array.isArray(value)) return [];
  const reviews: GhPullRequestReviewDetail["reviews"][number][] = [];
  for (const entry of value.slice(0, MAX_PR_REVIEW_ITEMS)) {
    if (!isRecord(entry)) continue;
    reviews.push({
      author: loginOf(entry.author),
      state: normalizeReviewState(entry.state),
      body: clampBytes(entry.body, 8_192),
    });
  }
  return reviews;
}

function decodeComments(value: unknown): GhPullRequestReviewDetail["comments"] {
  if (!Array.isArray(value)) return [];
  const comments: { author: string; body: string }[] = [];
  for (const entry of value.slice(0, MAX_PR_REVIEW_ITEMS)) {
    if (!isRecord(entry)) continue;
    comments.push({ author: loginOf(entry.author), body: clampBytes(entry.body, 16_384) });
  }
  return comments;
}

function normalizeCheckState(
  entry: Record<string, unknown>,
): GhPullRequestReviewDetail["checks"][number]["state"] {
  const conclusion = typeof entry.conclusion === "string" ? entry.conclusion.toUpperCase() : "";
  const status = typeof entry.status === "string" ? entry.status.toUpperCase() : "";
  const contextState = typeof entry.state === "string" ? entry.state.toUpperCase() : "";
  const signal = conclusion !== "" ? conclusion : contextState;
  if (signal === "SUCCESS") return "success";
  if (
    signal === "FAILURE" ||
    signal === "ERROR" ||
    signal === "TIMED_OUT" ||
    signal === "ACTION_REQUIRED" ||
    signal === "STARTUP_FAILURE"
  )
    return "failure";
  if (signal === "NEUTRAL" || signal === "SKIPPED" || signal === "CANCELLED" || signal === "STALE")
    return "neutral";
  if (
    status === "QUEUED" ||
    status === "IN_PROGRESS" ||
    status === "PENDING" ||
    status === "WAITING" ||
    status === "REQUESTED" ||
    contextState === "PENDING" ||
    contextState === "EXPECTED"
  )
    return "pending";
  return "unknown";
}

function normalizeReviewState(
  value: unknown,
): GhPullRequestReviewDetail["reviews"][number]["state"] {
  const state = typeof value === "string" ? value.toUpperCase() : "";
  if (state === "APPROVED") return "approved";
  if (state === "CHANGES_REQUESTED") return "changes-requested";
  if (state === "COMMENTED") return "commented";
  if (state === "DISMISSED") return "dismissed";
  if (state === "PENDING") return "pending";
  return "unknown";
}

function loginOf(value: unknown): string {
  if (!isRecord(value)) return "";
  return clampBytes(value.login ?? value.name ?? "", 255);
}

function nonNegativeInteger(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function clampBytes(value: unknown, maxBytes: number): string {
  if (typeof value !== "string") return "";
  const bytes = Buffer.from(value, "utf8");
  if (bytes.byteLength <= maxBytes) return value;
  return bytes
    .subarray(0, maxBytes)
    .toString("utf8")
    .replace(/\uFFFD+$/u, "");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && keys.every((key) => expected.includes(key));
}

async function runGh(
  ghPath: string,
  arguments_: readonly string[],
  options: GhCommandOptions,
  signal: AbortSignal,
  outputLimitBytes: number,
  timeoutMs: number,
): Promise<GhCommandResult> {
  if (signal.aborted || arguments_.some((argument) => argument.includes("\0"))) {
    return { exitCode: 1, stdout: "" };
  }
  return new Promise((resolve) => {
    const child = spawn(ghPath, arguments_, {
      detached: process.platform !== "win32",
      env: options.environment,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let settled = false;
    let overflow = false;
    let timedOut = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const chunks: Buffer[] = [];
    let length = 0;
    const errorChunks: Buffer[] = [];
    let errorLength = 0;
    const finish = (exitCode: number) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      if (timeout !== undefined) clearTimeout(timeout);
      resolve({
        exitCode: overflow ? 1 : exitCode,
        stdout: overflow ? "" : Buffer.concat(chunks, length).toString("utf8"),
        stderr: Buffer.concat(errorChunks, errorLength).toString("utf8"),
        timedOut,
      });
    };
    const terminate = () => {
      try {
        if (child.pid !== undefined && process.platform !== "win32")
          process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch {
        // Process exit remains authoritative.
      }
    };
    const onAbort = () => {
      terminate();
      finish(1);
    };
    signal.addEventListener("abort", onAbort, { once: true });
    timeout = setTimeout(() => {
      timedOut = true;
      terminate();
      finish(1);
    }, timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => {
      if (overflow) return;
      if (length + chunk.length > outputLimitBytes) {
        overflow = true;
        terminate();
        return;
      }
      chunks.push(Buffer.from(chunk));
      length += chunk.length;
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (errorLength >= 8_192) return;
      const next = chunk.subarray(0, Math.max(0, 8_192 - errorLength));
      errorChunks.push(Buffer.from(next));
      errorLength += next.length;
    });
    child.once("error", () => finish(1));
    child.once("close", (code) => finish(code ?? 1));
    if (options.stdin === undefined) child.stdin.end();
    else child.stdin.end(options.stdin, "utf8");
  });
}
