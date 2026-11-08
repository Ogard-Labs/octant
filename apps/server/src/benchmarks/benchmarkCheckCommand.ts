import { BENCHMARK_COMMAND_OUTPUT_BYTES, type BenchmarkCommandOutcome } from "@octant/domain";
import { createNativeHarnessShell, type SandboxedProcessPort } from "../harness/nativeHarnessShell";
import type { NativeHarnessShellPort } from "../harness/nativeHarnessTools";
import { redactHostSecrets } from "../process/secretRedaction";

/**
 * The shell a check command runs in. It is built without the cloud
 * credentials, the SSH agent socket and the Google CLI credentials the
 * harness's own shells carry: a check runs code an agent wrote, and what a
 * turn's tools reach only through approval stays out of its reach. Its home is
 * the port's private temporary folder.
 */
export function createBenchmarkCheckShell(options: {
  readonly process: SandboxedProcessPort;
  readonly scriptDirectory: string;
  readonly homeDirectory: string;
}): NativeHarnessShellPort {
  return createNativeHarnessShell({
    process: options.process,
    scriptDirectory: options.scriptDirectory,
    environment: { HOME: options.homeDirectory },
  });
}

export interface BenchmarkCheckCommandPort {
  run(input: {
    readonly command: string;
    /** The cell's worktree. */
    readonly cwd: string;
    readonly timeoutMs: number;
    readonly signal?: AbortSignal;
  }): Promise<BenchmarkCommandOutcome>;
}

/**
 * Runs a check command through a harness shell: the same owned-process-group,
 * Seatbelt-confined launch Octant's own shell tool uses in a Code thread. It
 * adds no launcher; the host hands it the offline shell, so the command can
 * read and write the worktree and a temporary folder and reaches no network.
 * On timeout the shell ends the command's whole process group.
 */
export function createBenchmarkCheckCommandPort(
  shell: NativeHarnessShellPort,
): BenchmarkCheckCommandPort {
  return {
    async run(input) {
      const run = await shell.run({
        command: input.command,
        cwd: input.cwd,
        timeoutMs: input.timeoutMs,
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      });
      // What is kept is redacted first, as every host-bound shell output is, then
      // cut: only the start is ever read, and the domain keeps less of it.
      const output = Buffer.from(redactHostSecrets(run.output))
        .subarray(0, BENCHMARK_COMMAND_OUTPUT_BYTES)
        .toString("utf8");
      switch (run.status) {
        case "ran":
          return { status: "exited", exitCode: run.exitCode ?? -1, output };
        case "timed-out":
          return { status: "timed-out", output };
        case "cancelled":
          return { status: "unavailable", message: "The check was cancelled." };
        case "unavailable":
          return {
            status: "unavailable",
            message:
              run.refusal?.message ??
              "The sandbox could not launch the command, so it did not run.",
          };
      }
    },
  };
}
