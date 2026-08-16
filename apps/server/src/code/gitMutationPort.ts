import { execFile as nodeExecFile } from "node:child_process";
import { access } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { createGitCommandEnvironment } from "../gitEnvironmentPort";
import {
  createGitSeatbeltConfinement,
  prepareGitSeatbeltLaunch,
  type GitSeatbeltPortOptions,
} from "../process/gitSeatbeltLaunch";
import { SeatbeltConfinementError } from "../process/seatbeltProfile";
import type { GitStatusEntry } from "./gitObservationPort";

interface CommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface GitMutationDependencies {
  readonly execFile: (
    file: string,
    args: readonly string[],
    environment: NodeJS.ProcessEnv,
    signal: AbortSignal,
  ) => Promise<CommandResult>;
  readonly pathExists: (path: string) => Promise<boolean>;
}

export type GitMutationResult =
  | { readonly status: "applied"; readonly oid?: string }
  | {
      readonly status: "rejected";
      readonly reason:
        | "index-locked"
        | "invalid-paths"
        | "invalid-message"
        | "invalid-commit"
        | "empty-staged-summary"
        | "invalid-remote"
        | "invalid-refspec"
        | "unconfirmed-target";
    }
  | { readonly status: "failed" };

const liveDependencies: GitMutationDependencies = {
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
          maxBuffer: 1024 * 1024,
        },
        (error, stdout, stderr) => {
          resolve({
            exitCode: error && typeof error.code === "number" ? error.code : error ? 1 : 0,
            stdout,
            stderr,
          });
        },
      );
    }),
  pathExists: async (path) => {
    try {
      await access(path);
      return true;
    } catch (error) {
      return isRecord(error) && error.code === "ENOENT" ? false : Promise.reject(error);
    }
  },
};

export class GitMutationPort {
  readonly #dependencies: GitMutationDependencies;
  readonly #commandTimeoutMs: number;
  readonly #confinement: ReturnType<typeof createGitSeatbeltConfinement>;

  constructor(
    dependencies: GitMutationDependencies = liveDependencies,
    options: { readonly commandTimeoutMs?: number } & GitSeatbeltPortOptions = {},
  ) {
    this.#dependencies = dependencies;
    this.#commandTimeoutMs = options.commandTimeoutMs ?? 15_000;
    this.#confinement = createGitSeatbeltConfinement(options);
  }

  async stage(
    input: { readonly checkoutRoot: string; readonly paths: readonly string[] },
    signal?: AbortSignal,
  ): Promise<GitMutationResult> {
    if (!validPaths(input.paths)) return { status: "rejected", reason: "invalid-paths" };
    const lock = await this.#lockState(input.checkoutRoot, signal);
    if (lock === "failed") return { status: "failed" };
    if (lock === "locked") return { status: "rejected", reason: "index-locked" };
    return this.#apply(input.checkoutRoot, ["add", "--", ...input.paths], signal);
  }

