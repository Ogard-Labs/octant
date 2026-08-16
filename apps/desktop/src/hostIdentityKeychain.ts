import { spawn } from "node:child_process";
import { isAbsolute } from "node:path";
import { KEYCHAIN_STORE_SCOPE_PATTERN } from "./keychainCredentialStore";

export const HOST_IDENTITY_KEYCHAIN_NAMESPACE = "app.octant.host-identity.v1" as const;
export const HOST_IDENTITY_KEY_ID = "host-identity" as const;
export const HOST_IDENTITY_HELPER_MAX_BYTES = 16 * 1_024;
const DEFAULT_TIMEOUT_MS = 2_000;

export type HostSigningHelperRequest =
  | {
      readonly operation: "ensure";
      readonly keyId: string;
      /**
       * Fingerprint persisted by the selected store before Keychain scoping.
       * It is the sole proof that can authorize moving a legacy singleton key.
       */
      readonly expectedFingerprint?: string;
    }
  | {
      readonly operation: "sign";
      readonly keyId: string;
      readonly payload: string;
    }
  | { readonly operation: "rotate"; readonly keyId: string };

export interface HostSigningHelperSpec {
  readonly command: string;
  readonly args: readonly string[];
  readonly stdin: string;
}

export interface HostSigningHelperResult {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

export interface HostSigningHelperLimits {
  readonly maxBytes: number;
  readonly timeoutMs: number;
}

export type KeychainHelperExecutor = (
  spec: HostSigningHelperSpec,
  limits: HostSigningHelperLimits,
) => Promise<HostSigningHelperResult>;

export type HostIdentitySigningFailureCategory = "failed" | "invalid" | "missing" | "unavailable";

const FAILURE_MESSAGES: Readonly<Record<HostIdentitySigningFailureCategory, string>> = {
  failed: "The secure host-identity operation failed.",
  invalid: "The host-identity request is invalid.",
  missing: "No host-identity key is available.",
  unavailable:
    "The secure host-identity store is unavailable. Remote identity remains recovery-only while local desktop stays usable.",
};

export class HostIdentitySigningFailure extends Error {
  constructor(readonly category: HostIdentitySigningFailureCategory) {
    super(FAILURE_MESSAGES[category]);
    this.name = "HostIdentitySigningFailure";
  }
}

export interface HostIdentitySigningService {
  readonly ensureIdentityKey: (
    expectedFingerprint?: string,
  ) => Promise<{ readonly fingerprint: string }>;
  readonly sign: (
    payload: Uint8Array,
    expectedFingerprint?: string,
  ) => Promise<{ readonly fingerprint: string; readonly signature: string }>;
  readonly rotateIdentityKey: () => Promise<{ readonly fingerprint: string }>;
  readonly probeRecoveryState: (expectedFingerprint?: string) => Promise<HostIdentityRecoveryState>;
}

export type HostIdentityRecoveryState =
  | {
      readonly status: "ready";
      readonly reason: null;
      readonly remoteIdentityUsable: true;
      readonly localDesktopUsable: true;
      readonly fingerprint: string;
    }
  | {
      readonly status: "recovery-required";
      readonly reason: HostIdentitySigningFailureCategory;
      readonly remoteIdentityUsable: false;
      readonly localDesktopUsable: true;
    };

export function hostSigningHelperSpec(
  command: string,
  request: HostSigningHelperRequest,
  storeScope: string,
): HostSigningHelperSpec {
  return {
    command,
    args: [],
    stdin: `${JSON.stringify({ version: 1, namespace: HOST_IDENTITY_KEYCHAIN_NAMESPACE, storeScope, ...request })}\n`,
  };
}

export type HostSigningResponse =
  | {
      readonly version: 1;
      readonly ok: true;
      readonly operation: "ensure" | "sign" | "rotate";
      readonly keyId: string;
      readonly fingerprint: string;
      readonly signature?: string;
    }
  | {
      readonly version: 1;
      readonly ok: false;
      readonly error: "missing" | "unavailable" | "failed";
    };

export function decodeHostSigningResponse(value: unknown): HostSigningResponse {
  if (!isRecord(value) || value.version !== 1 || typeof value.ok !== "boolean") {
    throw new Error("Invalid host signing response.");
  }
  if (!value.ok) {
    if (
      Object.keys(value).length !== 3 ||
      !["missing", "unavailable", "failed"].includes(String(value.error))
    ) {
      throw new Error("Invalid host signing response.");
    }
    return {
      version: 1,
      ok: false,
      error: value.error as "missing" | "unavailable" | "failed",
    };
  }
  if (
    !["ensure", "sign", "rotate"].includes(String(value.operation)) ||
    typeof value.keyId !== "string" ||
    !/^[0-9a-f]{64}$/.test(String(value.fingerprint)) ||
    (value.signature !== undefined && typeof value.signature !== "string") ||
    Object.keys(value).some(
      (key) => !["version", "ok", "operation", "keyId", "fingerprint", "signature"].includes(key),
    )
  ) {
    throw new Error("Invalid host signing response.");
  }
  return value as HostSigningResponse;
}

export interface MakeHostIdentitySigningServiceOptions {
  readonly execute?: KeychainHelperExecutor;
  /** Opaque host-derived identity for the selected local data store. */
  readonly storeScope: string;
  /**
   * Reads only the current public fingerprint from the server-authoritative
   * projection. It proves ownership before the native helper may migrate the
   * former unscoped singleton Keychain item.
   */
  readonly expectedLegacyFingerprint?: () => Promise<string | undefined>;
  readonly timeoutMs?: number;
}

/**
 * Desktop-owned host-identity signing broker. Private key material stays in the
 * native Keychain helper; JS only receives fingerprints and signatures.
 */
export function makeHostIdentitySigningService(
  helperPath: string,
  options: MakeHostIdentitySigningServiceOptions,
): HostIdentitySigningService {
  const execute = options.execute ?? executeHostSigningHelper;
  const limits = {
    maxBytes: HOST_IDENTITY_HELPER_MAX_BYTES,
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  };

  if (
    !isAbsolute(helperPath) ||
    limits.timeoutMs <= 0 ||
    !KEYCHAIN_STORE_SCOPE_PATTERN.test(options.storeScope)
  ) {
    throw new HostIdentitySigningFailure("invalid");
  }

  const invoke = async (request: HostSigningHelperRequest): Promise<HostSigningResponse> => {
    const normalized = normalizeRequest(request);
    const spec = hostSigningHelperSpec(helperPath, normalized, options.storeScope);
    if (Buffer.byteLength(spec.stdin) > HOST_IDENTITY_HELPER_MAX_BYTES) {
      throw new HostIdentitySigningFailure("invalid");
    }

    let result: HostSigningHelperResult;
    try {
      result = await execute(spec, limits);
    } catch {
      throw new HostIdentitySigningFailure("unavailable");
    }
    return decodeHelperResult(result, normalized.operation);
  };

  const resolveExpectedFingerprint = async (
    explicit: string | undefined,
  ): Promise<string | undefined> => {
    if (explicit !== undefined) return explicit;
    if (options.expectedLegacyFingerprint === undefined) return undefined;
    let resolved: string | undefined;
    try {
      resolved = await options.expectedLegacyFingerprint();
    } catch {
      // Do not try a legacy singleton migration when its selected-store proof
      // cannot be read from the authoritative projection.
      throw new HostIdentitySigningFailure("unavailable");
    }
    if (resolved !== undefined && !/^[0-9a-f]{64}$/.test(resolved)) {
      throw new HostIdentitySigningFailure("failed");
    }
    return resolved;
  };

  const ensureIdentityKey = async (explicitFingerprint?: string) => {
    const expectedFingerprint = await resolveExpectedFingerprint(explicitFingerprint);
    const response = await invoke({
      operation: "ensure",
      keyId: HOST_IDENTITY_KEY_ID,
      ...(expectedFingerprint === undefined ? {} : { expectedFingerprint }),
    });
    if (!response.ok) throw new HostIdentitySigningFailure(response.error);
    return { fingerprint: response.fingerprint };
  };

  return {
    ensureIdentityKey,
    sign: async (payload, expectedFingerprint) => {
      if (payload.byteLength === 0) throw new HostIdentitySigningFailure("invalid");
      // `sign` is the normal operational path. Ensure it first so an upgrade
      // with the former unscoped key supplies the persisted ownership proof
      // before the scoped signing lookup can report it missing.
      await ensureIdentityKey(expectedFingerprint);
      const response = await invoke({
        operation: "sign",
        keyId: HOST_IDENTITY_KEY_ID,
        payload: Buffer.from(payload).toString("base64"),
      });
      if (!response.ok) throw new HostIdentitySigningFailure(response.error);
      if (typeof response.signature !== "string" || response.signature.length === 0) {
        throw new HostIdentitySigningFailure("failed");
      }
      return {
        fingerprint: response.fingerprint,
        signature: response.signature,
      };
    },
    rotateIdentityKey: async () => {
      const response = await invoke({
        operation: "rotate",
        keyId: HOST_IDENTITY_KEY_ID,
      });
      if (!response.ok) throw new HostIdentitySigningFailure(response.error);
      return { fingerprint: response.fingerprint };
    },
    probeRecoveryState: async (expectedFingerprint) => {
      try {
        const ensured = await ensureIdentityKey(expectedFingerprint);
        return {
          status: "ready",
          reason: null,
          remoteIdentityUsable: true,
          localDesktopUsable: true,
          fingerprint: ensured.fingerprint,
        };
      } catch (error) {
        const reason =
          error instanceof HostIdentitySigningFailure ? error.category : ("unavailable" as const);
        return {
          status: "recovery-required",
          reason,
          remoteIdentityUsable: false,
          localDesktopUsable: true,
        };
      }
    },
  };
}

function normalizeRequest(request: HostSigningHelperRequest): HostSigningHelperRequest {
  if (request.keyId !== HOST_IDENTITY_KEY_ID) {
    throw new HostIdentitySigningFailure("invalid");
  }
  if (
    request.operation === "ensure" &&
    request.expectedFingerprint !== undefined &&
    !/^[0-9a-f]{64}$/.test(request.expectedFingerprint)
  ) {
    throw new HostIdentitySigningFailure("invalid");
  }
  if (request.operation === "sign" && request.payload.length === 0) {
    throw new HostIdentitySigningFailure("invalid");
  }
  return request;
}

function decodeHelperResult(
  result: HostSigningHelperResult,
  operation: HostSigningHelperRequest["operation"],
): HostSigningResponse {
  if (
    result.stderr.length > 0 ||
    Buffer.byteLength(result.stdout) > HOST_IDENTITY_HELPER_MAX_BYTES ||
    !result.stdout.endsWith("\n") ||
    result.stdout.slice(0, -1).includes("\n")
  ) {
    throw new HostIdentitySigningFailure("failed");
  }

  let decoded: HostSigningResponse;
  try {
    decoded = decodeHostSigningResponse(JSON.parse(result.stdout));
  } catch {
    throw new HostIdentitySigningFailure("failed");
  }

  if (!decoded.ok) {
    if (result.exitCode === 0) throw new HostIdentitySigningFailure("failed");
    return decoded;
  }
  if (result.exitCode !== 0) throw new HostIdentitySigningFailure("failed");
  if (decoded.operation !== operation) throw new HostIdentitySigningFailure("failed");
  if (decoded.keyId !== HOST_IDENTITY_KEY_ID) throw new HostIdentitySigningFailure("failed");
  if (operation === "sign" && typeof decoded.signature !== "string") {
    throw new HostIdentitySigningFailure("failed");
  }
  return decoded;
}

const executeHostSigningHelper: KeychainHelperExecutor = async (spec, limits) =>
  await new Promise((resolve, reject) => {
    const child = spawn(spec.command, spec.args, {
      stdio: ["pipe", "pipe", "pipe"],
    });
    const input = Buffer.from(spec.stdin, "utf8");
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    let terminationRequested = false;

    const requestTermination = () => {
      if (settled || terminationRequested) return;
      terminationRequested = true;
      clearTimeout(timeout);
      child.kill("SIGKILL");
    };
    const timeout = setTimeout(requestTermination, limits.timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.byteLength;
      if (terminationRequested || stdoutBytes > limits.maxBytes) {
        chunk.fill(0);
        return requestTermination();
      }
      stdout.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrBytes += chunk.byteLength;
      if (terminationRequested || stderrBytes > limits.maxBytes) {
        chunk.fill(0);
        return requestTermination();
      }
      stderr.push(chunk);
    });
    child.once("error", requestTermination);
    child.once("close", (exitCode) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      input.fill(0);
      if (terminationRequested) {
        clearBuffers(stdout);
        clearBuffers(stderr);
        reject(new Error("Host-identity helper execution failed."));
        return;
      }
      resolve({
        exitCode,
        stdout: consumeBuffers(stdout),
        stderr: consumeBuffers(stderr),
      });
    });
    child.stdin.once("error", requestTermination);
    child.stdin.end(input, () => input.fill(0));
  });

function consumeBuffers(chunks: Buffer[]): string {
  const combined = Buffer.concat(chunks);
  const value = combined.toString("utf8");
  combined.fill(0);
  clearBuffers(chunks);
  return value;
}

function clearBuffers(chunks: Buffer[]): void {
  for (const chunk of chunks) chunk.fill(0);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
