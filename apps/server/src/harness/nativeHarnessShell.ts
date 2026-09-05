import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RepositoryTestProcessResult } from "../code/repositoryTestRunner";
import type { NativeHarnessShellPort, NativeHarnessShellRun } from "./nativeHarnessTools";

export interface SandboxedProcessPort {
  execute(
    input: {
      readonly argv: readonly string[];
      readonly cwd: string;
      readonly environment: Readonly<Record<string, string>>;
      readonly timeoutMs: number;
    },
    signal?: AbortSignal,
  ): Promise<RepositoryTestProcessResult>;
}

export interface NativeHarnessShellOptions {
  readonly process: SandboxedProcessPort;
  readonly scriptDirectory?: string;
  readonly shell?: string;
}

/**
 * The harness `bash` tool over the same sandboxed, owned-process-group port
 * repository tests run through. The command is written to a short-lived
 * script rather than passed as an argument, because a command the model
 * writes is routinely longer than one argument is allowed to be.
 */
export function createNativeHarnessShell(
  options: NativeHarnessShellOptions,
): NativeHarnessShellPort {
  const shell = options.shell ?? "/bin/sh";
  return {
    run: async (input): Promise<NativeHarnessShellRun> => {
      const directory = await mkdtemp(join(options.scriptDirectory ?? tmpdir(), "octant-harness-"));
      const script = join(directory, "command.sh");
      try {
        await writeFile(script, `${input.command}\n`, { mode: 0o600 });
        const result = await options.process.execute(
          {
            argv: [shell, script],
            cwd: input.cwd,
            environment: { NO_COLOR: "1", TERM: "dumb" },
            timeoutMs: input.timeoutMs,
          },
          input.signal,
        );
        const output = decodeOutput(result);
        switch (result.termination) {
          case "exited":
            return {
              status: "ran",
              ...(result.exitCode === null ? {} : { exitCode: result.exitCode }),
              output,
              truncated: false,
            };
          case "timed-out":
            return { status: "timed-out", output, truncated: false };
          case "cancelled":
            return { status: "cancelled", output, truncated: false };
          case "unavailable":
            return { status: "unavailable", output: "", truncated: false };
        }
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  };
}

function decodeOutput(result: RepositoryTestProcessResult): string {
  const stdout = Buffer.from(result.stdout).toString("utf8");
  const stderr = Buffer.from(result.stderr).toString("utf8");
  if (stderr.trim().length === 0) return stdout;
  if (stdout.trim().length === 0) return stderr;
  return `${stdout}\n[stderr]\n${stderr}`;
}
