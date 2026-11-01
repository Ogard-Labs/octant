import type { RequiredChecksState } from "@octant/domain/code-pull-request-action-policy";
import type { CodeThreadId } from "@octant/contracts";
import type { CodeOperationPullRequestPort } from "./codeOperationService";
import {
  GhPullRequestPort,
  sanitizeGhEnvironment,
  validRepository,
  type GhCommandPort,
  type GhCommandResult,
  type GhDeliveryTarget,
} from "./ghPullRequestPort";

const MAX_COMMENT_BYTES = 65_536;
const MAX_LABELS = 20;
const NODE_ID_PATTERN = /^[A-Za-z0-9_=-]{1,128}$/;

export interface GhPullRequestIdentityRequest {
  readonly owner: string;
  readonly name: string;
  readonly number: number;
}

export type GhPullRequestActionResult =
  | Readonly<{ status: "done" }>
  | Readonly<{
      status: "refused";
      reason:
        | "invalid"
        | "not-open"
        | "not-closed"
        | "merged"
        | "label-not-found"
        | "stale"
        | "own-pull-request"
        | "failed";
    }>
  | Readonly<{
      status: "unavailable";
      reason: "disconnected" | "unauthenticated" | "unavailable";
    }>;

export type GhPullRequestSummaryResult =
  | Readonly<{
      status: "read";
      state: "open" | "closed" | "merged";
      headBranch: string;
      baseBranch: string;
      headSha: string;
    }>
  | Readonly<{ status: "unavailable" }>;

const CONTEXT_THREADS_QUERY =
  "query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){reviewThreads(first:50){nodes{id isResolved isOutdated path comments(first:1){nodes{author{login} body}}}}}}}";

export type GhPullRequestActionContextResult =
  | Readonly<{
      status: "read";
      labels: ReadonlyArray<string>;
      repositoryLabels: ReadonlyArray<string>;
      reviewThreads: ReadonlyArray<
        Readonly<{
          id: string;
          resolved: boolean;
          outdated: boolean;
          path: string;
          author: string;
          excerpt: string;
        }>
      >;
    }>
  | Readonly<{ status: "unavailable"; reason: "disconnected" | "unauthenticated" | "unavailable" }>;

const THREAD_OWNER_QUERY =
  "query($thread:ID!){node(id:$thread){... on PullRequestReviewThread{pullRequest{number repository{name owner{login}}}}}}";

const REPLY_MUTATION =
  "mutation($thread:ID!,$body:String!){addPullRequestReviewThreadReply(input:{pullRequestReviewThreadId:$thread,body:$body}){comment{id}}}";

/**
 * The forge calls behind the person's pull-request actions (labels, comments,
 * review replies, close, reopen), through the host's own `gh` login. Every call
 * names a pull request by repository and number; nothing here creates a
 * repository-wide label, deletes a branch, or approves a pull request.
 */
export class GhPullRequestActionPort {
  readonly #command: GhCommandPort;
  readonly #environment: NodeJS.ProcessEnv;

  constructor(options: {
    readonly command: GhCommandPort;
    readonly inheritedEnvironment?: NodeJS.ProcessEnv;
  }) {
    this.#command = options.command;
    this.#environment = sanitizeGhEnvironment(options.inheritedEnvironment ?? process.env);
  }

