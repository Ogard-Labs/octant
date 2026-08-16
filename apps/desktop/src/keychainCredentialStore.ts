import { spawn } from "node:child_process";
import { isAbsolute } from "node:path";
import { CredentialStoreFailure, type CredentialStore } from "./credentialStore";

export const KEYCHAIN_HELPER_MAX_BYTES = 16 * 1_024;
const DEFAULT_TIMEOUT_MS = 2_000;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const KEYCHAIN_STORE_SCOPE_PATTERN = UUID_PATTERN;

type KeychainHelperRequest =
  | {
      readonly operation: "set";
      readonly providerInstanceId: string;
      readonly credential: string;
    }
  | {
      readonly operation: "delete" | "has" | "resolve";
      readonly providerInstanceId: string;
    };

export interface KeychainHelperSpec {
  readonly command: string;
  readonly args: readonly string[];
  readonly stdin: string;
}

export interface KeychainHelperResult {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

export interface KeychainHelperLimits {
  readonly maxBytes: number;
  readonly timeoutMs: number;
}

export type KeychainHelperExecutor = (
  spec: KeychainHelperSpec,
  limits: KeychainHelperLimits,
) => Promise<KeychainHelperResult>;

export function keychainHelperSpec(
  helperPath: string,
  request: KeychainHelperRequest,
  storeScope: string,
): KeychainHelperSpec {
  return {
    command: helperPath,
    args: [],
    stdin: `${JSON.stringify({ version: 1, storeScope, ...request })}\n`,
  };
}

interface MakeKeychainCredentialStoreOptions {
  readonly execute?: KeychainHelperExecutor;
  /** Opaque host-derived identity for the selected local data store. */
  readonly storeScope: string;
  readonly timeoutMs?: number;
}

export function makeKeychainCredentialStore(
  helperPath: string,
  options: MakeKeychainCredentialStoreOptions,
): CredentialStore {
  const execute = options.execute ?? executeKeychainHelper;
  const limits = {
    maxBytes: KEYCHAIN_HELPER_MAX_BYTES,
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  };

  if (
    !isAbsolute(helperPath) ||
    limits.timeoutMs <= 0 ||
    !KEYCHAIN_STORE_SCOPE_PATTERN.test(options.storeScope)
  ) {
    throw new CredentialStoreFailure("invalid");
  }

  const invoke = async (request: KeychainHelperRequest): Promise<Record<string, unknown>> => {
    const providerInstanceId = normalizeProviderInstanceId(request.providerInstanceId);
    if (request.operation === "set" && request.credential.length === 0) {
      throw new CredentialStoreFailure("invalid");
    }

    const normalizedRequest = { ...request, providerInstanceId };
    const spec = keychainHelperSpec(helperPath, normalizedRequest, options.storeScope);
    if (Buffer.byteLength(spec.stdin) > KEYCHAIN_HELPER_MAX_BYTES) {
      throw new CredentialStoreFailure("invalid");
    }

    let result: KeychainHelperResult;
    try {
      result = await execute(spec, limits);
    } catch {
      throw new CredentialStoreFailure("unavailable");
    }
    return decodeHelperResponse(result, normalizedRequest.operation);
  };

  return {
    set: async (providerInstanceId, credential) => {
      await invoke({ operation: "set", providerInstanceId, credential });
    },
    has: async (providerInstanceId) => {
      const response = await invoke({ operation: "has", providerInstanceId });
      if (typeof response.present !== "boolean") throw new CredentialStoreFailure("failed");
      return response.present;
    },
    resolve: async (providerInstanceId) => {
      const response = await invoke({ operation: "resolve", providerInstanceId });
      if (typeof response.credential !== "string") throw new CredentialStoreFailure("failed");
      return response.credential;
    },
    delete: async (providerInstanceId) => {
      await invoke({ operation: "delete", providerInstanceId });
    },
  };
}

export type CredentialPurgeFailureCategory = "locked" | "unavailable" | "indeterminate" | "failed";

const PURGE_FAILURE_MESSAGES: Readonly<Record<CredentialPurgeFailureCategory, string>> = {
  locked: "The macOS Keychain is locked or requires interaction.",
  unavailable: "The macOS Keychain is unavailable.",
  indeterminate: "The Keychain credential purge outcome could not be confirmed.",
  failed: "The Keychain credential purge failed.",
};

export class CredentialPurgeFailure extends Error {
  constructor(readonly category: CredentialPurgeFailureCategory) {
    super(PURGE_FAILURE_MESSAGES[category]);
    this.name = "CredentialPurgeFailure";
  }
}

export type CredentialPurgeResult =
  | { readonly dryRun: true; readonly matchedCount: number }
  | { readonly dryRun: false; readonly deletedCount: number; readonly failedCount: number };

export interface CredentialPurgeInput {
  readonly dryRun: boolean;
  /**
   * Exact provider identities referenced by the selected SQLite store. This
   * authorizes migration/removal of a pre-scope Keychain item without letting
   * one store claim every legacy credential belonging to another data dir.
   */
  readonly providerInstanceIds: readonly string[];
  /**
   * Public fingerprint projected by the selected SQLite store. It attributes
   * the one pre-scope host-identity record before a destructive purge may
   * migrate or delete it; absent evidence leaves that legacy key untouched and
   * blocks the purge rather than claiming another store's identity.
   */
  readonly hostIdentityFingerprint?: string;
}

export interface CredentialPurgeStore {
  /**
   * Enumerates and, when `dryRun` is false, deletes this store's scoped
   * Keychain items plus legacy provider credentials named by the authoritative
   * `providerInstanceIds` list. A pre-scope host identity is considered only
   * when its selected-store fingerprint proves ownership. It never claims
   * unscoped credentials from another data directory. A nonzero `failedCount`
   * means some owned items were not removed and the caller MUST treat that as
   * not fully performed.
   */
  readonly purge: (input: CredentialPurgeInput) => Promise<CredentialPurgeResult>;
}

export function keychainPurgeHelperSpec(
  helperPath: string,
  input: CredentialPurgeInput,
  storeScope: string,
): KeychainHelperSpec {
  return {
    command: helperPath,
    args: [],
    stdin: `${JSON.stringify({
      version: 1,
      operation: "purge",
      dryRun: input.dryRun,
      storeScope,
      providerInstanceIds: input.providerInstanceIds,
      hostIdentityFingerprint: input.hostIdentityFingerprint ?? null,
    })}\n`,
  };
}

export function makeKeychainCredentialPurgeStore(
  helperPath: string,
  options: MakeKeychainCredentialStoreOptions,
): CredentialPurgeStore {
  const execute = options.execute ?? executeKeychainHelper;
  const limits = {
    maxBytes: KEYCHAIN_HELPER_MAX_BYTES,
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  };

  if (
    !isAbsolute(helperPath) ||
    limits.timeoutMs <= 0 ||
    !KEYCHAIN_STORE_SCOPE_PATTERN.test(options.storeScope)
  ) {
    throw new CredentialPurgeFailure("failed");
  }

  return {
    purge: async (input) => {
      const providerInstanceIds = normalizePurgeProviderInstanceIds(input.providerInstanceIds);
      if (
        input.hostIdentityFingerprint !== undefined &&
        !/^[0-9a-f]{64}$/.test(input.hostIdentityFingerprint)
      ) {
        throw new CredentialPurgeFailure("failed");
      }
      const spec = keychainPurgeHelperSpec(
        helperPath,
        {
          dryRun: input.dryRun,
          providerInstanceIds,
          ...(input.hostIdentityFingerprint === undefined
            ? {}
            : { hostIdentityFingerprint: input.hostIdentityFingerprint }),
        },
        options.storeScope,
      );
      if (Buffer.byteLength(spec.stdin) > KEYCHAIN_HELPER_MAX_BYTES) {
        throw new CredentialPurgeFailure("failed");
      }
      let result: KeychainHelperResult;
      try {
        result = await execute(spec, limits);
      } catch {
        // A dry-run cannot mutate credentials, but a timeout or executor loss
        // after dispatching a destructive helper can interrupt its sequential
        // deletion loop. The caller must retain staged store files until the
        // idempotent purge can be reconciled.
        throw new CredentialPurgeFailure(input.dryRun ? "unavailable" : "indeterminate");
      }
      try {
        return decodePurgeResponse(result, input.dryRun);
      } catch (error) {
        // A malformed or truncated destructive response is likewise unable to
        // prove that no Keychain item was deleted. Preserve a valid helper's
        // typed failures, but fail closed to staged recovery for all other
        // destructive protocol failures.
        if (
          !input.dryRun &&
          error instanceof CredentialPurgeFailure &&
          error.category === "failed" &&
          !isDeclaredPurgeFailure(result)
        ) {
          throw new CredentialPurgeFailure("indeterminate");
        }
        throw error;
      }
    },
  };
}

function normalizePurgeProviderInstanceIds(values: readonly string[]): readonly string[] {
  if (values.length > 128) throw new CredentialPurgeFailure("failed");
  const normalized = values.map(normalizeProviderInstanceId);
  if (new Set(normalized).size !== normalized.length) throw new CredentialPurgeFailure("failed");
  return [...normalized].sort();
}

function decodePurgeResponse(result: KeychainHelperResult, dryRun: boolean): CredentialPurgeResult {
  if (
    result.stderr.length > 0 ||
    Buffer.byteLength(result.stdout) > KEYCHAIN_HELPER_MAX_BYTES ||
    !result.stdout.endsWith("\n") ||
    result.stdout.slice(0, -1).includes("\n")
  ) {
    throw new CredentialPurgeFailure("failed");
  }

  let response: unknown;
  try {
    response = JSON.parse(result.stdout);
  } catch {
    throw new CredentialPurgeFailure("failed");
  }
  if (!isRecord(response) || response.version !== 1 || typeof response.ok !== "boolean") {
    throw new CredentialPurgeFailure("failed");
  }
  if (!response.ok) {
    if (Object.keys(response).length !== 3 || !Object.hasOwn(response, "error")) {
      throw new CredentialPurgeFailure("failed");
    }
    if (
      response.error === "locked" ||
      response.error === "unavailable" ||
      response.error === "failed"
    ) {
      throw new CredentialPurgeFailure(response.error);
    }
    throw new CredentialPurgeFailure("failed");
  }
  if (result.exitCode !== 0) throw new CredentialPurgeFailure("failed");
  if (response.operation !== "purge" || response.dryRun !== dryRun) {
    throw new CredentialPurgeFailure("failed");
  }

  if (dryRun) {
    const allowedKeys = new Set(["version", "ok", "operation", "dryRun", "matchedCount"]);
    if (
      Object.keys(response).some((key) => !allowedKeys.has(key)) ||
      typeof response.matchedCount !== "number" ||
      !Number.isInteger(response.matchedCount) ||
      response.matchedCount < 0
    ) {
      throw new CredentialPurgeFailure("failed");
    }
    return { dryRun: true, matchedCount: response.matchedCount };
  }

  const allowedKeys = new Set([
    "version",
    "ok",
    "operation",
    "dryRun",
    "deletedCount",
    "failedCount",
  ]);
  if (
    Object.keys(response).some((key) => !allowedKeys.has(key)) ||
    typeof response.deletedCount !== "number" ||
    !Number.isInteger(response.deletedCount) ||
    response.deletedCount < 0 ||
    typeof response.failedCount !== "number" ||
    !Number.isInteger(response.failedCount) ||
    response.failedCount < 0
  ) {
    throw new CredentialPurgeFailure("failed");
  }
  return { dryRun: false, deletedCount: response.deletedCount, failedCount: response.failedCount };
}

function isDeclaredPurgeFailure(result: KeychainHelperResult): boolean {
  try {
    const response: unknown = JSON.parse(result.stdout);
    return (
      isRecord(response) &&
      response.version === 1 &&
      response.ok === false &&
      Object.keys(response).length === 3 &&
      (response.error === "locked" ||
        response.error === "unavailable" ||
        response.error === "failed")
    );
  } catch {
    return false;
  }
}

function normalizeProviderInstanceId(providerInstanceId: string): string {
  const normalized = providerInstanceId.toLowerCase();
  if (!UUID_PATTERN.test(normalized)) throw new CredentialStoreFailure("invalid");
  return normalized;
}

function decodeHelperResponse(
  result: KeychainHelperResult,
  operation: KeychainHelperRequest["operation"],
): Record<string, unknown> {
  if (
    result.stderr.length > 0 ||
    Buffer.byteLength(result.stdout) > KEYCHAIN_HELPER_MAX_BYTES ||
    !result.stdout.endsWith("\n") ||
    result.stdout.slice(0, -1).includes("\n")
  ) {
    throw new CredentialStoreFailure("failed");
  }

  let response: unknown;
  try {
    response = JSON.parse(result.stdout);
  } catch {
    throw new CredentialStoreFailure("failed");
  }
  if (!isRecord(response) || response.version !== 1 || typeof response.ok !== "boolean") {
    throw new CredentialStoreFailure("failed");
  }
  if (!response.ok) {
    if (Object.keys(response).length !== 3 || !Object.hasOwn(response, "error")) {
      throw new CredentialStoreFailure("failed");
    }
    if (
      response.error === "missing" ||
      response.error === "unavailable" ||
      response.error === "failed"
    ) {
      throw new CredentialStoreFailure(response.error);
    }
    throw new CredentialStoreFailure("failed");
  }
  if (result.exitCode !== 0) throw new CredentialStoreFailure("failed");

  const allowedKeys =
    operation === "has"
      ? new Set(["version", "ok", "present"])
      : operation === "resolve"
        ? new Set(["version", "ok", "credential"])
        : new Set(["version", "ok"]);
  if (Object.keys(response).some((key) => !allowedKeys.has(key))) {
    throw new CredentialStoreFailure("failed");
  }
  return response;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const executeKeychainHelper: KeychainHelperExecutor = async (spec, limits) =>
  await new Promise((resolve, reject) => {
    const child = spawn(spec.command, spec.args, { stdio: ["pipe", "pipe", "pipe"] });
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
        reject(new Error("Keychain helper execution failed."));
        return;
      }
      resolve({ exitCode, stdout: consumeBuffers(stdout), stderr: consumeBuffers(stderr) });
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
