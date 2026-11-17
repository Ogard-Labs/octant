/** Private, separately owned policy worker. This is not a provider entry point. */
import { Schema } from "effect";
import { buildBubblewrapLaunch } from "./linuxConfinement";
import { applyProtectedFilesChoice, configureSecretGuardLocations } from "./secretGuard";
import { runLinuxMediationBroker } from "./linuxMediationBroker";
import { LinuxMediationWorkerConfig, MEDIATION_CONFIG_BYTES } from "./linuxMediationConfig";

export async function runLinuxMediationWorker(): Promise<void> {
  if (process.send === undefined || !process.connected) return;
  const owner = new AbortController();
  let configured = false;
  let received = 0;
  let queuedBytes = 0;
  let pending:
    | {
        readonly expected: string;
        readonly resolve: (accepted: boolean) => void;
      }
    | undefined;
  const disconnect = () => {
    try {
      if (process.connected) process.disconnect?.();
    } catch {
      owner.abort();
    }
  };
  const stop = () => {
    owner.abort();
    pending?.resolve(false);
    pending = undefined;
    if (!configured) {
      clearTimeout(maximum);
      disconnect();
      process.stdin.destroy();
      process.removeListener("SIGTERM", stop);
      process.removeListener("SIGINT", stop);
    }
  };
  const send = async (value: object): Promise<boolean> => {
    const bytes = Buffer.byteLength(JSON.stringify(value));
    if (
      bytes > 1_024 ||
      queuedBytes + bytes > 4_096 ||
      process.send === undefined ||
      !process.connected
    ) {
      stop();
      return false;
    }
    queuedBytes += bytes;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const sent = await new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), 1_000);
        try {
          // false means accepted backpressure. Only the callback observes loss;
          // a message is never replayed in either case.
          process.send?.(value, (error: Error | null) => resolve(!error));
        } catch {
          resolve(false);
        }
      });
      if (!sent) stop();
      return sent;
    } finally {
      clearTimeout(timer);
      queuedBytes -= bytes;
    }
  };
  const wait = (expected: string) =>
    new Promise<boolean>((resolve) => {
      if (owner.signal.aborted || pending !== undefined) {
        resolve(false);
        return;
      }
      pending = { expected, resolve };
    });
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  process.once("disconnect", stop);
  const maximum = setTimeout(stop, 180_000);
  const run = async (value: unknown) => {
    let cleanup: "confirmed" | "uncertain" = "confirmed";
    try {
      const config = Schema.decodeUnknownSync(LinuxMediationWorkerConfig)(value, {
        onExcessProperty: "error",
      });
      applyProtectedFilesChoice(config.secretGuard.choice);
      if (config.secretGuard.dataDirectory !== undefined)
        configureSecretGuardLocations({
          dataDirectory: config.secretGuard.dataDirectory,
          runtimeDirectory: config.secretGuard.runtimeDirectory,
        });
      else if (config.secretGuard.runtimeDirectory !== undefined)
        throw new Error("Invalid host setup.");
      // Synchronous filesystem preparation stays in this owned process, where
      // a cancelled host can stop it without blocking its own request loop.
      const prepared = buildBubblewrapLaunch({
        ...config.launch,
        additionalDenyReadPaths: [
          ...(config.launch.additionalDenyReadPaths ?? []),
          config.receiptDirectory,
        ],
        additionalDenyWritePaths: [
          ...(config.launch.additionalDenyWritePaths ?? []),
          config.receiptDirectory,
        ],
      });
      if (owner.signal.aborted) return;
      cleanup = "uncertain";
      const result = await runLinuxMediationBroker({
        nativeExecutable: config.nativeExecutable,
        ...(config.production === undefined ? {} : { production: config.production }),
        maximumMs: config.maximumMs,
        ...prepared,
        policy: {
          ...config.policy,
          sshCompanionDirectory: config.policy.sshCompanionDirectory,
        },
        signal: owner.signal,
        lifecycle: {
          stdio: [process.stdin, process.stdout, process.stderr],
          ...(config.inheritStdio === undefined ? {} : { inheritStdio: config.inheritStdio }),
          environment: config.environment,
          cleanup: (certainty) => {
            cleanup = certainty;
          },
          ready: async (relayPid) => {
            const accepted = wait("L");
            if (!(await send({ status: "ready", relayPid }))) return false;
            return accepted;
          },
          command: async (pid) => {
            const accepted = wait("E");
            if (!(await send({ status: "command", pid }))) return false;
            return accepted;
          },
        },
      });
      await send({ status: "result", result, cleanup });
    } catch {
      await send({
        status: "result",
        result: { status: "unavailable", reason: "broker-protocol" },
        cleanup,
      });
    } finally {
      clearTimeout(maximum);
      stop();
      process.removeListener("SIGTERM", stop);
      process.removeListener("SIGINT", stop);
      process.removeListener("message", receive);
      process.removeListener("disconnect", stop);
      disconnect();
      process.stdin.destroy();
    }
  };
  const receive = (value: unknown) => {
    if (owner.signal.aborted) return;
    try {
      if (++received > 4 || Buffer.byteLength(JSON.stringify(value)) > MEDIATION_CONFIG_BYTES) {
        stop();
        return;
      }
    } catch {
      stop();
      return;
    }
    if (!configured) {
      if (value === "X") {
        stop();
        return;
      }
      configured = true;
      void run(value);
      return;
    }
    if (value === "X") {
      stop();
      return;
    }
    if (pending === undefined || value !== pending.expected) {
      stop();
      return;
    }
    const accept = pending.resolve;
    pending = undefined;
    accept(true);
  };
  process.on("message", receive);
}

if (import.meta.main) await runLinuxMediationWorker();
