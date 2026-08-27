const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MAX_SECRET_BYTES = 12 * 1_024;

export type IntegrationSecretPutResult =
  | { readonly kind: "stored" }
  | { readonly kind: "unavailable"; readonly reason: string };

/**
 * Host-owned secret store for Integration plugins. Values never leave this
 * boundary except as Authorization material attached by the host fetch
 * interceptor. Plugins receive only opaque references.
 */
export interface IntegrationSecretVault {
  readonly has: (id: string) => Promise<boolean>;
  readonly resolve: (id: string) => Promise<string | undefined>;
  readonly put: (id: string, secret: string) => Promise<IntegrationSecretPutResult>;
  readonly delete: (id: string) => Promise<void>;
}

export interface IntegrationSecretBroker {
  readonly has: (id: string) => Promise<boolean>;
  readonly resolve: (id: string) => Promise<string>;
  readonly set: (id: string, secret: string) => Promise<void>;
  readonly delete: (id: string) => Promise<void>;
}

/** Vault that refuses every write so a host without a credential broker fails closed. */
export function createUnavailableSecretVault(): IntegrationSecretVault {
  return {
    has: async () => false,
    resolve: async () => undefined,
    put: async () => ({
      kind: "unavailable",
      reason: "The secure credential store is unavailable.",
    }),
    delete: async () => {},
  };
}

/** In-memory vault used by tests. */
export function createMemorySecretVault(
  initial: ReadonlyMap<string, string> = new Map(),
): IntegrationSecretVault {
  const secrets = new Map(initial);
  return {
    has: async (id) => secrets.has(id),
    resolve: async (id) => secrets.get(id),
    put: async (id, secret) => {
      if (!UUID_PATTERN.test(id) || !isSecretSizeOk(secret)) {
        return {
          kind: "unavailable",
          reason: "The credential could not be stored.",
        };
      }
      secrets.set(id, secret);
      return { kind: "stored" };
    },
    delete: async (id) => {
      secrets.delete(id);
    },
  };
}

/**
 * Vault that writes through the desktop credential broker. Failures are
 * returned as unavailable; the raw broker error is never forwarded.
 */
export function createBrokerSecretVault(broker: IntegrationSecretBroker): IntegrationSecretVault {
  return {
    has: async (id) => {
      if (!UUID_PATTERN.test(id)) return false;
      try {
        return await broker.has(id);
      } catch {
        return false;
      }
    },
    resolve: async (id) => {
      if (!UUID_PATTERN.test(id)) return undefined;
      try {
        return await broker.resolve(id);
      } catch {
        return undefined;
      }
    },
    put: async (id, secret) => {
      if (!UUID_PATTERN.test(id) || !isSecretSizeOk(secret)) {
        return { kind: "unavailable", reason: "The credential could not be stored." };
      }
      try {
        await broker.set(id, secret);
        return { kind: "stored" };
      } catch {
        return {
          kind: "unavailable",
          reason: "The secure credential store is unavailable.",
        };
      }
    },
    delete: async (id) => {
      if (!UUID_PATTERN.test(id)) return;
      try {
        await broker.delete(id);
      } catch {
        // Logout still clears plugin-visible state even when the broker
        // delete fails; the caller treats this as a local clear.
      }
    },
  };
}

function isSecretSizeOk(secret: string): boolean {
  return secret.length > 0 && Buffer.byteLength(secret, "utf8") <= MAX_SECRET_BYTES;
}
