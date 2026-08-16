import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";

const POLICY_SCHEMA_VERSION = 1;

export interface HostServicePolicy {
  readonly schemaVersion: 1;
  readonly enabled: boolean;
  readonly updatedAt: string;
}

export class ServicePolicyError extends Error {
  readonly code: "invalid-path" | "unsafe-file" | "invalid-policy" | "write-failed";

  constructor(code: ServicePolicyError["code"], message: string) {
    super(message);
    this.name = "ServicePolicyError";
    this.code = code;
  }
}

export interface ServicePolicyStoreOptions {
  readonly path: string;
  readonly now?: () => string;
  readonly uid?: number;
}

export class ServicePolicyStore {
  readonly #path: string;
  readonly #now: () => string;
  readonly #uid: number;

  constructor(options: ServicePolicyStoreOptions) {
    if (!isAbsolute(options.path) || options.path.trim() !== options.path) {
      throw new ServicePolicyError("invalid-path", "Service policy path must be absolute.");
    }
    this.#path = options.path;
    this.#now = options.now ?? (() => new Date().toISOString());
    this.#uid = options.uid ?? process.getuid?.() ?? 0;
  }

  get path(): string {
    return this.#path;
  }

  async read(): Promise<HostServicePolicy> {
    try {
      const metadata = await lstat(this.#path);
      if (!metadata.isFile() || metadata.uid !== this.#uid || (metadata.mode & 0o077) !== 0) {
        throw new ServicePolicyError("unsafe-file", "Service policy is not an owner-only file.");
      }
      return decodePolicy(await readFile(this.#path, "utf8"));
    } catch (error) {
      if (isMissing(error)) {
        return this.#defaultPolicy();
      }
      if (error instanceof ServicePolicyError) throw error;
      throw new ServicePolicyError("invalid-policy", "Service policy could not be read.");
    }
  }

  async setEnabled(enabled: boolean): Promise<HostServicePolicy> {
    const policy: HostServicePolicy = {
      schemaVersion: POLICY_SCHEMA_VERSION,
      enabled,
      updatedAt: this.#now(),
    };
    const directory = dirname(this.#path);
    try {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await assertOwnerOnlyDirectory(directory, this.#uid);
      await assertExistingPolicySafe(this.#path, this.#uid);
      const temporary = join(directory, `.service-policy-${randomUUID()}.tmp`);
      await writeFile(temporary, JSON.stringify(policy), { encoding: "utf8", mode: 0o600 });
      await chmod(temporary, 0o600);
      await rename(temporary, this.#path);
      return policy;
    } catch (error) {
      if (error instanceof ServicePolicyError) throw error;
      throw new ServicePolicyError("write-failed", "Service policy could not be written.");
    }
  }

  #defaultPolicy(): HostServicePolicy {
    return {
      schemaVersion: POLICY_SCHEMA_VERSION,
      enabled: true,
      updatedAt: this.#now(),
    };
  }
}

function decodePolicy(input: string): HostServicePolicy {
  if (Buffer.byteLength(input) > 1_024) {
    throw new ServicePolicyError("invalid-policy", "Service policy exceeds the size limit.");
  }
  let value: unknown;
  try {
    value = JSON.parse(input);
  } catch {
    throw new ServicePolicyError("invalid-policy", "Service policy is not valid JSON.");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ServicePolicyError("invalid-policy", "Service policy is malformed.");
  }
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).sort().join("\0") !== "enabled\0schemaVersion\0updatedAt" ||
    record.schemaVersion !== POLICY_SCHEMA_VERSION ||
    typeof record.enabled !== "boolean" ||
    typeof record.updatedAt !== "string" ||
    record.updatedAt.length === 0 ||
    record.updatedAt.length > 64 ||
    Number.isNaN(Date.parse(record.updatedAt))
  ) {
    throw new ServicePolicyError("invalid-policy", "Service policy is malformed.");
  }
  return Object.freeze({
    schemaVersion: 1,
    enabled: record.enabled,
    updatedAt: record.updatedAt,
  });
}

async function assertExistingPolicySafe(path: string, uid: number): Promise<void> {
  try {
    const metadata = await lstat(path);
    if (!metadata.isFile() || metadata.uid !== uid || (metadata.mode & 0o077) !== 0) {
      throw new ServicePolicyError("unsafe-file", "Service policy is not an owner-only file.");
    }
  } catch (error) {
    if (isMissing(error)) return;
    throw error;
  }
}

async function assertOwnerOnlyDirectory(path: string, uid: number): Promise<void> {
  const metadata = await lstat(path);
  if (!metadata.isDirectory() || metadata.uid !== uid || (metadata.mode & 0o077) !== 0) {
    throw new ServicePolicyError("unsafe-file", "Service policy directory is not owner-only.");
  }
}

function isMissing(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { readonly code?: unknown }).code === "ENOENT"
  );
}