  async commit(
    input: {
      readonly checkoutRoot: string;
      readonly message: string;
      readonly stagedSummary: readonly GitStatusEntry[];
    },
    signal?: AbortSignal,
  ): Promise<GitMutationResult> {
    if (!validMessage(input.message)) return { status: "rejected", reason: "invalid-message" };
    if (input.stagedSummary.length === 0)
      return { status: "rejected", reason: "empty-staged-summary" };
    const lock = await this.#lockState(input.checkoutRoot, signal);
    if (lock === "failed") return { status: "failed" };
    if (lock === "locked") return { status: "rejected", reason: "index-locked" };
    const result = await this.#run(
      ["-C", input.checkoutRoot, "commit", "--message", input.message],
      signal,
    );
    if (result.exitCode !== 0) return { status: "failed" };
    const head = await this.#run(
      ["-C", input.checkoutRoot, "rev-parse", "--verify", "HEAD"],
      signal,
    );
    const oid = head.stdout.trim();
    return head.exitCode === 0 && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(oid)
      ? { status: "applied", oid }
      : { status: "failed" };
  }

  async push(
    input: {
      readonly checkoutRoot: string;
      readonly remote: string;
      readonly localRef: string;
      readonly remoteRef: string;
      readonly confirmation: {
        readonly remote: string;
        readonly refspec: string;
      };
    },
    signal?: AbortSignal,
  ): Promise<GitMutationResult> {
    if (!/^[A-Za-z0-9._-]+$/.test(input.remote))
      return { status: "rejected", reason: "invalid-remote" };
    if (!validBranchRef(input.localRef) || !validBranchRef(input.remoteRef))
      return { status: "rejected", reason: "invalid-refspec" };
    const refspec = `${input.localRef}:${input.remoteRef}`;
    if (input.confirmation.remote !== input.remote || input.confirmation.refspec !== refspec)
      return { status: "rejected", reason: "unconfirmed-target" };
    const lock = await this.#lockState(input.checkoutRoot, signal);
    if (lock === "failed") return { status: "failed" };
    if (lock === "locked") return { status: "rejected", reason: "index-locked" };
    return this.#apply(
      input.checkoutRoot,
      ["push", "--porcelain", "--", input.remote, refspec],
      signal,
    );
  }

  async revertCommit(
    input: { readonly checkoutRoot: string; readonly oid: string },
    signal?: AbortSignal,
  ): Promise<GitMutationResult> {
    if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(input.oid))
      return { status: "rejected", reason: "invalid-commit" };
    const lock = await this.#lockState(input.checkoutRoot, signal);
    if (lock === "failed") return { status: "failed" };
    if (lock === "locked") return { status: "rejected", reason: "index-locked" };
    const result = await this.#run(
      ["-C", input.checkoutRoot, "revert", "--no-edit", "--", input.oid],
      signal,
    );
    if (result.exitCode !== 0) return { status: "failed" };
    const head = await this.#run(
      ["-C", input.checkoutRoot, "rev-parse", "--verify", "HEAD"],
      signal,
    );
    const oid = head.stdout.trim();
    return head.exitCode === 0 && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(oid)
      ? { status: "applied", oid }
      : { status: "failed" };
  }

  async #indexLocked(checkoutRoot: string, signal?: AbortSignal): Promise<boolean> {
    const path = await this.#run(
      ["-C", checkoutRoot, "rev-parse", "--path-format=absolute", "--git-path", "index.lock"],
      signal,
    );
    if (path.exitCode !== 0 || !isAbsolute(path.stdout.trim()))
      throw new Error("Git index lock state is unavailable.");
    return this.#dependencies.pathExists(path.stdout.trim());
  }

  async #lockState(
    checkoutRoot: string,
    signal?: AbortSignal,
  ): Promise<"clear" | "locked" | "failed"> {
    try {
      return (await this.#indexLocked(checkoutRoot, signal)) ? "locked" : "clear";
    } catch {
      return "failed";
    }
  }

  async #apply(
    checkoutRoot: string,
    args: readonly string[],
    signal?: AbortSignal,
  ): Promise<GitMutationResult> {
    const result = await this.#run(["-C", checkoutRoot, ...args], signal);
    return result.exitCode === 0 ? { status: "applied" } : { status: "failed" };
  }

  async #run(args: readonly string[], parentSignal?: AbortSignal): Promise<CommandResult> {
    const controller = new AbortController();
    const abort = () => controller.abort();
    parentSignal?.addEventListener("abort", abort, { once: true });
    if (parentSignal?.aborted) controller.abort();
    const timeout = setTimeout(abort, this.#commandTimeoutMs);
    try {
      if (controller.signal.aborted) throw new Error("Git mutation aborted.");
      const checkoutRoot = args[0] === "-C" ? args[1] : undefined;
      if (checkoutRoot === undefined || !isAbsolute(checkoutRoot)) {
        return { exitCode: 1, stdout: "", stderr: "" };
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
      if (error instanceof SeatbeltConfinementError) {
        return { exitCode: 1, stdout: "", stderr: "" };
      }
      throw error;
    } finally {
      clearTimeout(timeout);
      parentSignal?.removeEventListener("abort", abort);
    }
  }
}

function validPaths(paths: readonly string[]): boolean {
  return (
    paths.length > 0 &&
    new Set(paths).size === paths.length &&
    paths.every(
      (path) =>
        path.length > 0 &&
        path.length <= 4_096 &&
        !isAbsolute(path) &&
        !path.includes("\0") &&
        !path.includes("\\") &&
        !path.split("/").some((part) => part === "" || part === "." || part === "..") &&
        !path.startsWith("-"),
    )
  );
}

function validMessage(message: string): boolean {
  return (
    message.trim().length > 0 &&
    Buffer.byteLength(message, "utf8") <= 64 * 1024 &&
    !message.includes("\0")
  );
}

function validBranchRef(ref: string): boolean {
  return (
    /^refs\/heads\/[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(ref) &&
    !ref.includes("..") &&
    !ref.includes("//") &&
    !ref.endsWith("/") &&
    !ref.includes("@{")
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