  async summary(
    request: GhPullRequestIdentityRequest,
    signal: AbortSignal,
  ): Promise<GhPullRequestSummaryResult> {
    const repository = repositoryOf(request);
    if (repository === undefined) return { status: "unavailable" };
    const result = await this.#run(
      [
        "pr",
        "view",
        String(request.number),
        "--repo",
        repository,
        "--json",
        "state,headRefName,baseRefName,headRefOid",
      ],
      undefined,
      signal,
    );
    if (result === undefined || result.exitCode !== 0) return { status: "unavailable" };
    const value = parseJson(result.stdout);
    if (!isRecord(value)) return { status: "unavailable" };
    const state =
      value.state === "OPEN"
        ? "open"
        : value.state === "CLOSED"
          ? "closed"
          : value.state === "MERGED"
            ? "merged"
            : undefined;
    if (
      state === undefined ||
      typeof value.headRefName !== "string" ||
      typeof value.baseRefName !== "string" ||
      typeof value.headRefOid !== "string"
    ) {
      return { status: "unavailable" };
    }
    return {
      status: "read",
      state,
      headBranch: value.headRefName,
      baseBranch: value.baseRefName,
      headSha: value.headRefOid,
    };
  }

  /**
   * What the person's controls name: the pull request's labels, the labels the
   * repository already has, and its review threads. Nothing here writes.
   */
  async readContext(
    request: GhPullRequestIdentityRequest,
    signal: AbortSignal,
  ): Promise<GhPullRequestActionContextResult> {
    const repository = repositoryOf(request);
    if (repository === undefined) return { status: "unavailable", reason: "unavailable" };
    const [view, labels, threads] = await Promise.all([
      this.#run(
        ["pr", "view", String(request.number), "--repo", repository, "--json", "labels"],
        undefined,
        signal,
      ),
      this.#run(
        ["label", "list", "--repo", repository, "--limit", "100", "--json", "name"],
        undefined,
        signal,
      ),
      this.#run(
        [
          "api",
          "graphql",
          "-f",
          `query=${CONTEXT_THREADS_QUERY}`,
          // -f keeps owner and name strings: -F would turn a repository named
          // `true` or `2048` into a boolean or integer GraphQL rejects.
          "-f",
          `owner=${request.owner}`,
          "-f",
          `name=${request.name}`,
          "-F",
          `number=${request.number}`,
        ],
        undefined,
        signal,
      ),
    ]);
    for (const result of [view, labels, threads]) {
      if (result === undefined) return { status: "unavailable", reason: "disconnected" };
      if (result.exitCode !== 0) {
        const diagnostic = `${result.stderr ?? ""}\n${result.stdout}`;
        return /HTTP 401|bad credentials|authentication required|not logged in/i.test(diagnostic)
          ? { status: "unavailable", reason: "unauthenticated" }
          : { status: "unavailable", reason: "unavailable" };
      }
    }
    const viewValue = parseJson(view?.stdout ?? "");
    const labelsValue = parseJson(labels?.stdout ?? "");
    const nodes = pathOf(parseJson(threads?.stdout ?? ""), [
      "data",
      "repository",
      "pullRequest",
      "reviewThreads",
      "nodes",
    ]);
    if (!isRecord(viewValue) || !Array.isArray(labelsValue) || !Array.isArray(nodes)) {
      return { status: "unavailable", reason: "unavailable" };
    }
    return {
      status: "read",
      labels: labelNames(viewValue.labels).slice(0, 50),
      repositoryLabels: labelNames(labelsValue).slice(0, 100),
      reviewThreads: nodes.flatMap((node) => {
        if (!isRecord(node) || typeof node.id !== "string" || !NODE_ID_PATTERN.test(node.id)) {
          return [];
        }
        const first = pathOf(node, ["comments", "nodes", "0"]);
        return [
          {
            id: node.id,
            resolved: node.isResolved === true,
            outdated: node.isOutdated === true,
            path: typeof node.path === "string" ? node.path.slice(0, 1_024) : "",
            author: isRecord(first) && isRecord(first.author) ? loginText(first.author.login) : "",
            excerpt:
              isRecord(first) && typeof first.body === "string" ? first.body.slice(0, 400) : "",
          },
        ];
      }),
    };
  }

  /**
   * The required checks of the pull request: `none` when the repository
   * requires none, `unknown` when the forge could not be read. `gh` exits
   * non-zero while a check fails or is pending, so the exit code alone says
   * nothing; only the buckets do.
   */
  async requiredChecks(
    request: GhPullRequestIdentityRequest,
    signal: AbortSignal,
  ): Promise<RequiredChecksState> {
    const repository = repositoryOf(request);
    if (repository === undefined) return "unknown";
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
      undefined,
      signal,
    );
    if (result === undefined) return "unknown";
    const value = parseJson(result.stdout);
    if (!Array.isArray(value)) {
      return /no required checks|no checks reported/i.test(
        `${result.stderr ?? ""}\n${result.stdout}`,
      )
        ? "none"
        : "unknown";
    }
    if (value.length === 0) return "none";
    let pending = false;
    for (const entry of value) {
      if (!isRecord(entry)) return "unknown";
      if (entry.bucket === "fail" || entry.bucket === "cancel") return "failing";
      if (entry.bucket === "pending") pending = true;
      else if (entry.bucket !== "pass" && entry.bucket !== "skipping") return "unknown";
    }
    return pending ? "pending" : "passing";
  }

  /**
   * Adds and removes labels that already exist in the repository. A label the
   * repository lacks is refused as `label-not-found`: `gh` does not create it,
   * and neither does Octant.
   */
  async editLabels(
    request: GhPullRequestIdentityRequest & {
      readonly add: ReadonlyArray<string>;
      readonly remove: ReadonlyArray<string>;
    },
    signal: AbortSignal,
  ): Promise<GhPullRequestActionResult> {
    const repository = repositoryOf(request);
    const labels = [...request.add, ...request.remove];
    if (
      repository === undefined ||
      labels.length === 0 ||
      labels.length > MAX_LABELS ||
      !labels.every(validLabel)
    ) {
      return { status: "refused", reason: "invalid" };
    }
    return this.#act(
      [
        "pr",
        "edit",
        String(request.number),
        "--repo",
        repository,
        ...(request.add.length === 0 ? [] : ["--add-label", request.add.join(",")]),
        ...(request.remove.length === 0 ? [] : ["--remove-label", request.remove.join(",")]),
      ],
      undefined,
      signal,
    );
  }

  async comment(
    request: GhPullRequestIdentityRequest & { readonly body: string },
    signal: AbortSignal,
  ): Promise<GhPullRequestActionResult> {
    const repository = repositoryOf(request);
    if (repository === undefined || !validComment(request.body)) {
      return { status: "refused", reason: "invalid" };
    }
    return this.#act(
      ["pr", "comment", String(request.number), "--repo", repository, "--body-file", "-"],
      request.body,
      signal,
    );
  }

  /**
   * Approves or requests changes on the named head through the review API, so
   * the forge records the review on that commit and refuses one for a head that
   * has since moved. The review is posted under the person's name.
   */
  async review(
    request: GhPullRequestIdentityRequest & {
      readonly event: "approve" | "request-changes";
      readonly headSha: string;
      readonly body?: string;
    },
    signal: AbortSignal,
  ): Promise<GhPullRequestActionResult> {
    const repository = repositoryOf(request);
    if (
      repository === undefined ||
      !/^[0-9a-f]{40}$/.test(request.headSha) ||
      (request.body !== undefined && !validComment(request.body)) ||
      (request.event === "request-changes" && request.body === undefined)
    ) {
      return { status: "refused", reason: "invalid" };
    }
    return this.#act(
      ["api", "--method", "POST", `repos/${repository}/pulls/${request.number}/reviews`, "--input", "-"],
      JSON.stringify({
        event: request.event === "approve" ? "APPROVE" : "REQUEST_CHANGES",
        commit_id: request.headSha,
        ...(request.body === undefined ? {} : { body: request.body }),
      }),
      signal,
    );
  }

  /**
   * Replies in one review thread by the thread's node id. The thread is read
   * first and must belong to the named pull request: a node id is global, so
   * an id from another pull request or repository would otherwise post under
   * the person's name outside the scope they approved.
   */
  async replyToReviewThread(
    request: GhPullRequestIdentityRequest & {
      readonly threadNodeId: string;
      readonly body: string;
    },
    signal: AbortSignal,
  ): Promise<GhPullRequestActionResult> {
    if (
      repositoryOf(request) === undefined ||
      !NODE_ID_PATTERN.test(request.threadNodeId) ||
      !validComment(request.body)
    ) {
      return { status: "refused", reason: "invalid" };
    }
    const owner = await this.#run(
      [
        "api",
        "graphql",
        "-f",
        `query=${THREAD_OWNER_QUERY}`,
        "-F",
        `thread=${request.threadNodeId}`,
      ],
      undefined,
      signal,
    );
    if (owner === undefined || owner.exitCode !== 0) {
      return { status: "unavailable", reason: "unavailable" };
    }
    if (!threadBelongsTo(parseJson(owner.stdout), request)) {
      return { status: "refused", reason: "invalid" };
    }
    return this.#act(
      [
        "api",
        "graphql",
        "-f",
        `query=${REPLY_MUTATION}`,
        "-F",
        `thread=${request.threadNodeId}`,
        "-F",
        "body=@-",
      ],
      request.body,
      signal,
    );
  }

  /**
   * Points a stacked pull request at the branch the stack lands on, so merging
   * its parent first does not strand it on the parent's branch.
   */
  async retarget(
    request: GhPullRequestIdentityRequest & { readonly baseBranch: string },
    signal: AbortSignal,
  ): Promise<GhPullRequestActionResult> {
    const repository = repositoryOf(request);
    if (repository === undefined || !validBranch(request.baseBranch)) {
      return { status: "refused", reason: "invalid" };
    }
    return this.#act(
      ["pr", "edit", String(request.number), "--repo", repository, "--base", request.baseBranch],
      undefined,
      signal,
    );
  }

  /**
   * Closes an open pull request, or reopens a closed one that was not merged.
   * The state is read first so a merged pull request is refused by name, and
   * the branch is never deleted.
   */
  async setState(
    request: GhPullRequestIdentityRequest & { readonly state: "closed" | "open" },
    signal: AbortSignal,
  ): Promise<GhPullRequestActionResult> {
    const repository = repositoryOf(request);
    if (repository === undefined) return { status: "refused", reason: "invalid" };
    const current = await this.summary(request, signal);
    if (current.status !== "read") return { status: "unavailable", reason: "unavailable" };
    if (current.state === "merged") return { status: "refused", reason: "merged" };
    if (request.state === "closed" && current.state !== "open") {
      return { status: "refused", reason: "not-open" };
    }
    if (request.state === "open" && current.state !== "closed") {
      return { status: "refused", reason: "not-closed" };
    }
    return this.#act(
      [
        "pr",
        request.state === "closed" ? "close" : "reopen",
        String(request.number),
        "--repo",
        repository,
      ],
      undefined,
      signal,
    );
  }

  async #act(
    arguments_: readonly string[],
    stdin: string | undefined,
    signal: AbortSignal,
  ): Promise<GhPullRequestActionResult> {
    let result: GhCommandResult;
    try {
      result = await this.#command.run(
        arguments_,
        { environment: this.#environment, stdin },
        signal,
      );
    } catch {
      return { status: "unavailable", reason: "disconnected" };
    }
    if (result.timedOut === true) return { status: "unavailable", reason: "disconnected" };
    if (result.exitCode === 0) return { status: "done" };
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
    if (/label.*not found|could not add label|could not remove label/i.test(diagnostic)) {
      return { status: "refused", reason: "label-not-found" };
    }
    if (/own pull request/i.test(diagnostic)) {
      return { status: "refused", reason: "own-pull-request" };
    }
    if (/commit_id|commit.*(not found|not part|no longer)/i.test(diagnostic)) {
      return { status: "refused", reason: "stale" };
    }
    return { status: "refused", reason: "failed" };
  }

  async #run(
    arguments_: readonly string[],
    stdin: string | undefined,
    signal: AbortSignal,
  ): Promise<GhCommandResult | undefined> {
    try {
      const result = await this.#command.run(
        arguments_,
        { environment: this.#environment, stdin },
        signal,
      );
      return result.timedOut === true ? undefined : result;
    } catch {
      return undefined;
    }
  }
}

