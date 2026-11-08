/** Owned lifecycle for the disposable Linux mediation candidate, not production selection. */
import { spawn } from "node:child_process";
import { PassThrough, type Readable } from "node:stream";
import { isAbsolute } from "node:path";
import { homedir } from "node:os";
import { lstat, realpath } from "node:fs/promises";
import { Schema } from "effect";
import type { ProcessConfinementPrepareInput } from "./seatbeltProfile";
import { secretGuardConfiguration, type SecretGuardMediationPolicy } from "./secretGuard";
import { LinuxMediationWorkerConfig, MEDIATION_CONFIG_BYTES } from "./linuxMediationWorker";
import {
  persistProcessReceipt,
  readProcessIdentity,
  terminateOwnedProcess,
  type OwnedProcessReceiptHandle,
} from "./nodeOwnedProcessReceipt";
import type { LinuxMediationBrokerResult } from "./linuxMediationBroker";

const IO_BYTES = 65_536;
const INPUT_BYTES = IO_BYTES * 4;
const CLEANUP_MS = 4_000;
type Cleanup = "confirmed" | "uncertain";
export interface LinuxMediationSessionResult {
  readonly result: LinuxMediationBrokerResult;
  readonly cleanup: Cleanup;
}
export interface LinuxMediationSession {
  readonly stdout: Readable;
  readonly stderr: Readable;
  readonly exited: Promise<LinuxMediationSessionResult>;
  readonly launch: () => Promise<{ readonly status: "released" | "refused" }>;
  /** Accepted bytes are never replayed. A later loss may make their effect uncertain. */
  readonly writeInput: (bytes: Uint8Array) =>
    | {
        readonly status: "accepted";
        readonly drained: Promise<{ readonly status: "drained" | "uncertain" }>;
      }
    | { readonly status: "refused" };
  readonly endInput: () => void;
  readonly close: () => Promise<LinuxMediationSessionResult>;
}
const Message = Schema.Union(
  Schema.Struct({ status: Schema.Literal("ready"), relayPid: Schema.Int.pipe(Schema.positive()) }),
  Schema.Struct({ status: Schema.Literal("command"), pid: Schema.Int.pipe(Schema.positive()) }),
  Schema.Struct({
    status: Schema.Literal("result"),
    result: Schema.Union(
      Schema.Struct({
        status: Schema.Literal("exited"),
        code: Schema.Int.pipe(Schema.between(0, 255)),
      }),
      Schema.Struct({
        status: Schema.Literal("unavailable"),
        reason: Schema.Literal(
          "unsupported-platform",
          "native-unavailable",
          "broker-protocol",
          "policy-unavailable",
          "cancelled",
          "deadline",
        ),
      }),
    ),
  }),
);

async function within(promise: Promise<unknown>, maximumMs: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise.then(
        () => true,
        () => false,
      ),
      new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), Math.max(1, maximumMs));
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export async function prepareLinuxMediationSession(input: {
  readonly ownerId: string;
  readonly signal: AbortSignal;
  /** Includes preparation; this candidate refuses durations above the native 180s ceiling. */
  readonly maximumMs: number;
  readonly receiptDirectory: string;
  readonly brokerExecutable: string;
  readonly nativeExecutable: string;
  readonly launch: ProcessConfinementPrepareInput;
  readonly policy: SecretGuardMediationPolicy;
  readonly environment: Readonly<Record<string, string>>;
}): Promise<
  | { readonly status: "ready"; readonly session: LinuxMediationSession }
  | { readonly status: "unavailable"; readonly reason: string; readonly cleanup: Cleanup }
