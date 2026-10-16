import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AggregateId, ToolEgressLaunch, ToolEgressLaunchId } from "@octant/contracts";
import type { HarnessShellScriptInput } from "../code/repositoryTestProcessPort";
import type { RepositoryTestProcessResult } from "../code/repositoryTestRunner";
import type {
  ToolEgressCallConfirmation,
  ToolEgressLaunchEnd,
  ToolEgressLaunchStart,
} from "./nativeHarnessEgressRules";
import type { NativeHarnessShellPort, NativeHarnessShellRun } from "./nativeHarnessTools";

export interface SandboxedProcessPort {
  executeShellScript(
    input: HarnessShellScriptInput,
    signal?: AbortSignal,
  ): Promise<RepositoryTestProcessResult>;
}

export interface NativeHarnessShellOptions {
  readonly process: SandboxedProcessPort;
  /**
   * The process port's script directory: it runs only a script in its own
   * subdirectory there, which no confined command can write.
   */
  readonly scriptDirectory: string;
  /**
   * Present for a shell whose commands reach the network only through the
   * host's egress proxy (`proxied`). Every run starts its own launch, and a
   * launch that cannot start never runs its command.
   */
  readonly egress?: NativeHarnessShellEgress;
}

export interface NativeHarnessShellEgress {
  /** Whose rules apply: the thread, its Project, and the parent for a child. */
  readonly scope: {
    readonly threadId: AggregateId;
    readonly projectId: AggregateId;
    readonly parentThreadId?: AggregateId;
  };
  /**
   * Binds the launch's listener and records that it started, then grants the
   * hosts a person confirmed for this command as `call` rules for it alone.
   */
  readonly startLaunch: (
    launch: ToolEgressLaunch,
    confirmed: ToolEgressCallConfirmation | undefined,
  ) => Promise<ToolEgressLaunchStart>;
  readonly launchId: () => ToolEgressLaunchId;
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
  const egress = options.egress;
  return {
    run: async (input): Promise<NativeHarnessShellRun> => {
      if (egress === undefined) return runScript(options, input, undefined);
      const started = await egress.startLaunch(
        {
          launchId: egress.launchId(),
          ...egress.scope,
          ...(input.callId === undefined ? {} : { toolCallId: input.callId }),
        },
        input.confirmedHosts,
      );
      if (started.status === "refused") {
        return { status: "unavailable", output: "", truncated: false };
      }
      const proxy = started.launch.proxy;
      let run: NativeHarnessShellRun;
      let ended: ToolEgressLaunchEnd;
      try {
        run = await runScript(options, input, { endpoint: proxy.endpoint, token: proxy.token });
      } finally {
        // The command's process group has ended; the listener closes now, and
        // the launch's summary and taint land before the result returns.
        ended = await started.launch.finish();
      }
      // The model never reads output the journal has not marked.
      return ended.status === "summarized"
        ? run
        : { status: "unavailable", output: "", truncated: false };
    },
  };
}

async function runScript(
  options: NativeHarnessShellOptions,
  input: Parameters<NativeHarnessShellPort["run"]>[0],
  egressProxy: HarnessShellScriptInput["egressProxy"],
): Promise<NativeHarnessShellRun> {
  const directory = await mkdtemp(join(options.scriptDirectory, "octant-harness-"));
  const script = join(directory, "command.sh");
  try {
    await writeFile(script, `${input.command}\n`, { mode: 0o600 });
    const result = await options.process.executeShellScript(
      {
        script,
        cwd: input.cwd,
        environment: { NO_COLOR: "1", TERM: "dumb" },
        timeoutMs: input.timeoutMs,
        ...(egressProxy === undefined ? {} : { egressProxy }),
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
}

function decodeOutput(result: RepositoryTestProcessResult): string {
  const stdout = Buffer.from(result.stdout).toString("utf8");
  const stderr = Buffer.from(result.stderr).toString("utf8");
  if (stderr.trim().length === 0) return stdout;
  if (stdout.trim().length === 0) return stderr;
  return `${stdout}\n[stderr]\n${stderr}`;
}
