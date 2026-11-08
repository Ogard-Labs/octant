/** Private, separately owned policy worker. This is not a provider entry point. */
import { Schema } from "effect";
import { BuiltInProtectedFilesId, ProtectedFilesChannel } from "@octant/contracts/protected-files";
import { Socket } from "node:net";
import { buildBubblewrapLaunch } from "./linuxConfinement";
import type { ProcessConfinementPrepareInput } from "./seatbeltProfile";
import { applyProtectedFilesChoice, configureSecretGuardLocations } from "./secretGuard";
import { runLinuxMediationBroker } from "./linuxMediationBroker";

export const MEDIATION_CONFIG_BYTES = 262_144;
const path = Schema.String.pipe(
  Schema.maxLength(8_192),
  Schema.filter((s) => s.startsWith("/") && !s.includes("\0")),
);
const meta = {
  ruleId: Schema.Union(BuiltInProtectedFilesId, Schema.Literal("added")),
  label: Schema.String,
  channel: ProtectedFilesChannel,
  ownAccountExempt: Schema.Boolean,
};
const text = Schema.String.pipe(Schema.filter((s) => !s.includes("\0")));
const optionalPaths = Schema.optionalWith(Schema.Array(path), { exact: true });
const optionalBoolean = Schema.optionalWith(Schema.Boolean, { exact: true });
const port = Schema.Int.pipe(Schema.between(1, 65_535));
const launch: Schema.Schema<ProcessConfinementPrepareInput> = Schema.Struct({
  executable: path,
  args: Schema.Array(text),
  boundRoot: path,
  temporaryDirectory: path,
  networkEgress: Schema.Union(
    Schema.Literal("none", "allow"),
    Schema.Struct({
      kind: Schema.Literal("proxied"),
      endpoint: Schema.Union(
        Schema.Struct({ kind: Schema.Literal("loopback"), port }),
        Schema.Struct({ kind: Schema.Literal("unix-socket"), path }),
      ),
    }),
  ),
  recipientAdmission: Schema.optionalWith(Schema.Struct({ digest: text, identity: text }), {
    exact: true,
  }),
  extraBoundRoots: optionalPaths,
  additionalWriteRoots: optionalPaths,
  readRoots: optionalPaths,
  interpreterSearchPath: Schema.optionalWith(text, { exact: true }),
  allowProcessExec: optionalBoolean,
  allowProcessFork: optionalBoolean,
  allowFileReadStar: optionalBoolean,
  writeBoundRoot: optionalBoolean,
  allowSimulatorControl: optionalBoolean,
  refuseNewSession: optionalBoolean,
  additionalDenyReadPaths: optionalPaths,
  additionalDenyWritePaths: optionalPaths,
  isolatedRoots: optionalPaths,
  privateHomeAllowPaths: optionalPaths,
  ownAccountPaths: optionalPaths,
  ownAccountAccess: Schema.optionalWith(Schema.Literal("none"), { exact: true }),
  extraRules: Schema.optionalWith(Schema.Array(text), { exact: true }),
  terminal: Schema.optionalWith(Schema.Struct({ shellStateDirectory: path }), { exact: true }),
  inboundRelay: Schema.optionalWith(Schema.Struct({ socketPath: path, port }), { exact: true }),
  loopbackRelayPorts: Schema.optionalWith(Schema.Array(port), { exact: true }),
  serverRelays: Schema.optionalWith(Schema.Array(Schema.Struct({ socketPath: path, port })), {
    exact: true,
  }),
});
export const LinuxMediationWorkerConfig = Schema.Struct({
  nativeExecutable: path,
  launch,
  receiptDirectory: path,
  environment: Schema.Record({ key: text, value: text }),
  secretGuard: Schema.Struct({
    dataDirectory: Schema.optional(path),
    runtimeDirectory: Schema.optional(path),
    choice: Schema.Struct({
      added: Schema.Array(text),
      removed: Schema.Array(BuiltInProtectedFilesId),
    }),
  }),
  policy: Schema.Struct({
    entries: Schema.Array(
      Schema.Union(
        Schema.Struct({ ...meta, kind: Schema.Literal("path"), path }),
        Schema.Struct({
          ...meta,
          kind: Schema.Literal("names"),
          directory: path,
          name: Schema.String,
          depth: Schema.Number.pipe(Schema.int(), Schema.between(0, 64)),
          except: Schema.optionalWith(Schema.String, { exact: true }),
        }),
      ),
    ).pipe(Schema.maxItems(1_024)),
    ownAccountPaths: Schema.Array(path).pipe(Schema.maxItems(1_024)),
    sshCompanionDirectory: Schema.optional(path),
  }),
});
export type LinuxMediationWorkerConfig = typeof LinuxMediationWorkerConfig.Type;

