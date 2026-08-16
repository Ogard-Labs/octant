import { spawn as nodeSpawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { ComputerUseProcessPort } from "./macOsComputerUseAdapter";
import {
  persistProcessReceipt,
  reconcileProcessReceipts,
  type OwnedProcessReceiptHandle,
} from "../process/nodeOwnedProcessReceipt";

const MAX_OUTPUT_BYTES = 64 * 1024;

export function createNodeComputerUseProcessPort(options?: {
  readonly spawn?: typeof nodeSpawn;
  readonly receiptDirectory?: string;
  readonly processIdentity?: (pid: number) => Promise<string | undefined>;
  readonly killProcessGroup?: (pid: number, signal: NodeJS.Signals) => void;
  readonly processGroupExists?: (pid: number) => Promise<boolean> | boolean;
  readonly shutdownTimeoutMs?: number;
}): ComputerUseProcessPort {
  const spawn = options?.spawn ?? nodeSpawn;
  return {
    run: (input) =>
      new Promise((resolve, reject) => {
        if (input.signal.aborted) {
          reject(new DOMException("Computer-use process was interrupted.", "AbortError"));
          return;
        }
        let child: ChildProcessWithoutNullStreams;
        try {
          child = spawn(input.executable, [...input.arguments], {
            shell: false,
            detached: process.platform !== "win32",
            stdio: ["pipe", "pipe", "pipe"],
            env: { LANG: "en_US.UTF-8", PATH: "/usr/bin:/bin" },
          });
        } catch {
          reject(new Error("Native computer-use helper could not start."));
          return;
        }
        let receipt: OwnedProcessReceiptHandle = {
          ready: Promise.resolve(),
          remove: async () => undefined,
        };
        const receiptState = persistProcessReceipt(
          {
            supervisor: "computer-use",
            ...(options?.receiptDirectory === undefined
              ? {}
              : { receiptDirectory: options.receiptDirectory }),
            ...(options?.processIdentity === undefined
              ? {}
              : { processIdentity: options.processIdentity }),
          },
          `${input.executable}:${input.arguments.join("\0")}:${child.pid ?? "unknown"}`,
          child.pid ?? -1,
        ).then(
          async (value) => {
            try {
              await value.ready;
              return { ok: true as const, value };
            } catch (error) {
              await value.remove();
              return { ok: false as const, error };
            }
          },
          (error) => ({ ok: false as const, error }),
        );
        let settled = false;
        let receiptFailure: unknown;
        let aborted = false;
        let overflowed = false;
        let escalationTimer: ReturnType<typeof setTimeout> | undefined;
        let stdout = Buffer.alloc(0);
        let stderr = Buffer.alloc(0);
        const hasDurableReceipt = options?.receiptDirectory !== undefined;
        const shutdownTimeoutMs = options?.shutdownTimeoutMs ?? 1_000;
        const processGroupExists = options?.processGroupExists ?? defaultProcessGroupExists;
        const signalOwnedProcess = (signal: NodeJS.Signals) => {
          const pid = child.pid;
          if (process.platform === "win32" || !Number.isSafeInteger(pid) || (pid as number) < 1) {
            child.kill(signal);
            return;
          }
          if (options?.killProcessGroup !== undefined) {
            options.killProcessGroup(-Math.abs(pid as number), signal);
            return;
          }
          try {
            process.kill(-Math.abs(pid as number), signal);
          } catch (error) {
            // A leader that already exited is expected; retain the fallback
            // for test doubles and platforms that do not expose the group.
            if ((error as NodeJS.ErrnoException).code === "ESRCH") child.kill(signal);
            else throw error;
          }
        };
        const terminateOwnedChild = () => {
          signalOwnedProcess("SIGTERM");
          escalationTimer ??= setTimeout(() => {
            try {
              signalOwnedProcess("SIGKILL");
            } catch {
              // The process has already exited; receipt cleanup verifies the
              // group before ownership is released.
            }
          }, 1_000);
        };
        const waitForGroupRelease = async (): Promise<boolean> => {
          const pid = child.pid;
          if (!hasDurableReceipt || !Number.isSafeInteger(pid) || (pid as number) < 1) return true;
          const deadline = Date.now() + shutdownTimeoutMs;
          while (await processGroupExists(pid as number)) {
            if (Date.now() >= deadline) return false;
            await new Promise((resolve) => setTimeout(resolve, 10));
          }
          return true;
        };
        const cleanupOwnedProcessGroup = async (): Promise<boolean> => {
          if (await waitForGroupRelease()) return true;
          try {
            signalOwnedProcess("SIGKILL");
          } catch {
            // The final group-existence check below determines certainty.
          }
          return await waitForGroupRelease();
        };
        void receiptState.then((state) => {
          if (state.ok || settled) return;
          receiptFailure = state.error;
          try {
            terminateOwnedChild();
          } catch {
            // The receipt failure remains the fail-closed launch result.
          }
        });
        const finish = (callback: () => void) => {
          if (settled) return;
          settled = true;
          if (escalationTimer !== undefined) clearTimeout(escalationTimer);
          input.signal.removeEventListener("abort", abort);
          void receiptState.then(async (state) => {
            if (state.ok) receipt = state.value;
            const groupReleased = await cleanupOwnedProcessGroup();
            if (!groupReleased) {
              reject(
                receiptFailure ?? new Error("Native computer-use process group did not exit."),
              );
              return;
            }
            await receipt.remove();
            if (!state.ok || receiptFailure !== undefined) {
              reject(receiptFailure ?? (state as { readonly error: unknown }).error);
              return;
            }
            callback();
          });
        };
        const collect = (target: "stdout" | "stderr", chunk: Buffer | string) => {
          if (overflowed) return;
          const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          const remaining = Math.max(0, MAX_OUTPUT_BYTES - stdout.byteLength - stderr.byteLength);
          const bounded = bytes.subarray(0, remaining);
          if (target === "stdout") stdout = Buffer.concat([stdout, bounded]);
          else stderr = Buffer.concat([stderr, bounded]);
          if (bytes.byteLength > remaining) {
            overflowed = true;
            terminateOwnedChild();
          }
        };
        const abort = () => {
          if (settled || aborted) return;
          aborted = true;
          terminateOwnedChild();
        };
        input.signal.addEventListener("abort", abort, { once: true });
        child.stdout.on("data", (chunk) => collect("stdout", chunk));
        child.stderr.on("data", (chunk) => collect("stderr", chunk));
        child.once("error", () =>
          finish(() =>
            reject(
              overflowed
                ? new Error("Native computer-use helper output exceeded its limit.")
                : aborted
                  ? new DOMException("Computer-use process was interrupted.", "AbortError")
                  : new Error("Native computer-use helper process failed."),
            ),
          ),
        );
        child.once("close", (code) =>
          finish(() =>
            overflowed
              ? reject(new Error("Native computer-use helper output exceeded its limit."))
              : aborted
                ? reject(new DOMException("Computer-use process was interrupted.", "AbortError"))
                : resolve({
                    exitCode: code ?? 1,
                    stdout: stdout.toString("utf8"),
                    stderr: stderr.toString("utf8"),
                  }),
          ),
        );
        child.stdin.end(input.stdin);
      }),
    reconcile: async () => {
      await reconcileProcessReceipts({
        supervisor: "computer-use",
        ...(options?.receiptDirectory === undefined
          ? {}
          : { receiptDirectory: options.receiptDirectory }),
        ...(options?.processIdentity === undefined
          ? {}
          : { processIdentity: options.processIdentity }),
        ...(options?.killProcessGroup === undefined
          ? {}
          : {
              killProcessGroup: (pid, signal) => options.killProcessGroup!(-Math.abs(pid), signal),
            }),
        ...(options?.processGroupExists === undefined
          ? {}
          : { processGroupExists: options.processGroupExists }),
        ...(options?.shutdownTimeoutMs === undefined
          ? {}
          : { shutdownTimeoutMs: options.shutdownTimeoutMs }),
      });
    },
  };
}

function defaultProcessGroupExists(pid: number): boolean {
  try {
    process.kill(process.platform === "win32" ? pid : -Math.abs(pid), 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return false;
    if (code === "EPERM") return true;
    throw error;
  }
}
