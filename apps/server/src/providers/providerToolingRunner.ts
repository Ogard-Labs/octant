import { spawn } from "node:child_process";

export interface ProviderToolingRun {
  /** The provider's program as configured on the account: a path or a name on PATH. */
  readonly binary: string;
  /** One argument per element. No shell reads them. */
  readonly argv: ReadonlyArray<string>;
  /** The whole environment of the child. Nothing is inherited. */
  readonly environment: NodeJS.ProcessEnv;
  readonly cwd: string;
  readonly timeoutMs: number;
  /** Output past this many bytes is dropped; the child is left to finish. */
  readonly outputLimitBytes: number;
}

export interface ProviderToolingRunResult {
  /** Null when the program could not start or was stopped. */
  readonly exitCode: number | null;
  readonly timedOut: boolean;
  readonly startFailed: boolean;
  /** What the program printed, standard output then standard error, capped. */
  readonly output: string;
}

export type ProviderToolingRunner = (run: ProviderToolingRun) => Promise<ProviderToolingRunResult>;

/**
 * Runs one provider command with no shell and no input. The child gets its own
 * process group so a timeout stops everything it started.
 */
export const runProviderToolingProcess: ProviderToolingRunner = (run) =>
  new Promise((resolve) => {
    if (run.argv.some((argument) => argument.includes("\u0000")) || run.binary.includes("\u0000")) {
      resolve({ exitCode: null, timedOut: false, startFailed: true, output: "" });
      return;
    }
    const detached = process.platform !== "win32";
    const child = spawn(run.binary, [...run.argv], {
      cwd: run.cwd,
      detached,
      env: run.environment,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let outLength = 0;
    let errLength = 0;
    let settled = false;
    let timedOut = false;
    const half = Math.floor(run.outputLimitBytes / 2);
    const finish = (exitCode: number | null, startFailed: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        exitCode,
        timedOut,
        startFailed,
        output: Buffer.concat([...out, ...err]).toString("utf8"),
      });
    };
    const stop = () => {
      try {
        if (detached && child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch {
        // The exit event stays authoritative.
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      stop();
      finish(null, false);
    }, run.timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => {
      if (outLength >= half) return;
      const kept = chunk.subarray(0, half - outLength);
      out.push(Buffer.from(kept));
      outLength += kept.length;
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (errLength >= half) return;
      const kept = chunk.subarray(0, half - errLength);
      err.push(Buffer.from(kept));
      errLength += kept.length;
    });
    child.once("error", () => finish(null, true));
    child.once("close", (code) => finish(code, false));
  });
