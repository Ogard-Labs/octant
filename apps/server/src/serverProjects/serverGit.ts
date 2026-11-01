import { GitMutationPort, type CommitIdentityResolver } from "../code/gitMutationPort";
import { GitObservationPort } from "../code/gitObservationPort";
import { GitService } from "../code/gitService";
import type { ServerAddress, ServerConnection } from "./serverConnection";

/**
 * Git for a server Project's panels: the host's own Git service, every
 * command of which runs on the server. Canonical:
 * docs/design/server-projects.md § Panels.
 *
 * Only `git` and the file tools a mutation uses (`cp`, `rm`) are run, by
 * name on the server, with an environment of this host's Git switches and
 * nothing else. A command that names a scratch directory of this host is
 * refused rather than handed to a server that cannot read it. A call that
 * cannot reach the server runs nothing and reads as a failed command, so the
 * panel says Git is unavailable; it never falls back to this host.
 */

const SERVER_PROGRAMS: ReadonlySet<string> = new Set([
  "git",
  "/bin/cp",
  "/usr/bin/cp",
  "/bin/rm",
  "/usr/bin/rm",
]);

/** The variables a server's Git is given, all switches with no path of this host. */
const FORWARDED_VARIABLES: ReadonlySet<string> = new Set([
  "GIT_TERMINAL_PROMPT",
  "GCM_INTERACTIVE",
  "GIT_OPTIONAL_LOCKS",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
]);

/** Variables that name a file or folder of this host, which a server cannot follow. */
const HOST_PATH_VARIABLES = ["GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_DIR", "GIT_WORK_TREE"];

const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
/** Each command is its own login on the server, so it gets longer than a local one. */
const OBSERVATION_TIMEOUT_MS = 30_000;
const MUTATION_TIMEOUT_MS = 120_000;

interface ServerCommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface ServerGitOptions {
  readonly connection: Pick<ServerConnection, "run">;
  /** The server, read each call so a server removed from the registry refuses. */
  readonly server: () => ServerAddress | undefined;
  readonly commitIdentity?: CommitIdentityResolver;
}

export function createServerGitService(options: ServerGitOptions): GitService {
  const execFile = async (
    file: string,
    args: readonly string[],
    environment: NodeJS.ProcessEnv,
    signal: AbortSignal,
  ): Promise<ServerCommandResult> => {
    const server = options.server();
    if (server === undefined) {
      return { exitCode: 1, stdout: "", stderr: "The server is no longer registered." };
    }
    if (!SERVER_PROGRAMS.has(file) || HOST_PATH_VARIABLES.some((name) => name in environment)) {
      return { exitCode: 1, stdout: "", stderr: "That Git step cannot run on a server." };
    }
    const variables = Object.entries(environment).flatMap(([name, value]) =>
      FORWARDED_VARIABLES.has(name) && value !== undefined ? [`${name}=${value}`] : [],
    );
    const call = await options.connection.run(server, {
      script: `export PAGER=cat GIT_PAGER=cat; exec env "$@"`,
      args: [...variables, file, ...args],
      timeoutMs: MUTATION_TIMEOUT_MS,
      maxOutputBytes: MAX_OUTPUT_BYTES,
      signal,
    });
    if (call.status === "ran") {
      // A cut-off listing would parse as a shorter one, so it fails instead.
      return call.truncated
        ? { exitCode: 1, stdout: "", stderr: "Git's output was too large to read." }
        : {
            exitCode: call.exitCode,
            stdout: call.output.toString("utf8"),
            stderr: call.errorOutput,
          };
    }
    if (call.status === "unreachable") {
      return {
        exitCode: 1,
        stdout: "",
        stderr: `The server could not be reached (${call.message}), so nothing ran.`,
      };
    }
    // As a local Git command that is stopped, this is a failed command, not a
    // throw. Stopping ends the connection; a Git step already running on the
    // server may still finish there, which the next observation shows.
    return {
      exitCode: 1,
      stdout: "",
      stderr:
        call.status === "timed-out"
          ? "Git on the server took too long, so Octant stopped waiting. Refresh to see what it did."
          : "Git on the server was cancelled.",
    };
  };
  const observation = new GitObservationPort(
    { onServer: true, commandTimeoutMs: OBSERVATION_TIMEOUT_MS },
    {
      realpath: (path) => serverRealpath(options, path),
      execFile,
    },
  );
  const mutation = new GitMutationPort(
    {
      execFile,
      pathExists: (path) => serverPathExists(options, path),
    },
    {
      onServer: true,
      commandTimeoutMs: MUTATION_TIMEOUT_MS,
      ...(options.commitIdentity === undefined ? {} : { commitIdentity: options.commitIdentity }),
    },
  );
  return new GitService(observation, mutation);
}

/** The folder's real path on the server; a folder that cannot be resolved throws, as `realpath` does. */
async function serverRealpath(options: ServerGitOptions, path: string): Promise<string> {
  const server = options.server();
  if (server === undefined) throw new Error("The server is no longer registered.");
  const call = await options.connection.run(server, {
    script: `cd -- "$1" && pwd -P`,
    args: [path],
    timeoutMs: OBSERVATION_TIMEOUT_MS,
    maxOutputBytes: 64 * 1024,
  });
  const resolved =
    call.status === "ran" && call.exitCode === 0
      ? call.output.toString("utf8").replace(/\n$/, "")
      : "";
  if (!resolved.startsWith("/")) throw new Error("The folder could not be resolved on the server.");
  return resolved;
}

/** Whether a path exists on the server; a server that cannot be reached throws rather than answering no. */
async function serverPathExists(options: ServerGitOptions, path: string): Promise<boolean> {
  const server = options.server();
  if (server === undefined) throw new Error("The server is no longer registered.");
  const call = await options.connection.run(server, {
    script: `[ -e "$1" ] || [ -L "$1" ]`,
    args: [path],
    timeoutMs: OBSERVATION_TIMEOUT_MS,
    maxOutputBytes: 1024,
  });
  if (call.status !== "ran") throw new Error("The server could not be reached.");
  return call.exitCode === 0;
}