export async function runLinuxMediationWorker(): Promise<void> {
  const control = new Socket({ fd: 3, readable: true, writable: true });
  const owner = new AbortController();
  let buffer = Buffer.alloc(0);
  let configured = false;
  let pending:
    | { readonly expected: string; readonly resolve: (accepted: boolean) => void }
    | undefined;
  const stop = () => {
    owner.abort();
    pending?.resolve(false);
    pending = undefined;
    if (!configured) {
      clearTimeout(maximum);
      control.destroy();
      process.stdin.destroy();
      process.removeListener("SIGTERM", stop);
      process.removeListener("SIGINT", stop);
    }
  };
  const send = (value: object) => {
    const frame = Buffer.from(`${JSON.stringify(value)}\n`);
    if (
      frame.length > 1_024 ||
      control.destroyed ||
      control.writableLength + frame.length > 4_096
    ) {
      stop();
      return false;
    }
    control.write(frame);
    return true;
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
  control.once("error", stop);
  control.once("end", stop);
  control.once("close", stop);
  const maximum = setTimeout(stop, 180_000);
  const run = async (value: unknown) => {
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
      const result = await runLinuxMediationBroker({
        nativeExecutable: config.nativeExecutable,
        ...prepared,
        policy: { ...config.policy, sshCompanionDirectory: config.policy.sshCompanionDirectory },
        signal: owner.signal,
        lifecycle: {
          stdio: [process.stdin, process.stdout, process.stderr],
          environment: config.environment,
          ready: async (relayPid) => {
            const accepted = wait("L");
            if (!send({ status: "ready", relayPid })) return false;
            return accepted;
          },
          command: async (pid) => {
            const accepted = wait("E");
            if (!send({ status: "command", pid })) return false;
            return accepted;
          },
        },
      });
      send({ status: "result", result });
    } catch {
      send({ status: "result", result: { status: "unavailable", reason: "broker-protocol" } });
    } finally {
      clearTimeout(maximum);
      stop();
      process.removeListener("SIGTERM", stop);
      process.removeListener("SIGINT", stop);
      control.end(() => control.destroy());
      process.stdin.destroy();
    }
  };
  control.on("data", (chunk: Buffer) => {
    if (owner.signal.aborted || buffer.length + chunk.length > MEDIATION_CONFIG_BYTES + 4) {
      stop();
      return;
    }
    buffer = Buffer.concat([buffer, chunk]);
    if (!configured) {
      if (buffer.length < 4) return;
      const size = buffer.readUInt32LE(0);
      if (size < 2 || size > MEDIATION_CONFIG_BYTES) {
        stop();
        return;
      }
      if (buffer.length < size + 4) return;
      const encoded = buffer.subarray(4, size + 4);
      buffer = buffer.subarray(size + 4);
      configured = true;
      try {
        void run(JSON.parse(encoded.toString("utf8")));
      } catch {
        configured = false;
        stop();
      }
    }
    while (buffer.length > 0 && !owner.signal.aborted) {
      const tag = String.fromCharCode(buffer[0] ?? 0);
      buffer = buffer.subarray(1);
      if (tag === "X") {
        stop();
        return;
      }
      if (pending === undefined || tag !== pending.expected) {
        stop();
        return;
      }
      const accept = pending.resolve;
      pending = undefined;
      accept(true);
    }
  });
}

if (import.meta.main) await runLinuxMediationWorker();