> {
  const entered = Date.now();
  const secretGuard = secretGuardConfiguration();
  if (process.platform !== "linux")
    return { status: "unavailable", reason: "unsupported-platform", cleanup: "confirmed" };
  if (
    input.signal.aborted ||
    !Number.isSafeInteger(input.maximumMs) ||
    input.maximumMs < 1 ||
    input.maximumMs > 180_000 ||
    input.ownerId.length < 1 ||
    input.ownerId.length > 256 ||
    ![input.receiptDirectory, input.brokerExecutable, input.nativeExecutable].every(isAbsolute)
  )
    return { status: "unavailable", reason: "invalid-configuration", cleanup: "confirmed" };
  const deadline = entered + input.maximumMs;
  let prepTimer: ReturnType<typeof setTimeout> | undefined;
  let prepAbort: (() => void) | undefined;
  const prepared = await Promise.race([
    (async () => {
      try {
        // Only the real shared builder chooses the capsule argv. There is no raw-command overload.
        const directory = await lstat(input.receiptDirectory);
        if (
          !directory.isDirectory() ||
          directory.uid !== process.getuid?.() ||
          (directory.mode & 0o777) !== 0o700 ||
          (await realpath(input.receiptDirectory)) !== input.receiptDirectory
        )
          throw new Error("Receipt directory must be canonical, private and owned.");
        const config = {
          nativeExecutable: input.nativeExecutable,
          launch: {
            ...input.launch,
            ...(input.launch.interpreterSearchPath === undefined &&
            input.environment.PATH !== undefined
              ? { interpreterSearchPath: input.environment.PATH }
              : {}),
          },
          receiptDirectory: input.receiptDirectory,
          policy: input.policy,
          environment: input.environment,
          secretGuard,
        };
        const decoded = Schema.decodeUnknownSync(LinuxMediationWorkerConfig)(config, {
          onExcessProperty: "error",
        });
        if (Buffer.byteLength(JSON.stringify(decoded)) > MEDIATION_CONFIG_BYTES)
          throw new Error("Configuration bound exceeded.");
        return { status: "configured" as const, config: decoded };
      } catch {
        return { status: "invalid-configuration" as const };
      }
    })(),
    new Promise<{ readonly status: "deadline" | "cancelled" }>((resolve) => {
      prepTimer = setTimeout(
        () => resolve({ status: "deadline" }),
        Math.max(0, deadline - Date.now()),
      );
      prepAbort = () => resolve({ status: "cancelled" });
      input.signal.addEventListener("abort", prepAbort, { once: true });
      if (input.signal.aborted) prepAbort();
    }),
  ]);
  clearTimeout(prepTimer);
  if (prepAbort !== undefined) input.signal.removeEventListener("abort", prepAbort);
  if (prepared.status !== "configured" || input.signal.aborted || Date.now() >= deadline)
    return {
      status: "unavailable",
      reason: input.signal.aborted
        ? "cancelled"
        : prepared.status === "configured"
          ? "deadline"
          : prepared.status,
      cleanup: "confirmed",
    };
  const config = prepared.config;
  const child = spawn(input.brokerExecutable, ["--linux-mediation-worker"], {
    detached: true,
    stdio: ["pipe", "pipe", "pipe", "ipc"],
    serialization: "json",
    env: {
      PATH: "/usr/bin:/bin",
      HOME: homedir(),
      LANG: "C",
      TMPDIR: input.launch.temporaryDirectory,
    },
  });
  const stdout = new PassThrough({ highWaterMark: IO_BYTES });
  const stderr = new PassThrough({ highWaterMark: IO_BYTES });
  child.stdout?.pipe(stdout);
  child.stderr?.pipe(stderr);
  const receipts: Array<{
    readonly pid: number;
    readonly identity: string;
    readonly handle: OwnedProcessReceiptHandle;
  }> = [];
  let phase: "preparing" | "ready" | "launching" | "running" | "stopping" | "exited" = "preparing";
  let result: LinuxMediationBrokerResult | undefined;
  let workerExited = false;
  const acquisitions = new Set<Promise<void>>();
  let ownershipUncertain = false;
  let ipcDisconnected = false;
  let stdoutEnded = false;
  let stderrEnded = false;
  let pendingControl = 0;
  let queued = 0;
  let pendingInput = 0;
  let inputEnded = false;
  const inputWrites = new Set<(status: "drained" | "uncertain") => void>();
  let releaseCommand: (released: boolean) => void = () => undefined;
  const commandReleased = new Promise<boolean>((resolve) => {
    releaseCommand = resolve;
  });
  let settleReady: (ready: boolean) => void = () => undefined;
  const ready = new Promise<boolean>((resolve) => {
    settleReady = resolve;
  });
  let settleExited: (value: LinuxMediationSessionResult) => void = () => undefined;
  const exited = new Promise<LinuxMediationSessionResult>((resolve) => {
    settleExited = resolve;
  });
  let finishing: Promise<void> | undefined;
  const options = {
    receiptDirectory: input.receiptDirectory,
    supervisor: "linux-mediation-session",
    shutdownTimeoutMs: 300,
  };
  const own = (pid: number) => {
    const acquisition = (async () => {
      const identity = await readProcessIdentity(pid);
      if (identity === undefined || receipts.some((receipt) => receipt.pid === pid))
        throw new Error("Process identity unavailable.");
      const handle = await persistProcessReceipt(
        {
          ...options,
          processIdentity: async (current) =>
            (await readProcessIdentity(current)) === identity ? identity : undefined,
        },
        input.ownerId,
        pid,
      );
      receipts.push({ pid, identity, handle });
      await handle.ready;
    })();
    acquisitions.add(acquisition);
    void acquisition
      .finally(() => acquisitions.delete(acquisition))
      .catch(() => {
        ownershipUncertain = true;
      });
    return acquisition;
  };
  const send = (tag: "L" | "E" | "X") => {
    if (!child.connected || pendingControl >= 4) return false;
    pendingControl++;
    try {
      // A false return is an accepted queued message, never a retry signal.
      child.send(tag, (error) => {
        pendingControl--;
        if (error) abort();
      });
      return true;
    } catch {
      pendingControl--;
      return false;
    }
  };
  const finish = () => {
    finishing ??= (async () => {
      phase = "stopping";
      settleReady(false);
      releaseCommand(false);
      clearTimeout(maximum);
      input.signal.removeEventListener("abort", abort);
      send("X");
      inputEnded = true;
      child.stdin?.destroy();
      for (const settle of inputWrites) settle("uncertain");
      // Let the worker close admission and let the native relay join its direct
      // command first. All waits have a host deadline; held stdio is not a join.
      const cleanupDeadline = Date.now() + CLEANUP_MS;
      const cooperativeDeadline = Date.now() + 2_000;
      while (!workerExited && Date.now() < cooperativeDeadline)
        await new Promise((resolve) => setTimeout(resolve, 10));
      let cleanup: Cleanup = ownershipUncertain ? "uncertain" : "confirmed";
      const acquired = await within(Promise.allSettled(acquisitions), 500);
      if (!acquired || ownershipUncertain) cleanup = "uncertain";
      if (receipts.length === 0 && !workerExited) {
        // The retained ChildProcess is the only available launch identity here.
        // Failed receipt acquisition never licenses a guessed process-group kill.
        child.kill("SIGTERM");
        cleanup = "uncertain";
      }
      for (const receipt of [...receipts].reverse()) {
        const removed = await within(
          (async () => {
            await terminateOwnedProcess(receipt.pid, receipt.identity, 300, readProcessIdentity);
            if ((await readProcessIdentity(receipt.pid)) !== undefined)
              throw new Error("Process still present.");
            await receipt.handle.remove();
          })(),
          cleanupDeadline - Date.now(),
        );
        if (!removed) cleanup = "uncertain";
      }
      if (!workerExited) cleanup = "uncertain";
      try {
        if (child.connected) child.disconnect();
      } catch {
        cleanup = "uncertain";
      }
      child.removeAllListeners("message");
      child.removeAllListeners("disconnect");
      child.stdout?.destroy();
      child.stderr?.destroy();
      if (!stdoutEnded || !stderrEnded) {
        stdout.destroy();
        stderr.destroy();
      }
      phase = "exited";
      settleExited({ result: result ?? { status: "unavailable", reason: "cancelled" }, cleanup });
    })();
    return finishing;
  };
  const abort = () => {
    if (phase === "exited" || phase === "stopping") return;
    result = { status: "unavailable", reason: "cancelled" };
    void finish();
  };
  const maximum = setTimeout(
    () => {
      result = { status: "unavailable", reason: "deadline" };
      void finish();
    },
    Math.max(0, deadline - Date.now()),
  );
  let sequence = Promise.resolve();
  const naturalExit = () => {
    if (workerExited && stdoutEnded && stderrEnded && ipcDisconnected) void sequence.then(finish);
  };
  child.stdout?.once("end", () => {
    stdoutEnded = true;
    naturalExit();
  });
  child.stderr?.once("end", () => {
    stderrEnded = true;
    naturalExit();
  });
  child.once("exit", () => {
    workerExited = true;
    naturalExit();
  });
  child.once("close", naturalExit);
  child.once("disconnect", () => {
    ipcDisconnected = true;
    void sequence.then(() => {
      if (result === undefined) abort();
      else naturalExit();
    });
  });
  child.on("error", () => {
    // IPC/send/kill failures do not prove that the owned process has exited.
    if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null)
      workerExited = true;
    result ??= { status: "unavailable", reason: "native-unavailable" };
    void finish();
  });
  child.stdin?.on("error", () => undefined);
  child.stdout?.on("error", abort);
  child.stderr?.on("error", abort);
  input.signal.addEventListener("abort", abort, { once: true });
  if (!child.connected || child.pid === undefined) {
    abort();
  } else {
    child.on("message", (value: unknown) => {
      if (phase === "stopping" || phase === "exited") return;
      try {
        if (++queued > 3 || Buffer.byteLength(JSON.stringify(value)) > 4_096) {
          abort();
          return;
        }
      } catch {
        abort();
        return;
      }
      sequence = sequence
        .then(async () => {
          const message = Schema.decodeUnknownSync(Message)(value, {
            onExcessProperty: "error",
          });
          if (phase === "stopping" || phase === "exited") return;
          if (message.status === "ready" && phase === "preparing") {
            await own(message.relayPid);
            if (phase !== "preparing") return;
            phase = "ready";
            settleReady(true);
          } else if (message.status === "command" && phase === "launching") {
            await own(message.pid);
            if (phase !== "launching") return;
            phase = "running";
            if (!send("E")) abort();
            else releaseCommand(true);
          } else if (message.status === "result" && result === undefined) {
            result = message.result;
          } else abort();
        })
        .catch(abort);
    });
    try {
      const owned = await Promise.race([own(child.pid).then(() => true), exited.then(() => false)]);
      if (owned && phase === "preparing" && !input.signal.aborted) {
        child.send(config, (error) => {
          if (error) abort();
        });
      } else abort();
    } catch {
      abort();
    }
  }
  if (input.signal.aborted) abort();
  if (!(await ready)) {
    const ended = await exited;
    return {
      status: "unavailable",
      reason: ended.result.status === "unavailable" ? ended.result.reason : "native-unavailable",
      cleanup: ended.cleanup,
    };
  }
  return {
    status: "ready",
    session: {
      stdout,
      stderr,
      exited,
      launch: async () => {
        if (phase !== "ready" || input.signal.aborted) return { status: "refused" };
        phase = "launching";
        if (!send("L")) {
          abort();
          return { status: "refused" };
        }
        return { status: (await commandReleased) ? "released" : "refused" };
      },
      writeInput: (bytes) => {
        if (
          phase !== "running" ||
          child.stdin === null ||
          child.stdin.destroyed ||
          inputEnded ||
          child.stdin.writableEnded ||
          !child.stdin.writable ||
          bytes.length === 0 ||
          bytes.length > IO_BYTES ||
          inputWrites.size >= 64 ||
          pendingInput + bytes.length > INPUT_BYTES
        )
          return { status: "refused" };
        pendingInput += bytes.length;
        const drained = new Promise<{ readonly status: "drained" | "uncertain" }>((resolve) => {
          const settle = (status: "drained" | "uncertain") => {
            if (!inputWrites.delete(settle)) return;
            pendingInput -= bytes.length;
            resolve({ status });
          };
          inputWrites.add(settle);
          child.stdin?.write(Buffer.from(bytes), (error) => {
            settle(error ? "uncertain" : "drained");
            if (error && phase !== "exited" && phase !== "stopping") {
              result = { status: "unavailable", reason: "native-unavailable" };
              void finish();
            }
          });
        });
        return { status: "accepted", drained };
      },
      endInput: () => {
        inputEnded = true;
        child.stdin?.end();
      },
      close: async () => {
        abort();
        const ended = await exited;
        stdout.destroy();
        stderr.destroy();
        return ended;
      },
    },
  };
}
