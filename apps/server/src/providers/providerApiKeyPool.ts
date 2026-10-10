import {
  apiKeysInUseOrder,
  keyCooldownMs,
  parseRetryAfterSeconds,
  selectApiKey,
} from "@octant/host-runtime";
import type {
  ProviderCredentialLease,
  ProviderCredentialResolver,
  ProviderCredentialStore,
} from "./credentialBrokerClient";

export type ProviderApiKeyStore = ProviderCredentialStore & {
  readonly lease: (providerInstanceId: string) => Promise<ProviderCredentialLease>;
};

/**
 * Lets a provider instance hold several API keys in the host credential store.
 *
 * Each attempt takes a lease on the active key, or the next key in list order
 * when the active one is cooling down. A
 * refusal for a quota or a limit cools that key, so the next attempt picks
 * the next key without waiting. Cooldowns live in memory: a restart tries the
 * first key again, which costs one refused request at most.
 */
export function makeProviderApiKeyPool(
  store: ProviderCredentialStore,
  now: () => number = Date.now,
): ProviderApiKeyStore {
  const cooldowns = new Map<string, Map<string, number>>();

  const lease = async (providerInstanceId: string): Promise<ProviderCredentialLease> => {
    const entries = apiKeysInUseOrder(await store.resolve(providerInstanceId));
    const entry = selectApiKey(
      entries,
      cooldowns.get(providerInstanceId) ?? new Map<string, number>(),
      now(),
    );
    if (entry === undefined) return { credential: "", reportRejected: () => undefined };
    return {
      credential: entry.secret,
      reportRejected: (rejection) => {
        const cooldownMs = keyCooldownMs(rejection);
        if (cooldownMs === undefined) return;
        const perInstance = cooldowns.get(providerInstanceId) ?? new Map<string, number>();
        perInstance.set(entry.id, now() + cooldownMs);
        cooldowns.set(providerInstanceId, perInstance);
      },
    };
  };

  return Object.freeze({
    has: store.has,
    set: async (providerInstanceId: string, credential: string) => {
      cooldowns.delete(providerInstanceId);
      await store.set(providerInstanceId, credential);
    },
    delete: async (providerInstanceId: string) => {
      cooldowns.delete(providerInstanceId);
      await store.delete(providerInstanceId);
    },
    resolve: async (providerInstanceId: string) => (await lease(providerInstanceId)).credential,
    lease,
  });
}

/**
 * The key one attempt sends. A store without a pool answers with its plain
 * credential and no lease, so a single-key instance behaves as it always did.
 */
export async function acquireProviderCredential(
  resolver: ProviderCredentialResolver | undefined,
  providerInstanceId: string,
): Promise<{ readonly credential: string; readonly lease?: ProviderCredentialLease | undefined }> {
  const acquire = resolver?.lease;
  if (acquire !== undefined) {
    const lease = await acquire(providerInstanceId);
    return { credential: lease.credential, lease };
  }
  return { credential: (await resolver?.resolve(providerInstanceId)) ?? "" };
}

/**
 * Records a refused response against the key that was sent, so the next
 * attempt can use another. Reading the body is best effort: a body that cannot
 * be read still counts as a refusal by its status.
 */
export async function reportKeyRejection(
  lease: ProviderCredentialLease | undefined,
  response: Response,
): Promise<void> {
  if (lease === undefined || response.ok) return;
  let body = "";
  try {
    body = (await response.clone().text()).slice(0, 4096);
  } catch {
    body = "";
  }
  lease.reportRejected({
    status: response.status,
    body,
    retryAfterSeconds: parseRetryAfterSeconds(response.headers.get("retry-after")),
  });
}
