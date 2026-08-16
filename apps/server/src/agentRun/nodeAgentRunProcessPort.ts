import { spawn, type ChildProcess } from "node:child_process";
import type { AgentRun } from "@octant/contracts/agent-run";
import type { AgentRunProcessHandle, AgentRunProcessPort } from "./agentRunProcessSupervisor";
import {
  persistProcessReceipt,
  reconcileProcessReceipts,
  type OwnedProcessReceiptHandle,
} from "../process/nodeOwnedProcessReceipt";

export interface NodeAgentRunCommand {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
}

export interface NodeAgentRunProcessPortOptions {
  readonly command: (run: AgentRun) => NodeAgentRunCommand;
  readonly environment?: NodeJS.ProcessEnv;
  readonly shutdownTimeoutMs?: number;
  readonly receiptDirectory?: string;
  readonly processIdentity?: (pid: number) => Promise<string | undefined>;
  readonly processGroupExists?: (pid: number) => Promise<boolean> | boolean;
  readonly killProcessGroup?: (pid: number, signal: NodeJS.Signals) => void;
}

/**
 * Node child-process adapter for an already-authorized AgentRun. The caller
 * owns command selection; this adapter only provides detached process-group
 * lifetime and bounded termination for the supervisor.
 */
export function createNodeAgentRunProcessPort(
  options: NodeAgentRunProcessPortOptions,
): AgentRunProcessPort {
  const shutdownTimeoutMs = options.shutdownTimeoutMs ?? 2_000;
  return {
    spawn(run) {
      const command = options.command(run);
      const child = spawn(command.command, [...command.args], {
        ...(command.cwd === undefined ? {} : { cwd: command.cwd }),
        detached: process.platform !== "win32",
        env: command.env ?? options.environment ?? process.env,
        stdio: "ignore",
      });
      return createHandle(child, shutdownTimeoutMs, options);
    },
    reconcile: async () => {
      await reconcileProcessReceipts({
        supervisor: "agent-run",
        ...(options.receiptDirectory === undefined
          ? {}
          : { receiptDirectory: options.receiptDirectory }),
        ...(options.processIdentity === undefined
          ? {}
          : { processIdentity: options.processIdentity }),
        ...(options.processGroupExists === undefined
          ? {}
          : { processGroupExists: options.processGroupExists }),
        ...(options.killProcessGroup === undefined
          ? {}
          : {
              killProcessGroup: (pid, signal) => options.killProcessGroup!(-Math.abs(pid), signal),
            }),
        shutdownTimeoutMs,
      });
    },
  };
}

function createHandle(
  child: ChildProcess,
  shutdownTimeoutMs: number,
  options: NodeAgentRunProcessPortOptions,
): AgentRunProcessHandle {
  let receipt: OwnedProcessReceiptHandle = {
    ready: Promise.resolve(),
    remove: async () => undefined,
  };
  const receiptReady = persistProcessReceipt(
    {
      supervisor: "agent-run",
      ...(options.receiptDirectory === undefined
        ? {}
        : { receiptDirectory: options.receiptDirectory }),
      ...(options.processIdentity === undefined
        ? {}
        : { processIdentity: options.processIdentity }),
    },
    `agent-run:${child.pid ?? "unknown"}`,
    child.pid ?? -1,
  )
    .then(async (value) => {
      receipt = value;
      try {
        await value.ready;
      } catch (error) {
        await value.remove();
        throw error;
      }
    })
    .catch(async (error) => {
      await terminateProcess(child, shutdownTimeoutMs, options).catch(() => undefined);
      throw error;
    });
  let exitListener: (() => void) | undefined;
  let termination: Promise<void> | undefined;
  child.once("exit", () => {
    void removeReceiptWhenReleased(child, receiptReady, () => receipt, shutdownTimeoutMs, options);
    exitListener?.();
  });
  return {
    pid: child.pid ?? -1,
    receiptReady,
    onExit(listener) {
      exitListener = listener;
      if (child.exitCode !== null || child.signalCode !== null) listener();
    },
    terminate() {
      termination ??= terminateProcess(child, shutdownTimeoutMs, options);
      return termination.then(async () => {
        await receiptReady.catch(() => undefined);
        const groupReleased = await waitForProcessGroupExit(
          child.pid,
          shutdownTimeoutMs,
          options.processGroupExists,
        );
        if (!groupReleased) throw new Error("AgentRun process group did not terminate.");
        await receipt.remove();
      });
    },
  };
}

async function terminateProcess(
  child: ChildProcess,
  timeoutMs: number,
  options: NodeAgentRunProcessPortOptions,
): Promise<void> {
  if (child.pid === undefined) return;
  signalProcess(child, "SIGTERM", options.killProcessGroup);
  if (
    (await waitForExit(child, timeoutMs)) &&
    (await waitForProcessGroupExit(child.pid, timeoutMs, options.processGroupExists))
  )
    return;
  signalProcess(child, "SIGKILL", options.killProcessGroup);
  if (
    !(await waitForExit(child, timeoutMs)) ||
    !(await waitForProcessGroupExit(child.pid, timeoutMs, options.processGroupExists))
  ) {
    throw new Error("AgentRun child process group did not terminate after SIGKILL.");
  }
}

async function waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (child.exitCode === null && child.signalCode === null && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return child.exitCode !== null || child.signalCode !== null;
}

async function waitForProcessGroupExit(
  pid: number | undefined,
  timeoutMs: number,
  processGroupExists?: (pid: number) => Promise<boolean> | boolean,
): Promise<boolean> {
  if (pid === undefined) return false;
  const exists = processGroupExists ?? defaultProcessGroupExists;
  const deadline = Date.now() + timeoutMs;
  while (await exists(pid)) {
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return true;
}

async function removeReceiptWhenReleased(
  child: ChildProcess,
  receiptReady: Promise<void>,
  getReceipt: () => OwnedProcessReceiptHandle,
  timeoutMs: number,
  options: NodeAgentRunProcessPortOptions,
): Promise<void> {
  try {
    if (options.receiptDirectory === undefined) return;
    const ready = await receiptReady.then(
      () => true,
      () => false,
    );
    if (!ready) return;
    while (!(await waitForProcessGroupExit(child.pid, timeoutMs, options.processGroupExists))) {
      await new Promise((resolve) => {
        const retry = setTimeout(resolve, timeoutMs);
        retry.unref?.();
      });
    }
    await getReceipt().remove();
  } catch {
    // Keep the receipt when group ownership cannot be confirmed so startup
    // reconciliation can retry it safely.
  }
}

function signalProcess(
  child: ChildProcess,
  signal: NodeJS.Signals,
  killProcessGroup?: (pid: number, signal: NodeJS.Signals) => void,
): void {
  if (child.pid === undefined) return;
  try {
    if (killProcessGroup !== undefined) killProcessGroup(-Math.abs(child.pid), signal);
    else if (process.platform === "win32") child.kill(signal);
    else process.kill(-child.pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
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
