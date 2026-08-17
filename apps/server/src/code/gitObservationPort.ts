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
      const head: GitObservedHead =
        resolvedOid === undefined
          ? { kind: "unborn", name: branchName! }
          : branchName === undefined
            ? { kind: "detached", oid: resolvedOid }
            : { kind: "branch", name: branchName, oid: resolvedOid };
      const statusResult = await run([
        "status",
        "--porcelain=v1",
        "-z",
        "--untracked-files=normal",
      ]);
      if (statusResult.exitCode !== 0) return { status: "failed" };
      const statusEntries = parseStatus(statusResult.stdout);
      if (!statusEntries) return { status: "failed" };
      // An unborn head has no commit to diff against, so the index itself is
      // the whole difference from the empty tree.
      const diffResult = await run(
        head.kind === "unborn"
          ? ["diff", "--no-ext-diff", "--no-color", "--cached", "--"]
          : ["diff", "--no-ext-diff", "--no-color", "HEAD", "--"],
      );
      if (diffResult.exitCode !== 0) return { status: "failed" };
      const diff = boundUtf8(diffResult.stdout, this.#maxDiffBytes);
      const remoteNamesResult = await run(["remote"]);
      if (remoteNamesResult.exitCode !== 0) return { status: "failed" };
      const remotes = [];
      for (const name of remoteNamesResult.stdout.split("\n").filter(Boolean).sort()) {
        if (!/^[A-Za-z0-9._-]+$/.test(name)) return { status: "failed" };
        const fetch = await run(["remote", "get-url", "--", name]);
        const push = await run(["remote", "get-url", "--push", "--", name]);
        if (fetch.exitCode !== 0 || push.exitCode !== 0) return { status: "failed" };
        remotes.push({
          name,
          fetchUrl: redactUrl(fetch.stdout.trim()),
          pushUrl: redactUrl(push.stdout.trim()),
        });
      }
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
