import { posix } from "node:path";
import {
  MAX_REPOSITORY_TEST_OUTPUT_BYTES,
  type CodeRepositoryTestDefinition,
  type CodeRepositoryTestRun,
} from "@octant/contracts";
import type { CodeOperationRepositoryTestPort } from "../code/codeOperationService";
import {
  MAX_TEST_SOURCE_BYTES,
  OCTANT_TESTS_PATH,
  PACKAGE_JSON_PATH,
  RepositoryTestDiscoveryService,
} from "../code/repositoryTestDiscoveryService";
import {
  RepositoryTestRunner,
  type RepositoryTestProcessResult,
} from "../code/repositoryTestRunner";
import type { ServerCodeFiles } from "./serverCodeFiles";
import type { ServerAddress, ServerConnection } from "./serverConnection";

/**
 * The Tests panel on a server Project's folder. Canonical:
 * docs/design/server-projects.md § Panels.
 *
 * Discovery reads the folder's `package.json` and `.octant/tests.json`
 * through the file browser's reads, so the same containment and credential
 * guard apply. A run is the discovered argv, run on a terminal on the server
 * in the folder, so a cancelled or timed-out run is hung up with its
 * connection; Octant has no sandbox there, so the level's approval asked
 * before this runs is the guard. Every run is journaled as a command on the
 * server. A run that cannot reach the server is unavailable and runs nothing
 * on this host.
 */

/** Runs argv `$2…` in folder `$1`, with pagers off so nothing waits on the terminal. */
const RUN_SCRIPT = `cd -- "$1" || exit 126
shift
export PAGER=cat GIT_PAGER=cat TERM=dumb CI=1
exec "$@"`;

const HEAD_SCRIPT = `cd -- "$1" && git rev-parse --verify HEAD 2>/dev/null`;
const REALPATH_SCRIPT = `cd -- "$1" && pwd -P`;
const CALL_TIMEOUT_MS = 30_000;

export interface ServerRepositoryTestsOptions {
  readonly connection: Pick<ServerConnection, "run">;
  /** Read each call, so a server removed from the registry refuses the next one. */
  readonly server: () => (ServerAddress & { readonly serverId: string }) | undefined;
  readonly root: string;
  readonly files: Pick<ServerCodeFiles, "readText" | "read">;
  readonly record: (input: {
    readonly threadId: string;
    readonly serverId: string;
    readonly alias: string;
    readonly command: string;
    readonly status: "ran" | "timed-out" | "cancelled" | "unavailable";
    readonly exitCode?: number | undefined;
  }) => "recorded" | "unavailable";
  readonly now: () => string;
  readonly newId: () => string;
}

export type ServerRepositoryTests = CodeOperationRepositoryTestPort & {
  /** The folder's checked-out commit on the server, or undefined when it is not a Git repository or unreachable. */
  readonly head: () => Promise<string | undefined>;
};

/** The tests a server folder's `package.json` and `.octant/tests.json` offer, read on the server. */
export async function discoverServerTests(
  files: Pick<ServerCodeFiles, "readText">,
  checkoutId: string,
): Promise<ReadonlyArray<CodeRepositoryTestDefinition>> {
  const readJson = async (path: string): Promise<unknown> => {
    const text = await files.readText(path, MAX_TEST_SOURCE_BYTES);
    if (text === undefined) return undefined;
    try {
      return JSON.parse(text);
    } catch {
      return undefined;
    }
  };
  return discovery.fromSources(checkoutId, {
    packageJson: await readJson(PACKAGE_JSON_PATH),
    octantFile: await readJson(OCTANT_TESTS_PATH),
  });
}

const discovery = new RepositoryTestDiscoveryService();

export function createServerRepositoryTests(
  options: ServerRepositoryTestsOptions,
): ServerRepositoryTests {
  const active = new Map<
    string,
    { readonly threadId: string; readonly checkoutId: string; readonly controller: AbortController }
  >();
  const call = async (script: string, args: ReadonlyArray<string>) => {
    const server = options.server();
    if (server === undefined) return undefined;
    const result = await options.connection.run(server, {
      script,
      args,
      timeoutMs: CALL_TIMEOUT_MS,
      maxOutputBytes: 64 * 1024,
    });
    return result.status === "ran" && result.exitCode === 0
      ? result.output.toString("utf8").replace(/\n$/, "")
      : undefined;
  };
  const runOn = (threadId: string) =>
    new RepositoryTestRunner({
      realpath: async (path) => {
        const resolved = await call(REALPATH_SCRIPT, [path]);
        if (resolved === undefined || !posix.isAbsolute(resolved)) {
          throw new Error("The folder could not be resolved on the server.");
        }
        return resolved;
      },
      execute: async (input, signal) => {
        const server = options.server();
        if (server === undefined) return unavailable();
        const ran = await options.connection.run(server, {
          script: RUN_SCRIPT,
          args: [input.cwd, ...input.argv],
          terminal: true,
          timeoutMs: input.timeoutMs,
          maxOutputBytes: MAX_REPOSITORY_TEST_OUTPUT_BYTES,
          ...(signal === undefined ? {} : { signal }),
        });
        const status = ran.status === "unreachable" ? "unavailable" : ran.status;
        options.record({
          threadId,
          serverId: server.serverId,
          alias: server.alias,
          command: input.argv.join(" "),
          status,
          ...(ran.status === "ran" ? { exitCode: ran.exitCode } : {}),
        });
        if (ran.status === "unreachable") return unavailable();
        return {
          termination:
            ran.status === "ran"
              ? "exited"
              : ran.status === "timed-out"
                ? "timed-out"
                : "cancelled",
          exitCode: ran.status === "ran" ? ran.exitCode : null,
          stdout: new Uint8Array(ran.output),
          stderr: new Uint8Array(),
          parserFailed: false,
          cleanupUncertain: ran.status !== "ran",
        };
      },
      readArtifact: async (input) => {
        const read = await options.files.read({
          path: posix.join(input.checkoutRoot, input.relativePath),
          maximumBytes: input.maximumBytes,
        });
        return read.status === "read" ? read.bytes : undefined;
      },
      now: options.now,
      newId: options.newId,
    });
  return {
    head: async () => {
      const head = await call(HEAD_SCRIPT, [options.root]);
      return head !== undefined && /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(head) ? head : undefined;
    },
    discover: (input) => discoverServerTests(options.files, input.checkoutId),
    run: async (input): Promise<CodeRepositoryTestRun> => {
      if (active.has(input.runId)) throw new Error("Repository test is already running.");
      const controller = new AbortController();
      active.set(input.runId, {
        threadId: String(input.threadId),
        checkoutId: String(input.checkoutId),
        controller,
      });
      try {
        return await runOn(String(input.threadId)).run({
          ...input,
          checkoutRoot: options.root,
          // Nothing of this host's environment is carried to the server.
          environment: {},
          signal: controller.signal,
        });
      } finally {
        active.delete(input.runId);
      }
    },
    cancel: async (input) => {
      const running = active.get(input.testRunId);
      if (
        running === undefined ||
        running.threadId !== String(input.threadId) ||
        running.checkoutId !== String(input.checkoutId)
      ) {
        return false;
      }
      running.controller.abort();
      return true;
    },
  };
}

function unavailable(): RepositoryTestProcessResult {
  return {
    termination: "unavailable",
    exitCode: null,
    stdout: new Uint8Array(),
    stderr: new Uint8Array(),
    parserFailed: false,
    cleanupUncertain: false,
  };
}
