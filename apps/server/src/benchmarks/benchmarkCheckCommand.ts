import { BENCHMARK_COMMAND_OUTPUT_BYTES, type BenchmarkCommandOutcome } from "@octant/domain";
import type { NativeHarnessShellPort } from "../harness/nativeHarnessTools";

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
      // Only the start of the output is ever read, and the domain keeps less of it.
      const output = Buffer.from(run.output)
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