function repositoryOf(request: GhPullRequestIdentityRequest): string | undefined {
  const repository = `${request.owner}/${request.name}`;
  return validRepository(repository) && Number.isSafeInteger(request.number) && request.number > 0
    ? repository
    : undefined;
}

function validBranch(branch: string): boolean {
  return /^[A-Za-z0-9_][A-Za-z0-9._/-]{0,199}$/.test(branch) && !branch.includes("..");
}

function threadBelongsTo(value: unknown, request: GhPullRequestIdentityRequest): boolean {
  if (!isRecord(value) || !isRecord(value.data) || !isRecord(value.data.node)) return false;
  const pullRequest = value.data.node.pullRequest;
  if (!isRecord(pullRequest) || !isRecord(pullRequest.repository)) return false;
  const owner = pullRequest.repository.owner;
  return (
    pullRequest.number === request.number &&
    pullRequest.repository.name === request.name &&
    isRecord(owner) &&
    owner.login === request.owner
  );
}

function validLabel(label: string): boolean {
  return (
    label.length >= 1 &&
    label.length <= 50 &&
    !label.includes("\0") &&
    !/[\n\r,]/.test(label) &&
    label.trim() === label
  );
}

function validComment(body: string): boolean {
  return body.trim() !== "" && !body.includes("\0") && Buffer.byteLength(body) <= MAX_COMMENT_BYTES;
}

