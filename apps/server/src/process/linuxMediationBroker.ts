import { stat } from "node:fs/promises";
import { spawn } from "node:child_process";
import { endianness } from "node:os";
import { Duplex } from "node:stream";
import { classifyLinuxMediationMutation } from "./linuxMediationNamespace";
import type { SecretGuardMediationPolicy } from "./secretGuard";
import {
  linuxMediationObjectKey,
  readLinuxMediationPolicy,
  type LinuxMediationNamespace,
} from "./linuxMediationPolicy";

const REQUEST_BYTES = 608;
const STATUS_BYTES = 24;
const MAX_CONTROL_BYTES = 4_096;
const CONTROL_DEADLINE_MS = 500;
const POLICY_DEADLINE_MS = 1_500;
const MAXIMUM_MS = 180_000;

type BrokerRefusal =
  | "unsupported-platform"
  | "native-unavailable"
  | "broker-protocol"
  | "policy-unavailable"
  | "cancelled"
  | "deadline";
export type LinuxMediationBrokerResult =
  | { readonly status: "exited"; readonly code: number }
  | { readonly status: "unavailable"; readonly reason: BrokerRefusal };

/**
 * Runs in the separately owned policy process, never in the app request loop.
 * The original native relay owns enrollment and the command's process group.
 * Its private FD 3 carries no command output or credential material. This
 * candidate deliberately requires production_coverage=0 and is not a shipped
 * confinement backend; the full namespace classifier/launch proof is pending.
 */
