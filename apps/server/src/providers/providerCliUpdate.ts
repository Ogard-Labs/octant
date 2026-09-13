import { spawn } from "node:child_process";
import { dirname } from "node:path";
import type { ProviderFailure } from "@octant/contracts";

export { providerCliUpdateArgs } from "@octant/domain";

/**
 * Provider-owned update entry points. The command is deliberately run through
 * the configured absolute binary: Octant never downloads, copies, or replaces
 * a provider executable itself.
 */
export interface ProviderCliUpdateInput {
  readonly binaryPath: string;
  readonly args: ReadonlyArray<string>;
  readonly environment?: NodeJS.ProcessEnv;
  readonly timeoutMs?: number;
}

export interface ProviderCliUpdateOutput {
  readonly output: string;
  readonly exitCode: number;
}

const MAX_OUTPUT_BYTES = 16_384;
const DEFAULT_TIMEOUT_MS = 120_000;

export async function runProviderCliUpdate(
  input: ProviderCliUpdateInput,
): Promise<ProviderCliUpdateOutput> {
  return await new Promise((resolve, reject) => {
    const child = spawn(input.binaryPath, [...input.args], {
      cwd: dirname(input.binaryPath),
      env: input.environment ?? process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const chunks: string[] = [];
    let bytes = 0;
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGTERM");
      reject(failure("unavailable", "Provider CLI update timed out."));
    }, input.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    const capture = (chunk: Buffer | string) => {
      if (bytes >= MAX_OUTPUT_BYTES) return;
      const value = String(chunk);
      const remaining = MAX_OUTPUT_BYTES - bytes;
      chunks.push(value.slice(0, remaining));
      bytes += Math.min(value.length, remaining);
    };
    child.stdout.on("data", capture);
    child.stderr.on("data", capture);
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(
        failure(
          "unavailable",
          `Provider CLI update could not start: ${error instanceof Error ? error.message : "unknown error"}`,
        ),
      );
    });
    child.once("close", (exitCode) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (exitCode === null || exitCode !== 0) {
        reject(failure("provider-failed", "Provider CLI update failed."));
        return;
      }
      resolve({ output: chunks.join(""), exitCode });
    });
  });
}

function failure(category: ProviderFailure["category"], message: string): ProviderFailure {
  return { category, message };
}