function labelNames(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) =>
    isRecord(entry) && typeof entry.name === "string" && validLabel(entry.name) ? [entry.name] : [],
  );
}

function loginText(value: unknown): string {
  return typeof value === "string" ? value.slice(0, 255) : "";
}

function pathOf(value: unknown, path: ReadonlyArray<string>): unknown {
  let current = value;
  for (const key of path) {
    if (Array.isArray(current)) current = current[Number(key)];
    else if (isRecord(current)) current = current[key];
    else return undefined;
  }
  return current;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The production pull-request port: the thread-scoped calls and the
 * identity-scoped actions over one `gh` command port. Each call goes through
 * its instance, because a class-backed port reads private state through `this`.
 */
export function createGhPullRequestPort(options: {
  readonly command: GhCommandPort;
  readonly resolveTarget: (threadId: CodeThreadId) => Promise<GhDeliveryTarget | undefined>;
  readonly inheritedEnvironment?: NodeJS.ProcessEnv;
}): CodeOperationPullRequestPort {
  const inherited =
    options.inheritedEnvironment === undefined
      ? {}
      : { inheritedEnvironment: options.inheritedEnvironment };
  const port = new GhPullRequestPort({
    command: options.command,
    resolveTarget: options.resolveTarget,
    ...inherited,
  });
  const actions = new GhPullRequestActionPort({ command: options.command, ...inherited });
  return {
    ensure: (input, signal) => port.ensure(input, signal),
    update: (input, signal) => port.update(input, signal),
    observeReview: (input, signal) => port.observeReview(input, signal),
    locate: (threadId, state, signal) => port.locate(threadId, state, signal),
    actions: {
      editLabels: (input, signal) => actions.editLabels(input, signal),
      comment: (input, signal) => actions.comment(input, signal),
      replyToReviewThread: (input, signal) => actions.replyToReviewThread(input, signal),
      retarget: (input, signal) => actions.retarget(input, signal),
      setState: (input, signal) => actions.setState(input, signal),
      summary: (input, signal) => actions.summary(input, signal),
      requiredChecks: (input, signal) => actions.requiredChecks(input, signal),
      merge: (input, signal) => port.mergeByIdentity(input, signal),
    },
  };
}
