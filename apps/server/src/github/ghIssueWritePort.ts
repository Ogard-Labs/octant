import {
  sanitizeGhEnvironment,
  validRepository,
  type GhCommandPort,
  type GhCommandResult,
} from "../code/ghPullRequestPort";

export interface GhIssueTarget {
  readonly owner: string;
  readonly repository: string;
  readonly number: number;
}

/**
 * `missing-capability` is a `gh` login that may not write the repository's
 * issues (`issues-write`): GitHub would refuse it, so the host does not try.
 */
export type GhIssueWriteResult =
  | { readonly status: "applied" }
  | { readonly status: "refused"; readonly reason: "missing-capability" | "not-found" }
  | { readonly status: "failed"; readonly reason: "rate-limited" | "unavailable" };

export type GhIssueStateResult =
  | { readonly status: "read"; readonly open: boolean }
  | Exclude<GhIssueWriteResult, { readonly status: "applied" }>;

const MAX_COMMENT_BYTES = 4 * 1024;

/**
 * The host's GitHub issue writes, through its own `gh` login: a comment, and
 * close as completed. Nothing else, so a linked issue can never be reopened,
 * relabelled or reassigned from here. Each write first proves `issues-write`
 * on the repository (triage or push permission); OAuth scopes alone never
 * stand in for it, as for the read capabilities.
 */
export class GhIssueWritePort {
  readonly #command: GhCommandPort;
  readonly #environment: NodeJS.ProcessEnv;

  constructor(options: {
    readonly command: GhCommandPort;
    readonly inheritedEnvironment?: NodeJS.ProcessEnv;
  }) {
    this.#command = options.command;
    this.#environment = sanitizeGhEnvironment(options.inheritedEnvironment ?? process.env);
  }

  async readState(target: GhIssueTarget, signal?: AbortSignal): Promise<GhIssueStateResult> {
    const repository = repositoryOf(target);
    if (repository === undefined) return { status: "refused", reason: "not-found" };
    const result = await this.#run(
      ["issue", "view", String(target.number), "--repo", repository, "--json", "state"],
      undefined,
      signal,
    );
    if (result.exitCode !== 0) return failure(result);
    const parsed = parse(result.stdout);
    const state = isRecord(parsed) ? parsed.state : undefined;
    if (state !== "OPEN" && state !== "CLOSED") return { status: "failed", reason: "unavailable" };
    return { status: "read", open: state === "OPEN" };
  }

  async comment(
    target: GhIssueTarget & { readonly body: string },
    signal?: AbortSignal,
  ): Promise<GhIssueWriteResult> {
    const repository = repositoryOf(target);
    if (repository === undefined) return { status: "refused", reason: "not-found" };
    if (
      target.body.trim().length === 0 ||
      target.body.includes("\0") ||
      Buffer.byteLength(target.body) > MAX_COMMENT_BYTES
    ) {
      return { status: "failed", reason: "unavailable" };
    }
    const allowed = await this.#mayWriteIssues(repository, signal);
    if (allowed !== undefined) return allowed;
    // The body goes on stdin: an argument would show in the process list.
    const result = await this.#run(
      ["issue", "comment", String(target.number), "--repo", repository, "--body-file", "-"],
      target.body,
      signal,
    );
    return result.exitCode === 0 ? { status: "applied" } : failure(result);
  }

  async close(target: GhIssueTarget, signal?: AbortSignal): Promise<GhIssueWriteResult> {
    const repository = repositoryOf(target);
    if (repository === undefined) return { status: "refused", reason: "not-found" };
    const allowed = await this.#mayWriteIssues(repository, signal);
    if (allowed !== undefined) return allowed;
    const result = await this.#run(
      ["issue", "close", String(target.number), "--repo", repository, "--reason", "completed"],
      undefined,
      signal,
    );
    return result.exitCode === 0 ? { status: "applied" } : failure(result);
  }

  /** Undefined when the login may write the repository's issues; the refusal otherwise. */
  async #mayWriteIssues(
    repository: string,
    signal?: AbortSignal,
  ): Promise<Exclude<GhIssueWriteResult, { readonly status: "applied" }> | undefined> {
    const result = await this.#run(
      ["api", `repos/${repository}`, "--jq", ".permissions"],
      undefined,
      signal,
    );
    if (result.exitCode !== 0) return failure(result);
    const permissions = parse(result.stdout);
    if (!isRecord(permissions)) return { status: "failed", reason: "unavailable" };
    const writes = ["triage", "push", "maintain", "admin"].some((key) => permissions[key] === true);
    return writes ? undefined : { status: "refused", reason: "missing-capability" };
  }

  async #run(
    arguments_: readonly string[],
    stdin: string | undefined,
    signal?: AbortSignal,
  ): Promise<GhCommandResult> {
    try {
      return await this.#command.run(
        arguments_,
        { environment: this.#environment, stdin },
        signal ?? new AbortController().signal,
      );
    } catch {
      return { exitCode: 1, stdout: "" };
    }
  }
}

function repositoryOf(target: GhIssueTarget): string | undefined {
  const repository = `${target.owner}/${target.repository}`;
  return validRepository(repository) && Number.isSafeInteger(target.number) && target.number > 0
    ? repository
    : undefined;
}

function failure(result: GhCommandResult): Exclude<GhIssueWriteResult, { status: "applied" }> {
  const stderr = (result.stderr ?? "").toLowerCase();
  if (stderr.includes("rate limit")) return { status: "failed", reason: "rate-limited" };
  if (stderr.includes("not found") || stderr.includes("could not resolve")) {
    return { status: "refused", reason: "not-found" };
  }
  if (stderr.includes("http 403") || stderr.includes("must have")) {
    return { status: "refused", reason: "missing-capability" };
  }
  return { status: "failed", reason: "unavailable" };
}

function parse(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
