import { spawn } from "node:child_process";
import { win32 } from "node:path";
import { CredentialStoreFailure, type CredentialStore } from "./credentialStore";
import type { KeychainServiceFamily } from "./desktopIdentity";

/** Win32's one atomic generic credential blob is limited to 5 * 512 bytes. */
export const WINDOWS_CREDENTIAL_MAX_BYTES = 2_560;
const NAMESPACES = [
  "provider",
  "replica-device-key",
  "replica-store-credential",
  "canvas-public-share-secret",
  "mcp-server-credential",
  "desktop-provider-credential",
  "push-platform-credential",
  "ssh-key",
] as const;
export type WindowsCredentialNamespace = (typeof NAMESPACES)[number];
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MAGIC = "OCCR";
const RESPONSE_HEADER_BYTES = 9;

export interface WindowsCommandSpec {
  readonly command: string;
  readonly args: readonly string[];
  readonly environment: Readonly<Record<string, string>>;
  readonly input: Uint8Array;
}
export interface WindowsCommandResult {
  readonly exitCode: number | null;
  readonly stdout: Uint8Array;
}
export interface WindowsCommandLimits {
  readonly timeoutMs: number;
  readonly maxBytes: number;
}
export type WindowsCommandExecutor = (
  spec: WindowsCommandSpec,
  limits: WindowsCommandLimits,
) => Promise<WindowsCommandResult>;
export interface MakeWindowsCredentialStoreOptions {
  readonly helperPath: string;
  readonly storeScope: string;
  readonly serviceFamily?: KeychainServiceFamily;
  readonly namespace?: WindowsCredentialNamespace;
  readonly timeoutMs?: number;
  readonly execute?: WindowsCommandExecutor;
}

/**
 * Only the credential broker receives this store. The native helper owns one
 * closed purpose namespace; it never accepts a target name or enumerates keys.
 * No unscoped legacy target is read, migrated or removed implicitly.
 */
