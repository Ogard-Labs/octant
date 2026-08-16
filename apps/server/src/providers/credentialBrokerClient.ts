import type { CredentialPurgeAttempt } from "@octant/domain";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const PURGE_FAILURE_KINDS = new Set(["locked", "unavailable", "indeterminate", "failed"]);

export interface ProviderCredentialResolver {
  readonly has: (providerInstanceId: string) => Promise<boolean>;
  readonly resolve: (providerInstanceId: string) => Promise<string>;
}

export interface CredentialBrokerClientOptions {
  readonly url: string;
  readonly token: string;
  readonly fetch?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
}

export function makeCredentialBrokerClient(
  options: CredentialBrokerClientOptions,
): ProviderCredentialResolver {
  const fetch = options.fetch ?? globalThis.fetch;
  const request = async (operation: "has" | "resolve", providerInstanceId: string) => {
    if (!UUID_PATTERN.test(providerInstanceId)) throw brokerFailure();
    let response: Response;
    try {
      response = await fetch(new URL(`/v1/credentials/${operation}`, options.url).toString(), {
        method: "POST",
        redirect: "error",
        headers: {
          "content-type": "application/json",
          "x-octant-credential-broker-token": options.token,
        },
        body: JSON.stringify({ providerInstanceId }),
      });
    } catch {
      throw brokerFailure();
    }
    if (!response.ok) throw brokerFailure();
    try {
      return (await response.json()) as unknown;
    } catch {
      throw brokerFailure();
    }
  };

  return Object.freeze({
    has: async (providerInstanceId: string): Promise<boolean> => {
      const value = await request("has", providerInstanceId);
      if (!hasExactKeys(value, ["present"]) || typeof value.present !== "boolean") {
        throw brokerFailure();
      }
      return value.present;
    },
    resolve: async (providerInstanceId: string): Promise<string> => {
      const value = await request("resolve", providerInstanceId);
      if (!hasExactKeys(value, ["credential"]) || typeof value.credential !== "string") {
        throw brokerFailure();
      }
      return value.credential;
    },
  });
}

export interface CredentialCleanupClient {
  /**
   * Requests a Keychain purge through the host credential broker and always
   * resolves to a typed {@link CredentialPurgeAttempt} — it never throws, and
   * never carries a credential value or account identifier. Every network,
   * authentication, decode, or broker-reported failure resolves to the most
   * specific matching outcome. A lost or malformed destructive response is
   * `indeterminate`, so the caller can reconcile instead of restoring local
   * files after an unconfirmed purge.
   */
  readonly purge: (input: {
    readonly dryRun: boolean;
    readonly providerInstanceIds: readonly string[];
    readonly hostIdentityFingerprint?: string;
  }) => Promise<CredentialPurgeAttempt>;
}

