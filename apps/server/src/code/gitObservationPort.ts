import { execFile as nodeExecFile } from "node:child_process";
import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { createGitCommandEnvironment } from "../gitEnvironmentPort";
import {
  createGitSeatbeltConfinement,
  prepareGitSeatbeltLaunch,
  type GitSeatbeltPortOptions,
} from "../process/gitSeatbeltLaunch";
import { SeatbeltConfinementError } from "../process/seatbeltProfile";

export const DEFAULT_MAX_GIT_DIFF_BYTES = 256 * 1024;
const MAX_OBSERVED_REMOTES = 32;

export interface GitStatusEntry {
  readonly path: string;
  readonly originalPath?: string;
  readonly index: string;
  readonly worktree: string;
}

/**
 * A checkout that has no commits yet still has a HEAD: it points at a branch
 * that does not exist. That branch has a name but no object, so an unborn head
 * carries no oid rather than a placeholder one.
 */
export type GitObservedHead =
  | { readonly kind: "branch"; readonly name: string; readonly oid: string }
  | { readonly kind: "detached"; readonly oid: string }
  | { readonly kind: "unborn"; readonly name: string };

export interface GitObservation {
  readonly status: "ready";
  readonly checkoutRoot: string;
  readonly head: GitObservedHead;
  readonly statusEntries: readonly GitStatusEntry[];
  readonly changedPaths: readonly string[];
  readonly insertions: number;
  readonly deletions: number;
  readonly stagedSummary: readonly GitStatusEntry[];
  readonly diff: {
    readonly text: string;
    readonly byteLength: number;
    readonly truncated: boolean;
  };
  readonly remotes: readonly {
    readonly name: string;
    readonly fetchUrl: string;
    readonly pushUrl: string;
    /** True only when Git's URL contained userinfo that was redacted. */
    readonly credentialed?: boolean;
  }[];
  readonly upstream: {
    readonly remote: string;
    readonly mergeRef: string;
  } | null;
  readonly worktrees: readonly {
    readonly path: string;
    readonly head: string | null;
    readonly branch: string | null;
    readonly detached: boolean;
    readonly bare: boolean;
    readonly locked: boolean;
    readonly prunable: boolean;
  }[];
  readonly stateToken: string;
}

export type GitObservationResult =
  | GitObservation
  | { readonly status: "unavailable" }
  | { readonly status: "failed" };

/** One named slice of a checkout's changes: the paths in it, and its diff. */
export type GitScopedDiffResult =
  | {
      readonly status: "ready";
      readonly paths: readonly string[];
      readonly diff: GitObservation["diff"];
    }
  | { readonly status: "unavailable" };

/**
 * How a run's branch stands against the branch it targets. `mergeability` is
 * what Git said, never what the caller hoped.
 */
export type GitBranchComparisonResult =
  | {
      readonly status: "ready";
      readonly head: string;
      readonly base?: string;
      readonly ahead: number;
      readonly behind: number;
      readonly mergeability: "clean" | "conflicts" | "nothing-to-merge" | "unknown";
    }
  | { readonly status: "unavailable" };

/**
 * A revision this port will pass to Git. Deliberately narrow: branch names,
 * remote-tracking names, and object IDs, with nothing that could be read as an
 * option or a path.
 */
function validRevision(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= 512 &&
    value.trim() === value &&
    !value.startsWith("-") &&
    /^[A-Za-z0-9._/-]+$/.test(value) &&
    !value.includes("..") &&
    !value.endsWith("/")
  );
}

interface CommandResult {
  readonly exitCode: number;
  readonly stdout: string;
}

export interface GitObservationDependencies {
  readonly realpath: (path: string) => Promise<string>;
  readonly execFile: (
    file: string,
    args: readonly string[],
    environment: NodeJS.ProcessEnv,
    signal: AbortSignal,
  ) => Promise<CommandResult>;
}

const liveDependencies: GitObservationDependencies = {
  realpath,
  execFile: (file, args, environment, signal) =>
    new Promise((resolve) => {
      nodeExecFile(
        file,
        [...args],
        {
          encoding: "utf8",
          env: environment,
          shell: false,
          signal,
          maxBuffer: 2 * 1024 * 1024,
        },
        (error, stdout) => {
          resolve({
            exitCode: error && typeof error.code === "number" ? error.code : error ? 1 : 0,
            stdout,
          });
        },
      );
    }),
};