export function makeWindowsCredentialStore(
  options: MakeWindowsCredentialStoreOptions,
): CredentialStore {
  const timeoutMs = options.timeoutMs ?? 5_000;
  const purpose = NAMESPACES.indexOf(
    options.namespace === undefined ? "provider" : options.namespace,
  );
  if (
    purpose < 0 ||
    !/^(?:\\\\\?\\)?[a-z]:\\/i.test(options.helperPath) ||
    options.helperPath.includes("\0") ||
    win32.basename(options.helperPath) !== "octant-credential-helper.exe" ||
    win32.normalize(options.helperPath) !== options.helperPath ||
    !UUID_PATTERN.test(options.storeScope) ||
    (options.serviceFamily !== undefined &&
      options.serviceFamily !== "octant" &&
      options.serviceFamily !== "octant-nightly-test-data") ||
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > 30_000
  )
    throw new CredentialStoreFailure("invalid");
  const execute = options.execute ?? executeWindowsCommand;
  const request = async (operation: number, ref: string, credential?: string): Promise<Buffer> => {
    if (!UUID_PATTERN.test(ref)) throw new CredentialStoreFailure("invalid");
    const value = Buffer.from(credential ?? "", "utf8");
    if (
      operation === 1 &&
      (value.length === 0 ||
        value.length > WINDOWS_CREDENTIAL_MAX_BYTES ||
        value.toString("utf8") !== credential)
    ) {
      value.fill(0);
      throw new CredentialStoreFailure("invalid");
    }
    const input = Buffer.alloc(84 + value.length);
    input.write(MAGIC, 0, "ascii");
    input[4] = 2;
    input[5] = operation;
    input[6] = options.serviceFamily === "octant-nightly-test-data" ? 1 : 0;
    input.write(options.storeScope, 7, "ascii");
    input.write(ref, 43, "ascii");
    input.writeUInt32LE(value.length, 79);
    input[83] = purpose;
    value.copy(input, 84);
    value.fill(0);
    let output: Buffer | undefined;
    try {
      const result = await execute(
        { command: options.helperPath, args: [], environment: {}, input },
        {
          timeoutMs,
          maxBytes: RESPONSE_HEADER_BYTES + WINDOWS_CREDENTIAL_MAX_BYTES,
        },
      );
      output = Buffer.from(
        result.stdout.buffer,
        result.stdout.byteOffset,
        result.stdout.byteLength,
      );
      if (
        result.exitCode !== 0 ||
        output.length < RESPONSE_HEADER_BYTES ||
        output.length > RESPONSE_HEADER_BYTES + WINDOWS_CREDENTIAL_MAX_BYTES ||
        !output.subarray(0, 4).equals(Buffer.from(MAGIC, "ascii")) ||
        output.readUInt32LE(5) !== output.length - RESPONSE_HEADER_BYTES
      )
        throw new CredentialStoreFailure("failed");
      const status = output[4];
      if (status !== 0) {
        if (output.length !== RESPONSE_HEADER_BYTES) throw new CredentialStoreFailure("failed");
        throw new CredentialStoreFailure(
          status === 1
            ? "missing"
            : status === 2
              ? "invalid"
              : status === 3
                ? "unavailable"
                : "failed",
        );
      }
      if (operation !== 3 && output.length !== RESPONSE_HEADER_BYTES)
        throw new CredentialStoreFailure("failed");
      return Buffer.from(output.subarray(RESPONSE_HEADER_BYTES));
    } catch (error) {
      if (error instanceof CredentialStoreFailure) throw error;
      throw new CredentialStoreFailure("unavailable");
    } finally {
      input.fill(0);
      output?.fill(0);
    }
  };
  return {
    set: async (ref, credential) => {
      await request(1, ref, credential);
    },
    has: async (ref) => {
      try {
        await request(2, ref);
        return true;
      } catch (error) {
        if (error instanceof CredentialStoreFailure && error.category === "missing") return false;
        throw error;
      }
    },
    resolve: async (ref) => {
      const value = await request(3, ref);
      try {
        const decoded = value.toString("utf8");
        if (value.length === 0 || !Buffer.from(decoded, "utf8").equals(value))
          throw new CredentialStoreFailure("failed");
        return decoded;
      } finally {
        value.fill(0);
      }
    },
    delete: async (ref) => {
      await request(4, ref);
    },
  };
}

async function executeWindowsCommand(
  spec: WindowsCommandSpec,
  limits: WindowsCommandLimits,
): Promise<WindowsCommandResult> {
  return await new Promise((resolve, reject) => {
    const child = spawn(spec.command, [...spec.args], {
      env: spec.environment,
      cwd: win32.dirname(spec.command),
      stdio: ["pipe", "pipe", "ignore"],
      shell: false,
      windowsHide: true,
    });
    const chunks: Buffer[] = [];
    let bytes = 0;
    let failure: CredentialStoreFailure | undefined;
    const stop = (cause?: "timed-out") => {
      failure ??= new CredentialStoreFailure("unavailable", cause);
      child.stdin.destroy();
      child.kill();
    };
    const timer = setTimeout(() => stop("timed-out"), limits.timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > limits.maxBytes) {
        chunk.fill(0);
        stop();
      } else chunks.push(chunk);
    });
    child.stdin.on("error", () => stop());
    child.once("error", () => {
      failure ??= new CredentialStoreFailure("unavailable", "no-tool");
    });
    // close joins the process AND its pipes; rejecting at the timeout alone
    // would leave an owned credential process running after the broker returns.
    child.once("close", (code) => {
      clearTimeout(timer);
      const stdout = Buffer.concat(chunks);
      for (const chunk of chunks) chunk.fill(0);
      if (failure !== undefined) {
        stdout.fill(0);
        reject(failure);
      } else resolve({ exitCode: code, stdout });
    });
    child.stdin.end(spec.input);
  });
}
