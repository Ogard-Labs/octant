import { spawn, type ChildProcess } from "node:child_process";
import { dirname } from "node:path";
import type { ProviderFailure } from "@octant/contracts";

export { providerCliUpdateArgs } from "@octant/domain";

/**
 * Provider-owned update entry points. The command is deliberately run through
 * the configured absolute binary: Octant never downloads, copies, or replaces
 * a provider executable itself.
 *
 * This spawn is the documented updater-authority exception in ADR 0121, not a
 * silent unconstrained launch. Session work stays under Seatbelt/Bubblewrap;
 * an explicit updater has to write its own installation tree, so it inherits
 * the host environment and uses the binary directory as cwd.
 */
export interface ProviderCliUpdateInput {
  readonly binaryPath: string;
  readonly args: ReadonlyArray<string>;
  readonly environment?: NodeJS.ProcessEnv;
  readonly timeoutMs?: number;
  readonly terminationGraceMs?: number;
  readonly processGroupExists?: (pid: number) => boolean;
  readonly killProcessGroup?: (pid: number, signal: NodeJS.Signals) => void;
}

export interface ProviderCliUpdateOutput {
  readonly output: string;
  readonly exitCode: number;
}

const MAX_OUTPUT_BYTES = 16_384;
const DEFAULT_TIMEOUT_MS = 120_000;
const TIMEOUT_TERMINATION_GRACE_MS = 1_000;
export const PROVIDER_CLI_UPDATE_UNCONFIRMED_MESSAGE =
  "Provider CLI update did not confirm that the updater process tree exited.";

export function isProviderCliUpdateTerminationUnconfirmed(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "message" in error &&
    error.message === PROVIDER_CLI_UPDATE_UNCONFIRMED_MESSAGE
  );
}

export async function runProviderCliUpdate(
  input: ProviderCliUpdateInput,
): Promise<ProviderCliUpdateOutput> {
  const graceMs = input.terminationGraceMs ?? TIMEOUT_TERMINATION_GRACE_MS;
  return await new Promise((resolve, reject) => {
    const child = spawn(input.binaryPath, [...input.args], {
      cwd: dirname(input.binaryPath),
      detached: process.platform !== "win32",
      env: input.environment ?? process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const pid = child.pid;
    if (pid === undefined) {
      reject(failure("unavailable", "Provider CLI update could not start."));
      return;
    }
    const groupExists = (): boolean =>
      input.processGroupExists === undefined
        ? defaultProcessGroupExists(pid)
        : input.processGroupExists(pid);
    const killGroup = (signal: NodeJS.Signals) => {
      if (input.killProcessGroup !== undefined) input.killProcessGroup(pid, signal);
      else defaultKillProcessGroup(child, pid, signal);
    };
    const decoder = new TextDecoder("utf8");
    const captured: Uint8Array[] = [];
    let capturedBytes = 0;
    let settled = false;
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      void terminateTree("timeout");
    }, input.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    const capture = (chunk: Buffer | string) => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      if (capturedBytes >= MAX_OUTPUT_BYTES) return;
      const remaining = MAX_OUTPUT_BYTES - capturedBytes;
      const taken = bytes.byteLength > remaining ? bytes.subarray(0, remaining) : bytes;
      captured.push(taken);
      capturedBytes += taken.byteLength;
    };
    const settle = (result: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      result();
    };
    const capturedText = () => decoder.decode(Buffer.concat(captured, capturedBytes));
    const terminateTree = async (reason: "timeout" | "close") => {
      const released = await ensureProcessTreeExited(groupExists, killGroup, graceMs);
      if (released !== "released") {
        settle(() => reject(failure("unavailable", PROVIDER_CLI_UPDATE_UNCONFIRMED_MESSAGE)));
        return;
      }
      if (reason === "timeout" || timedOut) {
        settle(() => reject(failure("unavailable", "Provider CLI update timed out.")));
        return;
      }
    };
    child.stdout.on("data", capture);
    child.stderr.on("data", capture);
    child.once("error", (error) => {
      if (settled || timedOut) return;
      settle(() =>
        reject(
          failure(
            "unavailable",
            `Provider CLI update could not start: ${error instanceof Error ? error.message : "unknown error"}`,
          ),
        ),
      );
    });
    child.once("close", (exitCode) => {
      if (settled) return;
      void (async () => {
        if (timedOut) {
          await terminateTree("timeout");
          return;
        }
        const released = await ensureProcessTreeExited(groupExists, killGroup, graceMs);
        if (released !== "released") {
          settle(() => reject(failure("unavailable", PROVIDER_CLI_UPDATE_UNCONFIRMED_MESSAGE)));
          return;
        }
        if (exitCode === null || exitCode !== 0) {
          settle(() => reject(failure("provider-failed", "Provider CLI update failed.")));
          return;
        }
        settle(() => resolve({ output: capturedText(), exitCode }));
      })();
    });
  });
}

async function ensureProcessTreeExited(
  groupExists: () => boolean,
  killGroup: (signal: NodeJS.Signals) => void,
  graceMs: number,
): Promise<"released" | "unconfirmed"> {
  if (!groupExists()) return "released";
  killGroup("SIGTERM");
  if (await waitUntilReleased(groupExists, graceMs)) return "released";
  killGroup("SIGKILL");
  if (await waitUntilReleased(groupExists, graceMs)) return "released";
  return "unconfirmed";
}

async function waitUntilReleased(groupExists: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (groupExists()) {
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return true;
}

function defaultProcessGroupExists(pid: number): boolean {
  try {
    process.kill(process.platform === "win32" ? pid : -pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return false;
    if (code === "EPERM") return true;
    throw error;
  }
}

function defaultKillProcessGroup(child: ChildProcess, pid: number, signal: NodeJS.Signals): void {
  try {
    if (process.platform === "win32") child.kill(signal);
    else process.kill(-pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

function failure(category: ProviderFailure["category"], message: string): ProviderFailure {
  return { category, message };
}
