import { spawn } from "node:child_process";
import { win32 } from "node:path";
import type { WindowsCommandExecutor } from "@octant/host-runtime";
import type { KeychainHelperExecutor } from "./hostIdentityKeychain";
import type { KeychainServiceFamily } from "./keychainCredentialStore";

export function isWindowsHostIdentityHelperPath(path: string): boolean {
  return (
    /^(?:\\\\\?\\)?[a-z]:\\/i.test(path) &&
    !path.includes("\0") &&
    win32.normalize(path) === path &&
    win32.basename(path) === "octant-credential-helper.exe"
  );
}

/** The existing service owns the public contract; only this private pipe differs. */
export function makeWindowsHostSigningExecutor(
  family: KeychainServiceFamily = "octant",
  execute: WindowsCommandExecutor = executeWindowsIdentityCommand,
): KeychainHelperExecutor {
  if (family !== "octant" && family !== "octant-nightly-test-data")
    throw new Error("Invalid identity family.");
  return async (spec, limits) => {
    if (Buffer.byteLength(spec.stdin) > 16 * 1024)
      throw new Error("Native identity request exceeds its bound.");
    const value: unknown = JSON.parse(spec.stdin);
    const expectedArgs = family === "octant" ? [] : ["--service-family=octant-nightly-test-data"];
    if (
      !isWindowsHostIdentityHelperPath(spec.command) ||
      spec.args.length !== expectedArgs.length ||
      spec.args.some((arg, i) => arg !== expectedArgs[i]) ||
      !isRecord(value) ||
      value.version !== 1 ||
      value.namespace !== "app.octant.host-identity.v1" ||
      value.keyId !== "host-identity" ||
      typeof value.storeScope !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value.storeScope)
    )
      throw new Error("Invalid native identity request.");
    const operation =
      value.operation === "ensure"
        ? 1
        : value.operation === "sign"
          ? 2
          : value.operation === "rotate"
            ? 3
            : 0;
    const allowed = [
      "version",
      "namespace",
      "keyId",
      "storeScope",
      "operation",
      ...(operation === 1 ? ["expectedFingerprint"] : operation === 2 ? ["payload"] : []),
    ];
    if (
      !operation ||
      Object.keys(value).some((key) => !allowed.includes(key)) ||
      (value.expectedFingerprint !== undefined &&
        (typeof value.expectedFingerprint !== "string" ||
          !/^[0-9a-f]{64}$/.test(value.expectedFingerprint)))
    )
      throw new Error("Invalid native identity request.");
    if (operation === 2 && (typeof value.payload !== "string" || value.payload.length === 0))
      throw new Error("Invalid native identity payload.");
    const payload =
      operation === 2 && typeof value.payload === "string"
        ? Buffer.from(value.payload, "base64")
        : Buffer.alloc(0);
    if (operation === 2 && (payload.length === 0 || payload.toString("base64") !== value.payload)) {
      payload.fill(0);
      throw new Error("Invalid native identity payload.");
    }
    const input = Buffer.alloc(47 + payload.length);
    input.write("OCHI");
    input[4] = 1;
    input[5] = operation;
    input[6] = family === "octant" ? 0 : 1;
    input.write(value.storeScope, 7, "ascii");
    input.writeUInt32LE(payload.length, 43);
    payload.copy(input, 47);
    payload.fill(0);
    // A Windows identity has no former singleton. Valid Mac legacy proof must
    // never authorize adopting another namespace or an unscoped Windows key.
    try {
      const result = await execute(
        { command: spec.command, args: [], environment: {}, input },
        limits,
      );
      const stdout = Buffer.from(
        result.stdout.buffer,
        result.stdout.byteOffset,
        result.stdout.byteLength,
      );
      try {
        return { exitCode: result.exitCode, stdout: stdout.toString("utf8"), stderr: "" };
      } finally {
        stdout.fill(0);
      }
    } finally {
      input.fill(0);
    }
  };
}

const executeWindowsIdentityCommand: WindowsCommandExecutor = async (spec, limits) =>
  await new Promise((accept, refuse) => {
    const child = spawn(spec.command, [], {
      env: {},
      cwd: win32.dirname(spec.command),
      stdio: ["pipe", "pipe", "ignore"],
      shell: false,
      windowsHide: true,
    });
    const chunks: Buffer[] = [];
    let bytes = 0;
    let failed = false;
    const stop = () => {
      failed = true;
      child.stdin.destroy();
      child.kill();
    };
    const timer = setTimeout(stop, limits.timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > limits.maxBytes) {
        chunk.fill(0);
        stop();
      } else chunks.push(chunk);
    });
    child.stdin.on("error", stop);
    child.once("error", () => {
      failed = true;
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      const stdout = Buffer.concat(chunks);
      for (const chunk of chunks) chunk.fill(0);
      if (failed) {
        stdout.fill(0);
        refuse(new Error("Native identity execution unavailable."));
      } else accept({ exitCode: code, stdout });
    });
    child.stdin.end(spec.input);
  });

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