export class GitObservationPort {
  readonly #dependencies: GitObservationDependencies;
  readonly #maxDiffBytes: number;
  readonly #commandTimeoutMs: number;
  readonly #confinement: ReturnType<typeof createGitSeatbeltConfinement>;

  constructor(
    options: {
      readonly maxDiffBytes?: number;
      readonly commandTimeoutMs?: number;
    } & GitSeatbeltPortOptions = {},
    dependencies: GitObservationDependencies = liveDependencies,
  ) {
    this.#dependencies = dependencies;
    this.#maxDiffBytes = options.maxDiffBytes ?? DEFAULT_MAX_GIT_DIFF_BYTES;
    this.#commandTimeoutMs = options.commandTimeoutMs ?? 5_000;
    this.#confinement = createGitSeatbeltConfinement(options);
  }

  /**
   * Read only the sanitized Git remotes needed for a credential-free
   * repository identity. Status, diff, branch, and worktree facts stay on the
   * full observation path so Project bootstrap does not eagerly collect them.
   */
  async observeRemotes(
    root: string,
    signal?: AbortSignal,
  ): Promise<GitObservation["remotes"] | undefined> {
    let checkoutRoot: string;
    try {
      checkoutRoot = await this.#dependencies.realpath(root);
    } catch {
      return undefined;
    }
    const run = (args: readonly string[]) => this.#run(["-C", checkoutRoot, ...args], signal);
    try {
      const top = await run(["rev-parse", "--show-toplevel"]);
      const topPath = top.stdout.trim();
      if (top.exitCode !== 0 || topPath.length === 0) return undefined;
      if ((await this.#dependencies.realpath(topPath)) !== checkoutRoot) return undefined;
      return await readRemotes(run);
    } catch {
      return undefined;
    }
  }

  async observe(root: string, signal?: AbortSignal): Promise<GitObservationResult> {
    if (!Number.isSafeInteger(this.#maxDiffBytes) || this.#maxDiffBytes < 1)
      return { status: "failed" };
    let checkoutRoot: string;
    try {
      checkoutRoot = await this.#dependencies.realpath(root);
    } catch {
      return { status: "unavailable" };
    }
    const run = (args: readonly string[]) => this.#run(["-C", checkoutRoot, ...args], signal);
    try {
      const top = await run(["rev-parse", "--show-toplevel"]);
      if (
        top.exitCode !== 0 ||
        (await this.#dependencies.realpath(top.stdout.trim())) !== checkoutRoot
      )
        return { status: "unavailable" };
      const headResult = await run(["rev-parse", "--verify", "HEAD"]);
      const resolvedOid =
        headResult.exitCode === 0 &&
        /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(headResult.stdout.trim())
          ? headResult.stdout.trim()
          : undefined;
      if (headResult.exitCode === 0 && resolvedOid === undefined) return { status: "failed" };
      const symbolic = await run(["symbolic-ref", "--quiet", "--short", "HEAD"]);
      const branchName =
        symbolic.exitCode === 0 && symbolic.stdout.trim() ? symbolic.stdout.trim() : undefined;
      if (branchName === undefined && symbolic.exitCode !== 1) return { status: "failed" };
      // HEAD not resolving means the branch has no commits yet. That is an
      // observable checkout state, not a failure — but only when HEAD names a
      // branch, because a detached HEAD without an object is broken.
      if (resolvedOid === undefined && branchName === undefined) return { status: "failed" };
      let head: GitObservedHead;
      if (resolvedOid === undefined) {
        if (branchName === undefined) return { status: "failed" };
        head = { kind: "unborn", name: branchName };
      } else if (branchName === undefined) {
        head = { kind: "detached", oid: resolvedOid };
      } else {
        head = { kind: "branch", name: branchName, oid: resolvedOid };
      }
      const statusResult = await run([
        "status",
        "--porcelain=v1",
        "-z",
        "--untracked-files=normal",
      ]);
      if (statusResult.exitCode !== 0) return { status: "failed" };
      const statusEntries = parseStatus(statusResult.stdout);
      if (!statusEntries) return { status: "failed" };
      // An unborn head has no commit to diff against, so the empty tree stands
      // in for one. It has to be a baseline rather than `--cached`, or a file
      // that was staged and then edited again would show the pane its staged
      // version while `git diff HEAD` on any other branch reaches the working
      // tree. `hash-object` is asked for the empty tree rather than the value
      // hardcoded, so a repository on a different hash algorithm still works.
      let baseline = "HEAD";
      if (head.kind === "unborn") {
        const empty = await run(["hash-object", "-t", "tree", "/dev/null"]);
        const emptyTree = empty.stdout.trim();
        if (empty.exitCode !== 0 || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(emptyTree))
          return { status: "failed" };
        baseline = emptyTree;
      }
      const diffResult = await run(["diff", "--no-ext-diff", "--no-color", baseline, "--"]);
      if (diffResult.exitCode !== 0) return { status: "failed" };
      const diff = boundUtf8(diffResult.stdout, this.#maxDiffBytes);
      // Numstat is the same baseline as the unified diff, in the same
      // observation: path counts come from porcelain, line totals from this
      // compact listing, so a truncated patch cannot undercount the summary.
      const numstatResult = await run([
        "diff",
        "--numstat",
        "-z",
        "--no-ext-diff",
        "--no-color",
        baseline,
        "--",
      ]);
      if (numstatResult.exitCode !== 0) return { status: "failed" };
      const lineCounts = parseNumstat(numstatResult.stdout);
      if (!lineCounts) return { status: "failed" };
      const remotes = await readRemotes(run);
      if (remotes === undefined) return { status: "failed" };
      let upstream: GitObservation["upstream"] = null;
      if (head.kind !== "detached") {
        const remote = await run(["config", "--get", `branch.${head.name}.remote`]);
        const merge = await run(["config", "--get", `branch.${head.name}.merge`]);
        if (remote.exitCode === 0 && merge.exitCode === 0)
          upstream = {
            remote: remote.stdout.trim(),
            mergeRef: merge.stdout.trim(),
          };
        else if (![1, 5].includes(remote.exitCode) || ![1, 5].includes(merge.exitCode))
          return { status: "failed" };
      }
      const worktreeResult = await run(["worktree", "list", "--porcelain", "-z"]);
      if (worktreeResult.exitCode !== 0) return { status: "failed" };
      const worktrees = parseWorktrees(worktreeResult.stdout);
      if (!worktrees) return { status: "failed" };
      const changedPaths = [
        ...new Set(
          statusEntries.flatMap((entry) =>
            entry.originalPath ? [entry.path, entry.originalPath] : [entry.path],
          ),
        ),
      ].sort();
      const contentObjects = [];
      for (const path of changedPaths) {
        const object = await run(["hash-object", "--no-filters", "--", path]);
        const indexObject = await run(["rev-parse", "--verify", `:${path}`]);
        contentObjects.push({
          path,
          objectId:
            object.exitCode === 0 && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(object.stdout.trim())
              ? object.stdout.trim()
              : null,
          indexObjectId:
            indexObject.exitCode === 0 &&
            /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(indexObject.stdout.trim())
              ? indexObject.stdout.trim()
              : null,
        });
      }
      const stagedSummary = statusEntries.filter(
        (entry) => entry.index !== " " && entry.index !== "?",
      );
      const stateToken = createHash("sha256")
        .update(
          JSON.stringify({
            head,
            statusEntries,
            contentObjects,
            remotes,
            upstream,
            worktrees,
          }),
        )
        .digest("hex");
      return {
        status: "ready",
        checkoutRoot,
        head,
        statusEntries,
        changedPaths,
        insertions: lineCounts.insertions,
        deletions: lineCounts.deletions,
        stagedSummary,
        diff,
        remotes,
        upstream,
        worktrees,
        stateToken,
      };
    } catch {
      return signal?.aborted ? { status: "unavailable" } : { status: "failed" };
    }
  }

  /**
   * Read one named slice of the checkout's changes.
   *
   * `observe` reports the working tree against HEAD, which is the right answer
   * for a diff pane and the wrong one for anything that describes a specific
   * set of changes: a commit describes what is staged, and a pull request
   * describes what the branch committed. Both are read-only; the scope names
   * which question is being asked rather than leaving the caller to reinterpret
   * a single diff.
   */
  async readDiff(
    input: {
      readonly checkoutRoot: string;
      readonly scope:
        | { readonly kind: "staged" }
        | { readonly kind: "branch"; readonly baseRef: string };
    },
    signal?: AbortSignal,
  ): Promise<GitScopedDiffResult> {
    if (!Number.isSafeInteger(this.#maxDiffBytes) || this.#maxDiffBytes < 1)
      return { status: "unavailable" };
    let checkoutRoot: string;
    try {
      checkoutRoot = await this.#dependencies.realpath(input.checkoutRoot);
    } catch {
      return { status: "unavailable" };
    }
    // `A...B` is what the branch changed since it diverged, not what has since
    // happened on the base — a plain two-dot diff would describe other people's
    // work as this pull request's.
    const revisions =
      input.scope.kind === "staged" ? ["--cached"] : [`${input.scope.baseRef}...HEAD`];
    const run = (args: readonly string[]) => this.#run(["-C", checkoutRoot, ...args], signal);
    try {
      const base = ["diff", "--no-ext-diff", "--no-color", ...revisions];
      const names = await run([...base, "--name-only", "--"]);
      if (names.exitCode !== 0) return { status: "unavailable" };
      const text = await run([...base, "--"]);
      if (text.exitCode !== 0) return { status: "unavailable" };
      return {
        status: "ready",
        paths: names.stdout.split("\n").filter((path) => path.length > 0),
        diff: boundUtf8(text.stdout, this.#maxDiffBytes),
      };
    } catch {
      return { status: "unavailable" };
    }
  }

  /**
   * Measure a run against the branch it targets: how far apart they are, and
   * whether the base could take it as it stands.
   *
   * Mergeability is asked of Git rather than guessed. `merge-tree` computes the
   * merge without a working tree and without touching either branch, so asking
   * costs nothing and changes nothing. A Git that cannot answer reports
   * `unknown`, which the policy treats as a refusal — an optimistic guess here
   * would be a merge conflict in the person's own checkout.
   */
  async compareBranch(
    input: {
      readonly checkoutRoot: string;
      readonly baseRef: string;
      readonly headRef: string;
    },
    signal?: AbortSignal,
  ): Promise<GitBranchComparisonResult> {
    let checkoutRoot: string;
    try {
      checkoutRoot = await this.#dependencies.realpath(input.checkoutRoot);
    } catch {
      return { status: "unavailable" };
    }
    if (!validRevision(input.baseRef) || !validRevision(input.headRef)) {
      return { status: "unavailable" };
    }
    const run = (args: readonly string[]) => this.#run(["-C", checkoutRoot, ...args], signal);
    try {
      const head = await run([
        "rev-parse",
        "--verify",
        "--end-of-options",
        `${input.headRef}^{commit}`,
      ]);
      if (head.exitCode !== 0) return { status: "unavailable" };
      const headOid = head.stdout.trim();
      const base = await run([
        "rev-parse",
        "--verify",
        "--end-of-options",
        `${input.baseRef}^{commit}`,
      ]);
      if (base.exitCode !== 0) {
        // A base the repository has never seen is not a failure of the run: it
        // is a base that cannot be compared against, and the caller is told so.
        return { status: "ready", head: headOid, ahead: 0, behind: 0, mergeability: "unknown" };
      }
      const baseOid = base.stdout.trim();
      const counts = await run([
        "rev-list",
        "--left-right",
        "--count",
        "--end-of-options",
        `${baseOid}...${headOid}`,
      ]);
      if (counts.exitCode !== 0) return { status: "unavailable" };
      const [behindText, aheadText] = counts.stdout.trim().split(/\s+/);
      const behind = Number.parseInt(behindText ?? "", 10);
      const ahead = Number.parseInt(aheadText ?? "", 10);
      if (!Number.isSafeInteger(behind) || !Number.isSafeInteger(ahead)) {
        return { status: "unavailable" };
      }
      const mergeability =
        ahead === 0
          ? ("nothing-to-merge" as const)
          : await this.#mergeability(checkoutRoot, baseOid, headOid, signal);
      return { status: "ready", head: headOid, base: baseOid, ahead, behind, mergeability };
    } catch {
      return { status: "unavailable" };
    }
  }

  async #mergeability(
    checkoutRoot: string,
    baseOid: string,
    headOid: string,
    signal?: AbortSignal,
  ): Promise<"clean" | "conflicts" | "unknown"> {
    const result = await this.#run(
      ["-C", checkoutRoot, "merge-tree", "--write-tree", "--end-of-options", baseOid, headOid],
      signal,
    );
    // `merge-tree --write-tree` exits 0 for a clean merge and 1 for conflicts.
    // Anything else is a Git that could not answer — an older one, or a
    // repository state it refused to read — and is reported as such.
    if (result.exitCode === 0) return "clean";
    if (result.exitCode === 1) return "conflicts";
    return "unknown";
  }

  async #run(args: readonly string[], parentSignal?: AbortSignal): Promise<CommandResult> {
    const controller = new AbortController();
    const abort = () => controller.abort();
    parentSignal?.addEventListener("abort", abort, { once: true });
    if (parentSignal?.aborted) controller.abort();
    const timeout = setTimeout(abort, this.#commandTimeoutMs);
    try {
      if (controller.signal.aborted) throw new Error("Git observation aborted");
      const checkoutRoot = args[0] === "-C" ? args[1] : undefined;
      if (checkoutRoot === undefined || !isAbsolute(checkoutRoot)) {
        return { exitCode: 1, stdout: "" };
      }
      const launch = prepareGitSeatbeltLaunch({
        confinement: this.#confinement.confinement,
        gitExecutable: this.#confinement.gitExecutable,
        checkoutRoot,
        args,
        temporaryDirectory: this.#confinement.temporaryDirectory,
        networkEgress: this.#confinement.networkEgress,
      });
      return await this.#dependencies.execFile(
        launch.command,
        launch.args,
        createGitCommandEnvironment(process.env),
        controller.signal,
      );
    } catch (error) {
      if (error instanceof SeatbeltConfinementError) return { exitCode: 1, stdout: "" };
      throw error;
    } finally {
      clearTimeout(timeout);
      parentSignal?.removeEventListener("abort", abort);
    }
  }
}

async function readRemotes(
  run: (args: readonly string[]) => Promise<CommandResult>,
): Promise<GitObservation["remotes"] | undefined> {
  const remoteNamesResult = await run(["remote"]);
  if (remoteNamesResult.exitCode !== 0) return undefined;
  const remoteNames = remoteNamesResult.stdout.split("\n").filter(Boolean).sort();
  if (remoteNames.length > MAX_OBSERVED_REMOTES) return undefined;
  const remotes: Array<GitObservation["remotes"][number]> = [];
  for (const name of remoteNames) {
    if (!/^[A-Za-z0-9._-]+$/.test(name)) return undefined;
    const fetch = await run(["remote", "get-url", "--", name]);
    const push = await run(["remote", "get-url", "--push", "--", name]);
    if (fetch.exitCode !== 0 || push.exitCode !== 0) return undefined;
    const fetchUrl = fetch.stdout.trim();
    const pushUrl = push.stdout.trim();
    const credentialed = containsRemoteCredentials(fetchUrl) || containsRemoteCredentials(pushUrl);
    remotes.push({
      name,
      fetchUrl: redactUrl(fetchUrl),
      pushUrl: redactUrl(pushUrl),
      ...(credentialed ? { credentialed: true } : {}),
    });
  }
  return remotes;
}

/** Shared with the environment port so one reading of `--numstat` is parsed one way. */
export function parseNumstat(
  output: string,
): { readonly insertions: number; readonly deletions: number } | undefined {
  if (output.length === 0) return { insertions: 0, deletions: 0 };
  const fields = output.split("\0");
  if (fields[fields.length - 1] === "") fields.pop();
  let insertions = 0;
  let deletions = 0;
  for (let index = 0; index < fields.length;) {
    const field = fields[index];
    if (field === undefined) return undefined;
    const firstTab = field.indexOf("\t");
    if (firstTab <= 0) return undefined;
    const secondTab = field.indexOf("\t", firstTab + 1);
    const addedText = field.slice(0, firstTab);
    const deletedText =
      secondTab === -1 ? field.slice(firstTab + 1) : field.slice(firstTab + 1, secondTab);
    const added = parseNumstatCount(addedText);
    const deleted = parseNumstatCount(deletedText);
    if (added === undefined || deleted === undefined) return undefined;
    const nextInsertions = insertions + added;
    const nextDeletions = deletions + deleted;
    if (!Number.isSafeInteger(nextInsertions) || !Number.isSafeInteger(nextDeletions)) {
      return undefined;
    }
    insertions = nextInsertions;
    deletions = nextDeletions;
    // Rename/copy with `-z` is `added\tdeleted\t\0from\0to\0` (and sometimes
    // without the trailing tab). A regular path stays in the same field.
    const renamed = secondTab === -1 || secondTab === field.length - 1;
    if (renamed) {
      if (fields[index + 1] === undefined || fields[index + 2] === undefined) return undefined;
      index += 3;
    } else {
      index += 1;
    }
  }
  return { insertions, deletions };
}

function parseNumstatCount(text: string): number | undefined {
  if (text === "-") return 0;
  // `parseInt` accepts numeric prefixes such as "12invalid". A ready
  // observation cannot invent or undercount totals from a malformed token.
  if (!/^\d+$/.test(text)) return undefined;
  const value = Number.parseInt(text, 10);
  return Number.isSafeInteger(value) ? value : undefined;
}

function parseStatus(output: string): GitStatusEntry[] | undefined {
  const fields = output.split("\0");
  fields.pop();
  const entries: GitStatusEntry[] = [];
  for (let index = 0; index < fields.length; index += 1) {
    const field = fields[index]!;
    if (field.length < 4 || field[2] !== " ") return undefined;
    const entry: GitStatusEntry = {
      path: field.slice(3),
      index: field[0]!,
      worktree: field[1]!,
    };
    if (!entry.path || entry.path.includes("\0")) return undefined;
    if (entry.index === "R" || entry.index === "C") {
      const originalPath = fields[index + 1];
      if (!originalPath) return undefined;
      entries.push({ ...entry, originalPath });
      index += 1;
    } else entries.push(entry);
  }
  return entries.sort((left, right) => left.path.localeCompare(right.path));
}

function parseWorktrees(output: string): GitObservation["worktrees"] | undefined {
  const entries = [];
  for (const stanza of output.split("\0\0").filter(Boolean)) {
    const values = stanza.split("\0").filter(Boolean);
    const path = values.find((value) => value.startsWith("worktree "))?.slice(9);
    if (!path) return undefined;
    const head = values.find((value) => value.startsWith("HEAD "))?.slice(5) ?? null;
    const branch = values.find((value) => value.startsWith("branch "))?.slice(7) ?? null;
    entries.push({
      path,
      head,
      branch,
      detached: values.includes("detached"),
      bare: values.includes("bare"),
      locked: values.some((value) => value === "locked" || value.startsWith("locked ")),
      prunable: values.some((value) => value === "prunable" || value.startsWith("prunable ")),
    });
  }
  return entries;
}

function boundUtf8(value: string, maximum: number): GitObservation["diff"] {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length <= maximum) return { text: value, byteLength: bytes.length, truncated: false };
  let end = maximum;
  while (end > 0 && (bytes[end] ?? 0) >= 0x80 && (bytes[end] ?? 0) < 0xc0) end -= 1;
  const text = bytes.subarray(0, end).toString("utf8");
  return { text, byteLength: Buffer.byteLength(text), truncated: true };
}

function redactUrl(value: string): string {
  try {
    const url = new URL(value);
    if (!url.username && !url.password) return value;
    url.username = "";
    url.password = "";
    return url.toString();
  } catch {
    return value.replace(/^(https?:\/\/)[^/@]+@/i, "$1");
  }
}

function containsRemoteCredentials(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.password !== "") return true;
    return url.protocol === "https:"
      ? url.username !== ""
      : url.username !== "" && url.username !== "git";
  } catch {
    // SCP-style git@github.com remotes are conventional transport syntax, not
    // credentials. Unknown forms are left to the identity parser to reject.
    return false;
  }
}
