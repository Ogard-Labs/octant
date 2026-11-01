import type { NativeHarnessShellPort, NativeHarnessShellRun } from "../harness/nativeHarnessTools";
import type { ServerAddress, ServerConnection } from "./serverConnection";

/**
 * The native harness's shell on a server Project's folder. Canonical:
 * docs/design/server-projects.md § Threads.
 *
 * A command runs with `sh -c` in the folder, on a terminal on the server so
 * a timed-out or cancelled command is hung up with its connection. Octant has
 * no sandbox there: the level's approval, asked before this runs, is the
 * guard. Every command is recorded on the thread with how it ended; one whose
 * record cannot be kept returns no output, as a local remote command does.
 */

const MAX_OUTPUT_BYTES = 64 * 1024;

/** Runs `$2` in folder `$1`, with pagers off so nothing waits on the terminal. */
const COMMAND_SCRIPT = `cd -- "$1" || exit 126
export PAGER=cat GIT_PAGER=cat TERM=dumb
exec sh -c "$2"`;

export interface ServerShellOptions {
  readonly connection: Pick<ServerConnection, "run">;
  /** The server the folder is on, read each call so a server removed from the registry refuses. */
  readonly server: () => (ServerAddress & { readonly serverId: string }) | undefined;
  readonly root: string;
  readonly record: (input: {
    readonly serverId: string;
    readonly alias: string;
    readonly command: string;
    readonly status: NativeHarnessShellRun["status"];
    readonly exitCode?: number | undefined;
  }) => "recorded" | "unavailable";
}

export function createServerShell(options: ServerShellOptions): NativeHarnessShellPort {
  return {
    run: async (input) => {
      const server = options.server();
      if (server === undefined) {
        return {
          status: "unavailable",
          output: "The server is no longer registered, so the command did not run anywhere.",
          truncated: false,
        };
      }
      const call = await options.connection.run(server, {
        script: COMMAND_SCRIPT,
        args: [options.root, input.command],
        terminal: true,
        timeoutMs: input.timeoutMs,
        maxOutputBytes: MAX_OUTPUT_BYTES,
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      });
      const run: NativeHarnessShellRun =
        call.status === "ran"
          ? {
              status: "ran",
              exitCode: call.exitCode,
              output: call.output.toString("utf8"),
              truncated: call.truncated,
            }
          : call.status === "unreachable"
            ? {
                status: "unavailable",
                output: `The server could not be reached (${call.message}). The command did not run here or there.`,
                truncated: false,
              }
            : {
                status: call.status,
                output: call.output.toString("utf8"),
                truncated: call.truncated,
              };
      let recorded: "recorded" | "unavailable";
      try {
        recorded = options.record({
          serverId: server.serverId,
          alias: server.alias,
          command: input.command,
          status: run.status,
          ...(run.exitCode === undefined ? {} : { exitCode: run.exitCode }),
        });
      } catch {
        recorded = "unavailable";
      }
      return recorded === "unavailable"
        ? { status: "unavailable", output: "", truncated: false }
        : run;
    },
  };
}