export async function runLinuxMediationBroker(input: {
  readonly nativeExecutable: string;
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly policy: SecretGuardMediationPolicy;
  readonly signal: AbortSignal;
}): Promise<LinuxMediationBrokerResult> {
  if (process.platform !== "linux" || endianness() !== "LE")
    return { status: "unavailable", reason: "unsupported-platform" };
  if (input.signal.aborted) return { status: "unavailable", reason: "cancelled" };
  if (!input.nativeExecutable.startsWith("/") || !input.command.startsWith("/"))
    return { status: "unavailable", reason: "native-unavailable" };
  return new Promise((resolve) => {
    const child = spawn(input.nativeExecutable, [input.command, ...input.args], {
      stdio: ["inherit", "inherit", "inherit", "pipe"],
      windowsHide: true,
    });
    const control = child.stdio[3];
    let refusal: BrokerRefusal | undefined;
    let settled = false;
    let working = false;
    let commandExit: number | undefined;
    let previousRequest = 0n;
    let bytes = Buffer.alloc(0);
    let statusWait:
      | {
          readonly accept: (value: LinuxMediationNamespace | undefined) => void;
          readonly timer: ReturnType<typeof setTimeout>;
        }
      | undefined;
    let parentWait:
      | {
          readonly requestId: bigint;
          readonly side: number;
          readonly accept: (
            value:
              | { readonly path: string; readonly mount: bigint; readonly object: string }
              | undefined,
          ) => void;
        }
      | undefined;
    let policyTimer: ReturnType<typeof setTimeout> | undefined;
    let stopTimer: ReturnType<typeof setTimeout> | undefined;
    const maximum = setTimeout(() => refuse("deadline"), MAXIMUM_MS);
    const stop = () => {
      if (stopTimer !== undefined || settled) return;
      // The native relay first closes the kernel context, then kills/joins
      // only its retained command group. Its independent alarm is a fallback.
      child.kill("SIGTERM");
      stopTimer = setTimeout(() => child.kill("SIGKILL"), 3_000);
    };
    const refuse = (reason: BrokerRefusal) => {
      refusal ??= reason;
      statusWait?.accept(undefined);
      parentWait?.accept(undefined);
      stop();
    };
    const abort = () => refuse("cancelled");
    const complete = (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(maximum);
      clearTimeout(policyTimer);
      clearTimeout(stopTimer);
      statusWait?.accept(undefined);
      parentWait?.accept(undefined);
      input.signal.removeEventListener("abort", abort);
      control?.removeAllListeners("data");
      control?.destroy();
      resolve(
        refusal !== undefined
          ? { status: "unavailable", reason: refusal }
          : code === 0 && commandExit !== undefined
            ? { status: "exited", code: commandExit }
            : { status: "unavailable", reason: "native-unavailable" },
      );
    };
    child.once("error", () => {
      refusal ??= "native-unavailable";
    });
    child.once("close", complete);
    input.signal.addEventListener("abort", abort, { once: true });
    if (!(control instanceof Duplex)) {
      refuse("native-unavailable");
      return;
    }
    const write = (frame: Buffer) => {
      if (settled || refusal !== undefined || !control.writable) return false;
      // At most one request and one status query are outstanding. Refuse an
      // unexpected backlog rather than queue another unbounded control write.
      if (control.writableLength + frame.length > MAX_CONTROL_BYTES) {
        refuse("broker-protocol");
        return false;
      }
      control.write(frame);
      return true;
    };
    const readNamespace = () =>
      new Promise<LinuxMediationNamespace | undefined>((accept) => {
        if (settled || refusal !== undefined || statusWait !== undefined) {
          accept(undefined);
          return;
        }
        const timer = setTimeout(() => {
          statusWait = undefined;
          accept(undefined);
          refuse("broker-protocol");
        }, CONTROL_DEADLINE_MS);
        statusWait = {
          timer,
          accept: (value) => {
            clearTimeout(timer);
            statusWait = undefined;
            accept(value);
          },
        };
        if (!write(Buffer.from("S"))) statusWait?.accept(undefined);
      });
    const readParent = (request: Buffer, side: number) =>
      new Promise<
        { readonly path: string; readonly mount: bigint; readonly object: string } | undefined
      >((accept) => {
        if (
          settled ||
          refusal !== undefined ||
          parentWait !== undefined ||
          child.pid === undefined
        ) {
          accept(undefined);
          return;
        }
        const timer = setTimeout(() => {
          parentWait = undefined;
          accept(undefined);
          refuse("broker-protocol");
        }, CONTROL_DEADLINE_MS);
        const requestId = request.readBigUInt64LE(0);
        parentWait = {
          requestId,
          side,
          accept: (value) => {
            clearTimeout(timer);
            parentWait = undefined;
            accept(value);
          },
        };
        const frame = Buffer.alloc(13);
        frame[0] = 80;
        frame.writeBigUInt64LE(requestId, 1);
        frame.writeUInt32LE(side, 9);
        if (!write(frame)) parentWait?.accept(undefined);
      });
    const verifyParent = async (request: Buffer, side: number) => {
      const before = await readParent(request, side);
      if (before === undefined) return undefined;
      const offset = 48 + side * 280;
      const expected = `${request.readUInt32LE(offset + 8)}:${request.readUInt32LE(offset + 12)}:${request.readBigUInt64LE(offset)}`;
      const identity = await stat(before.path, { bigint: true });
      if (
        !identity.isDirectory() ||
        linuxMediationObjectKey(identity) !== expected ||
        before.object !== expected
      )
        return undefined;
      const after = await readParent(request, side);
      return after !== undefined &&
        after.mount === before.mount &&
        after.path === before.path &&
        after.object === expected
        ? before
        : undefined;
    };
    const answer = async (request: Buffer) => {
      if (working) {
        refuse("broker-protocol");
        return;
      }
      working = true;
      policyTimer = setTimeout(() => refuse("policy-unavailable"), POLICY_DEADLINE_MS);
      try {
        const operation = request.readUInt32LE(32);
        const namespace = async () => (await readNamespace()) ?? { epoch: 0n, activeMutations: 1 };
        let allow = false;
        let epoch = 0n;
        if (operation >= 5 && operation <= 7) {
          const source = await verifyParent(request, 0);
          const destination = operation === 7 ? await verifyParent(request, 1) : undefined;
          if (source === undefined || (operation === 7 && destination === undefined)) {
            refuse("broker-protocol");
            return;
          }
          const sourceLength = request.readUInt32LE(64);
          const destinationLength = request.readUInt32LE(344);
          if (
            sourceLength < 1 ||
            sourceLength > 255 ||
            (destination !== undefined && (destinationLength < 1 || destinationLength > 255))
          ) {
            refuse("broker-protocol");
            return;
          }
          const decision = await classifyLinuxMediationMutation(
            input.policy,
            {
              operation: operation === 5 ? "unlink" : operation === 6 ? "rmdir" : "rename",
              source: {
                parent: source.path,
                name: Buffer.from(request.subarray(72, 72 + sourceLength)),
              },
              ...(destination === undefined
                ? {}
                : {
                    destination: {
                      parent: destination.path,
                      name: Buffer.from(request.subarray(352, 352 + destinationLength)),
                    },
                  }),
              flags: request.readUInt32LE(40),
            },
            namespace,
          );
          const currentSource = await verifyParent(request, 0);
          const currentDestination =
            destination === undefined ? undefined : await verifyParent(request, 1);
          if (
            currentSource?.mount !== source.mount ||
            currentSource.path !== source.path ||
            (destination !== undefined &&
              (currentDestination?.mount !== destination.mount ||
                currentDestination.path !== destination.path))
          ) {
            refuse("broker-protocol");
            return;
          }
          allow = decision.status === "allowed";
          epoch = decision.epoch;
        } else {
          const snapshot = await readLinuxMediationPolicy(input.policy, namespace);
          const object = `${request.readUInt32LE(24)}:${request.readUInt32LE(28)}:${request.readBigUInt64LE(16)}`;
          allow =
            snapshot.status === "ready" &&
            operation >= 1 &&
            operation <= 4 &&
            !snapshot.protectedObjects.has(object);
          epoch = snapshot.status === "ready" ? snapshot.epoch : 0n;
        }
        if (settled || refusal !== undefined) return;
        const response = Buffer.alloc(25);
        response[0] = "A".charCodeAt(0);
        response.writeBigUInt64LE(request.readBigUInt64LE(0), 1);
        response.writeBigUInt64LE(epoch, 9);
        response.writeUInt32LE(allow ? 1 : 0, 17);
        write(response);
      } finally {
        clearTimeout(policyTimer);
        policyTimer = undefined;
        working = false;
      }
    };
    control.on("error", () => refuse("broker-protocol"));
    control.on("data", (chunk: Buffer) => {
      if (settled || refusal !== undefined) return;
      if (bytes.length + chunk.length > MAX_CONTROL_BYTES) {
        refuse("broker-protocol");
        return;
      }
      bytes = Buffer.concat([bytes, chunk]);
      while (bytes.length > 0 && refusal === undefined) {
        const tag = bytes[0];
        const length =
          tag === 82
            ? REQUEST_BYTES
            : tag === 83
              ? STATUS_BYTES
              : tag === 80
                ? 40
                : tag === 88
                  ? 4
                  : -1;
        if (length < 0) {
          refuse("broker-protocol");
          return;
        }
        if (bytes.length < length + 1) return;
        const frame = bytes.subarray(1, length + 1);
        bytes = bytes.subarray(length + 1);
        if (tag === 82) {
          const requestId = frame.readBigUInt64LE(0);
          if (
            requestId <= previousRequest ||
            frame.readUInt32LE(36) !== 0 ||
            frame.readUInt32LE(44) !== 0
          ) {
            refuse("broker-protocol");
            return;
          }
          previousRequest = requestId;
          void answer(frame).catch(() => refuse("policy-unavailable"));
        } else if (tag === 83) {
          if (
            statusWait === undefined ||
            frame.readUInt32LE(12) !== 2 ||
            frame.readBigUInt64LE(16) !== 0n
          ) {
            refuse("broker-protocol");
            return;
          }
          statusWait.accept({
            epoch: frame.readBigUInt64LE(0),
            activeMutations: frame.readUInt32LE(8),
          });
        } else if (tag === 80) {
          const descriptor = frame.readUInt32LE(32);
          const mount = frame.readBigUInt64LE(8);
          if (
            parentWait === undefined ||
            child.pid === undefined ||
            frame.readBigUInt64LE(0) !== parentWait.requestId ||
            frame.readUInt32LE(36) !== parentWait.side ||
            descriptor < 3 ||
            descriptor > 1_024 ||
            mount === 0n
          ) {
            refuse("broker-protocol");
            return;
          }
          parentWait.accept({
            path: `/proc/${child.pid}/fd/${descriptor}`,
            mount,
            object: `${frame.readUInt32LE(24)}:${frame.readUInt32LE(28)}:${frame.readBigUInt64LE(16)}`,
          });
        } else {
          if (working || commandExit !== undefined) {
            refuse("broker-protocol");
            return;
          }
          commandExit = frame.readUInt32LE(0);
        }
      }
    });
    if (input.signal.aborted) abort();
  });
}
