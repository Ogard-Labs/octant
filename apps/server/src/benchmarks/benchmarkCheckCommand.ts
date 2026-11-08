import { mkdir, mkdtemp, readdir, realpath, rm } from "node:fs/promises";
import { join } from "node:path";
import { BENCHMARK_COMMAND_OUTPUT_BYTES, type BenchmarkCommandOutcome } from "@octant/domain";
import { RepositoryTestProcessPort } from "../code/repositoryTestProcessPort";
import { createNativeHarnessShell, type SandboxedProcessPort } from "../harness/nativeHarnessShell";
import type { NativeHarnessShellPort } from "../harness/nativeHarnessTools";
import { redactHostSecrets } from "../process/secretRedaction";

/** One cell's check sequence: every command shares a private folder that `close` removes. */
export interface BenchmarkCheckSession {
  run(input: {
    readonly command: string;
    /** The cell's worktree. */
    readonly cwd: string;
    readonly timeoutMs: number;
    readonly signal?: AbortSignal;
  }): Promise<BenchmarkCommandOutcome>;
  /** Removes the sequence's private folder. Safe to repeat. */
  close(): Promise<void>;
}

export interface BenchmarkCheckCommandPort {
  /** Opens the private folder and the confined launcher for one cell's checks. */
  open(): Promise<BenchmarkCheckSession>;
  /** Removes every private folder left behind, for a host start: no sequence is running then. */
  sweep?(): Promise<void>;
}

/**
 * The shell a check command runs in. It is built without the cloud
 * credentials, the SSH agent socket and the Google CLI credentials the
 * harness's own shells carry: a check runs code an agent wrote, and what a
 * turn's tools reach only through approval stays out of its reach. Its home
 * and every temporary folder variable name `directory`, the sequence's own.
 */
export function createBenchmarkCheckShell(options: {
  readonly process: SandboxedProcessPort;
  readonly scriptDirectory: string;
  readonly directory: string;
}): NativeHarnessShellPort {
  return createNativeHarnessShell({
    process: options.process,
    scriptDirectory: options.scriptDirectory,
    environment: {
      HOME: options.directory,
      TMPDIR: options.directory,
      TEMP: options.directory,
      TMP: options.directory,
    },
  });
}

/**
 * One cell's check session over a harness shell: the command mapping and
 * output handling, with `close` run when the sequence is over.
 */
export function createBenchmarkCheckSession(
  shell: NativeHarnessShellPort,
  close: () => Promise<void> = async () => undefined,
): BenchmarkCheckSession {
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
    close,
  };
}

export interface BenchmarkCheckCommandsOptions {
  /** A folder only benchmark checks use, apart from every other harness folder. */
  readonly root: string;
  /** Where pending command scripts live; it must lie outside every folder a check may write. */
  readonly scriptDirectory: string;
  /** The harness receipt folder, so a restart reaps any group a crash left. */
  readonly receiptDirectory: string;
  /** Test seams for the process port (confinement, spawn). */
  readonly processOptions?: ConstructorParameters<typeof RepositoryTestProcessPort>[0];
}

/**
 * Check commands through the existing owned-process-group, Seatbelt-confined
 * launch, on a port of their own: network `none`, and `setsid()` refused so a
 * descendant stays in the group a timeout, cancel or shutdown ends. Every
 * cell's sequence gets a fresh private folder as its home and every temporary
 * root, created before its first command and removed after its last, so one
 * cell can leave nothing for another cell's or another run's checks to find.
 */
export function createBenchmarkCheckCommands(
  options: BenchmarkCheckCommandsOptions,
): BenchmarkCheckCommandPort {
  return {
    async open() {
      await mkdir(options.root, { recursive: true, mode: 0o700 });
      const directory = await realpath(await mkdtemp(join(options.root, "check-")));
      const port = new RepositoryTestProcessPort({
        receiptDirectory: options.receiptDirectory,
        temporaryDirectory: directory,
        networkEgress: "none",
        harnessShellScriptDirectory: options.scriptDirectory,
        refuseNewSession: true,
        ...options.processOptions,
      });
      let closed = false;
      return createBenchmarkCheckSession(
        createBenchmarkCheckShell({
          process: port,
          scriptDirectory: options.scriptDirectory,
          directory,
        }),
        async () => {
          if (closed) return;
          closed = true;
          await rm(directory, { recursive: true, force: true });
        },
      );
    },
    async sweep() {
      let names: string[];
      try {
        names = await readdir(options.root);
      } catch {
        return;
      }
      for (const name of names) {
        if (!name.startsWith("check-")) continue;
        await rm(join(options.root, name), { recursive: true, force: true });
      }
    },
  };
}
