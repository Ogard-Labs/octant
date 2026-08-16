import { execFile as nodeExecFile } from "node:child_process";
import { realpath, stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import {
  createGitSeatbeltConfinement,
  prepareGitSeatbeltLaunch,
  type GitSeatbeltPortOptions,
} from "./process/gitSeatbeltLaunch";
import { SeatbeltConfinementError } from "./process/seatbeltProfile";

export type GitEnvironmentResult =
  | {
      readonly status: "ready";
      readonly repositoryRoot: string;
      readonly worktreeRoot: string;
      readonly branch:
        | { readonly kind: "named"; readonly name: string }
        | { readonly kind: "detached"; readonly oid: string };
      readonly changes: "clean" | "dirty";
    }
  | { readonly status: "unavailable" }
  | { readonly status: "failed" };

interface CommandResult {
  readonly exitCode: number;
  readonly stdout: string;
}

interface WorktreeEntry {
  readonly path: string;
  readonly prunable: boolean;
}

export interface GitEnvironmentDependencies {
  readonly realpath: (path: string) => Promise<string>;
  readonly stat: (path: string) => Promise<{ isDirectory(): boolean }>;
  readonly execFile: (
    file: string,
    args: readonly string[],
    environment: NodeJS.ProcessEnv,
    signal: AbortSignal,
  ) => Promise<CommandResult>;
}

const DEFAULT_COMMAND_TIMEOUT_MS = 5_000;

const liveDependencies: GitEnvironmentDependencies = {
  realpath,
  stat,
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
          killSignal: "SIGKILL",
          windowsHide: true,
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

const GIT_ENVIRONMENT_ALLOWLIST = [
  "PATH",
  "HOME",
  "TMPDIR",
  "TEMP",
  "TMP",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "XDG_CONFIG_HOME",
] as const;

export function createGitCommandEnvironment(inherited: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    GIT_TERMINAL_PROMPT: "0",
    GCM_INTERACTIVE: "Never",
    GIT_OPTIONAL_LOCKS: "0",
  };
  for (const name of GIT_ENVIRONMENT_ALLOWLIST) {
    const value = inherited[name];
    if (value !== undefined) environment[name] = value;
  }
  return environment;
}

function parseWorktreeEntries(output: string): ReadonlyArray<WorktreeEntry> | undefined {
  const value = output.trim();
  if (value === "") return [];
  const entries: WorktreeEntry[] = [];
  for (const stanza of value.split(/\n\s*\n/)) {
    const lines = stanza.split("\n");
    const first = lines[0];
    if (first === undefined || !first.startsWith("worktree ")) return undefined;
    const path = first.slice("worktree ".length).trim();
    if (path === "" || lines.slice(1).some((line) => line.startsWith("worktree ")))
      return undefined;
    entries.push({
      path,
      prunable: lines.slice(1).some((line) => line === "prunable" || line.startsWith("prunable ")),
    });
  }
  return entries;
}

export class GitEnvironmentPort {
  readonly #dependencies: GitEnvironmentDependencies;
  readonly #commandTimeoutMs: number;
  readonly #activeObservations = new Set<AbortController>();
  readonly #activeCommands = new Set<Promise<CommandResult>>();
  readonly #confinement: ReturnType<typeof createGitSeatbeltConfinement>;
  #closed = false;

  constructor(
    dependencies: GitEnvironmentDependencies = liveDependencies,
    options: { readonly commandTimeoutMs?: number } & GitSeatbeltPortOptions = {},
  ) {
    this.#dependencies = dependencies;
    this.#commandTimeoutMs = options.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
    this.#confinement = createGitSeatbeltConfinement(options);
  }

  async observe(root: string, signal?: AbortSignal): Promise<GitEnvironmentResult> {
    if (this.#closed) return { status: "failed" };
    const observation = new AbortController();
    const abort = () => observation.abort();
    if (signal?.aborted === true) abort();
    else signal?.addEventListener("abort", abort, { once: true });
    this.#activeObservations.add(observation);

    try {
      return await this.#observe(root, observation.signal);
    } finally {
      signal?.removeEventListener("abort", abort);
      this.#activeObservations.delete(observation);
    }
  }

  async close(): Promise<void> {
    this.#closed = true;
    for (const observation of this.#activeObservations) observation.abort();
    await Promise.allSettled(this.#activeCommands);
  }

  async #observe(root: string, signal: AbortSignal): Promise<GitEnvironmentResult> {
    if (signal.aborted) return { status: "failed" };
    let canonicalRoot: string;
    try {
      canonicalRoot = await this.#dependencies.realpath(root);
      const details = await this.#dependencies.stat(canonicalRoot);
      if (!details.isDirectory()) return { status: "unavailable" };
    } catch {
      return { status: "unavailable" };
    }

    const run = (args: readonly string[]) => this.#run(args, signal);

    let topLevel: CommandResult;
    try {
      topLevel = await run(["-C", canonicalRoot, "rev-parse", "--show-toplevel"]);
    } catch {
      return { status: "unavailable" };
    }
    if (topLevel.exitCode !== 0 || !topLevel.stdout.trim()) return { status: "unavailable" };

    try {
      const canonicalTopLevel = await this.#dependencies.realpath(topLevel.stdout.trim());
      const worktrees = await run(["-C", canonicalRoot, "worktree", "list", "--porcelain"]);
      if (worktrees.exitCode !== 0) return { status: "failed" };

      const worktreeEntries = parseWorktreeEntries(worktrees.stdout);
      if (worktreeEntries === undefined || worktreeEntries.length === 0)
        return { status: "failed" };

      const repositoryRoot = await this.#dependencies.realpath(worktreeEntries[0]!.path);
      let worktreeRoot: string | undefined;
      for (const entry of worktreeEntries) {
        try {
          const canonicalEntry = await this.#dependencies.realpath(entry.path);
          if (canonicalEntry === canonicalTopLevel) worktreeRoot = canonicalEntry;
        } catch {
          if (!entry.prunable) return { status: "failed" };
        }
      }
      if (!repositoryRoot || !worktreeRoot) return { status: "failed" };

      const symbolic = await run([
        "-C",
        canonicalRoot,
        "symbolic-ref",
        "--quiet",
        "--short",
        "HEAD",
      ]);
      let branch:
        | { readonly kind: "named"; readonly name: string }
        | {
            readonly kind: "detached";
            readonly oid: string;
          };
      if (symbolic.exitCode === 0) {
        const name = symbolic.stdout.trim();
        if (!name) return { status: "failed" };
        branch = { kind: "named", name };
      } else if (symbolic.exitCode === 1) {
        const oid = await run(["-C", canonicalRoot, "rev-parse", "--verify", "HEAD"]);
        const identity = oid.stdout.trim();
        if (oid.exitCode !== 0 || !/^[0-9a-f]{40}$/.test(identity)) return { status: "failed" };
        branch = { kind: "detached", oid: identity };
      } else return { status: "failed" };

      const status = await run([
        "-C",
        canonicalRoot,
        "status",
        "--porcelain=v1",
        "--untracked-files=normal",
      ]);
      if (status.exitCode !== 0) return { status: "failed" };

      return {
        status: "ready",
        repositoryRoot,
        worktreeRoot,
        branch,
        changes: status.stdout.trim() ? "dirty" : "clean",
      };
    } catch {
      return { status: "failed" };
    }
  }

  async #run(args: readonly string[], observationSignal: AbortSignal): Promise<CommandResult> {
    if (observationSignal.aborted) return { exitCode: -1, stdout: "" };
    const command = new AbortController();
    const abort = () => command.abort();
    observationSignal.addEventListener("abort", abort, { once: true });
    const timeout = setTimeout(abort, this.#commandTimeoutMs);
    const aborted = new Promise<CommandResult>((resolve) => {
      command.signal.addEventListener("abort", () => resolve({ exitCode: -1, stdout: "" }), {
        once: true,
      });
    });
    const execution = Promise.resolve()
      .then(() => {
        const checkoutRoot = args[0] === "-C" ? args[1] : undefined;
        if (checkoutRoot === undefined || !isAbsolute(checkoutRoot)) {
          throw new SeatbeltConfinementError(
            "invalid-configuration",
            "Git environment commands require an absolute -C checkout root.",
          );
        }
        const launch = prepareGitSeatbeltLaunch({
          confinement: this.#confinement.confinement,
          gitExecutable: this.#confinement.gitExecutable,
          checkoutRoot,
          args,
          temporaryDirectory: this.#confinement.temporaryDirectory,
          networkEgress: this.#confinement.networkEgress,
        });
        return this.#dependencies.execFile(
          launch.command,
          launch.args,
          createGitCommandEnvironment(process.env),
          command.signal,
        );
      })
      .catch(() => ({ exitCode: -1, stdout: "" }));
    this.#activeCommands.add(execution);
    try {
      const result = await Promise.race([execution, aborted]);
      if (!command.signal.aborted) return result;
      await execution;
      return { exitCode: -1, stdout: "" };
    } finally {
      clearTimeout(timeout);
      observationSignal.removeEventListener("abort", abort);
      this.#activeCommands.delete(execution);
    }
  }
}