export function makeCredentialCleanupClient(
  options: CredentialBrokerClientOptions,
): CredentialCleanupClient {
  const fetch = options.fetch ?? globalThis.fetch;

  const requestPurge = async (input: {
    readonly dryRun: boolean;
    readonly providerInstanceIds: readonly string[];
    readonly hostIdentityFingerprint: string | null;
  }): Promise<CredentialPurgeAttempt> => {
    let response: Response;
    try {
      response = await fetch(new URL("/v1/credentials/purge", options.url).toString(), {
        method: "POST",
        redirect: "error",
        headers: {
          "content-type": "application/json",
          "x-octant-credential-broker-token": options.token,
        },
        body: JSON.stringify(input),
      });
    } catch {
      // A lost response after dispatch cannot prove whether the native helper
      // committed the purge. The caller must reconcile this idempotent
      // operation before it restores or discards the SQLite store.
      return input.dryRun ? { kind: "unavailable" } : { kind: "indeterminate" };
    }

    if (!response.ok) {
      let body: unknown;
      try {
        body = await response.json();
      } catch {
        return { kind: "failed" };
      }
      const errorKind = isRecord(body) && typeof body.error === "string" ? body.error : undefined;
      if (errorKind !== undefined && PURGE_FAILURE_KINDS.has(errorKind)) {
        return {
          kind: errorKind as "locked" | "unavailable" | "indeterminate" | "failed",
        };
      }
      return { kind: "failed" };
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      return input.dryRun ? { kind: "failed" } : { kind: "indeterminate" };
    }

    if (!isRecord(body) || typeof body.dryRun !== "boolean") {
      return input.dryRun ? { kind: "failed" } : { kind: "indeterminate" };
    }
    if (body.dryRun !== input.dryRun) {
      return input.dryRun ? { kind: "failed" } : { kind: "indeterminate" };
    }
    if (body.dryRun) {
      if (
        typeof body.matchedCount !== "number" ||
        !Number.isInteger(body.matchedCount) ||
        body.matchedCount < 0
      ) {
        return { kind: "failed" };
      }
      return { kind: "dry-run", matchedCount: body.matchedCount };
    }
    if (
      typeof body.deletedCount !== "number" ||
      !Number.isInteger(body.deletedCount) ||
      body.deletedCount < 0 ||
      typeof body.failedCount !== "number" ||
      !Number.isInteger(body.failedCount) ||
      body.failedCount < 0
    ) {
      return { kind: "indeterminate" };
    }
    return body.failedCount > 0
      ? {
          kind: "partial",
          deletedCount: body.deletedCount,
          failedCount: body.failedCount,
        }
      : { kind: "completed", deletedCount: body.deletedCount };
  };

  return Object.freeze({
    purge: async (input: {
      readonly dryRun: boolean;
      readonly providerInstanceIds: readonly string[];
      readonly hostIdentityFingerprint?: string;
    }): Promise<CredentialPurgeAttempt> => {
      const providerInstanceIds = normalizeProviderInstanceIds(input.providerInstanceIds);
      const hostIdentityFingerprint = normalizeHostIdentityFingerprint(
        input.hostIdentityFingerprint,
      );
      if (providerInstanceIds === undefined || hostIdentityFingerprint === undefined) {
        return { kind: "failed" };
      }
      const batches = providerInstanceIdBatches(providerInstanceIds);
      let matchedCount = 0;
      let deletedCount = 0;
      let completedDestructiveBatch = false;
      for (const [index, batch] of batches.entries()) {
        // The host identity is one Keychain record, not one per provider
        // batch. Passing its ownership evidence only with the first request
        // prevents a dry-run from counting it repeatedly and preserves the
        // helper's exact selected-store proof requirement.
        const result = await requestPurge({
          dryRun: input.dryRun,
          providerInstanceIds: batch,
          hostIdentityFingerprint: index === 0 ? hostIdentityFingerprint : null,
        });
        if (input.dryRun) {
          if (result.kind !== "dry-run") return result;
          matchedCount += result.matchedCount;
          continue;
        }
        if (result.kind === "completed") {
          deletedCount += result.deletedCount;
          completedDestructiveBatch = true;
          continue;
        }
        if (result.kind === "partial") {
          // A prior batch has already deleted selected credentials, while the
          // current batch did not finish. The aggregate outcome cannot prove
          // that the selected Keychain and staged SQLite store still agree.
          // Return indeterminate so the lifecycle boundary keeps the SQLite
          // artifacts staged and performs its idempotent reconciliation pass.
          if (completedDestructiveBatch) return { kind: "indeterminate" };
          return {
            kind: "partial",
            deletedCount: deletedCount + result.deletedCount,
            failedCount: result.failedCount,
          };
        }
        // Once any destructive batch completed, a later typed failure cannot
        // safely restore the staged SQLite store: it may describe credentials
        // already removed in the completed batch. Reconcile from staging
        // rather than reporting a non-mutating failure.
        if (completedDestructiveBatch) return { kind: "indeterminate" };
        return result;
      }
      return input.dryRun ? { kind: "dry-run", matchedCount } : { kind: "completed", deletedCount };
    },
  });
}

function normalizeHostIdentityFingerprint(value: string | undefined): string | null | undefined {
  if (value === undefined) return null;
  return /^[0-9a-f]{64}$/.test(value) ? value : undefined;
}

function normalizeProviderInstanceIds(values: readonly string[]): readonly string[] | undefined {
  const normalized = values.map((value) => value.toLowerCase());
  if (
    normalized.some((providerInstanceId) => !UUID_PATTERN.test(providerInstanceId)) ||
    new Set(normalized).size !== normalized.length
  ) {
    return undefined;
  }
  return [...normalized].sort();
}

function providerInstanceIdBatches(values: readonly string[]): ReadonlyArray<readonly string[]> {
  if (values.length === 0) return [[]];
  const batches: string[][] = [];
  for (let offset = 0; offset < values.length; offset += 128) {
    batches.push(values.slice(offset, offset + 128));
  }
  return batches;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(
  value: unknown,
  expected: readonly string[],
): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  return keys.length === expected.length && keys.every((key) => expected.includes(key));
}

function brokerFailure(): Error {
  return new Error("Octant credential resolution failed.");
}
