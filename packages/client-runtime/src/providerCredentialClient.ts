import type { ProviderCredentialStatus } from "@octant/contracts";
import type { ProviderApiKeySummary } from "@octant/contracts/desktop-bridge";

/**
 * A provider's key on its way to the host's credential store from a device
 * the host's own person paired (maintainer decision, 2026-11-12). The key
 * travels only in a request body over the authenticated session: never in an
 * address, never kept here after the call, and never part of an error. The
 * host answers a state, labels, or a refusal, and never a key. It refuses
 * every other session, which reads as unavailable or as the refusal thrown.
 */
export interface ProviderCredentialClient {
  readonly providerCredentialStatus: (
    providerInstanceId: string,
  ) => Promise<ProviderCredentialStatus>;
  readonly setProviderCredential: (providerInstanceId: string, credential: string) => Promise<void>;
  readonly clearProviderCredential: (providerInstanceId: string) => Promise<void>;
  readonly listProviderApiKeys: (
    providerInstanceId: string,
  ) => Promise<ReadonlyArray<ProviderApiKeySummary>>;
  readonly addProviderApiKey: (
    providerInstanceId: string,
    credential: string,
    label?: string,
  ) => Promise<ProviderApiKeySummary>;
  readonly renameProviderApiKey: (
    providerInstanceId: string,
    keyId: string,
    label: string,
  ) => Promise<void>;
  readonly replaceProviderApiKey: (
    providerInstanceId: string,
    keyId: string,
    credential: string,
  ) => Promise<void>;
  readonly removeProviderApiKey: (providerInstanceId: string, keyId: string) => Promise<void>;
  readonly setActiveProviderApiKey: (providerInstanceId: string, keyId: string) => Promise<void>;
  readonly moveProviderApiKey: (
    providerInstanceId: string,
    keyId: string,
    direction: "up" | "down",
  ) => Promise<void>;
}

const LINKED_SECRET =
  "This provider's key comes from a linked secret store. Remove the link in Settings first.";
const POOL_FAILED = "Octant could not update the provider API keys.";

function field(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null && key in value
    ? (value as Readonly<Record<string, unknown>>)[key]
    : undefined;
}

function isApiKeySummary(value: unknown): value is ProviderApiKeySummary {
  return (
    typeof field(value, "id") === "string" &&
    typeof field(value, "label") === "string" &&
    typeof field(value, "active") === "boolean"
  );
}

export function createProviderCredentialClient(port: {
  readonly baseUrl: string;
  readonly fetch: typeof globalThis.fetch;
}): ProviderCredentialClient {
  const post = async (
    path: string,
    body: Readonly<Record<string, unknown>>,
  ): Promise<{ readonly ok: boolean; readonly value: unknown }> => {
    const response = await port.fetch(new URL(path, port.baseUrl).toString(), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    let value: unknown;
    try {
      value = await response.json();
    } catch {
      value = undefined;
    }
    return { ok: response.ok, value };
  };
  // Every failure is one of these fixed sentences or the host's own message,
  // so nothing a request carried can come back in an error.
  const change = async (
    path: string,
    body: Readonly<Record<string, unknown>>,
    failure: string,
  ): Promise<unknown> => {
    const answer = await post(path, body).catch(() => {
      throw new Error(failure);
    });
    if (answer.ok) return answer.value;
    const category = field(answer.value, "category");
    const message = field(answer.value, "message");
    if (category === "linked-secret") throw new Error(LINKED_SECRET);
    if (category === "api-key-pool" && typeof message === "string") throw new Error(message);
    throw new Error(failure);
  };
  const pool = (name: string, body: Readonly<Record<string, unknown>>) =>
    change(`/api/providers/credentials/keys/${name}`, body, POOL_FAILED);

  return {
    async providerCredentialStatus(instance) {
      const answer = await post("/api/providers/credentials/status", { instance }).catch(
        () => undefined,
      );
      const outcome = field(answer?.value, "outcome");
      if (answer?.ok === true && (outcome === "stored" || outcome === "missing")) return outcome;
      // A provider that sends no key has none to store.
      return field(answer?.value, "category") === "no-stored-key-authentication"
        ? "missing"
        : "unavailable";
    },
    async setProviderCredential(instance, credential) {
      await change(
        "/api/providers/credentials/set",
        { instance, credential, replace: true },
        "Octant could not store the provider credential.",
      );
    },
    async clearProviderCredential(instance) {
      await change(
        "/api/providers/credentials/remove",
        { instance },
        "Octant could not clear the provider credential.",
      );
    },
    async listProviderApiKeys(instance) {
      const keys = field(await pool("list", { instance }), "keys");
      if (!Array.isArray(keys) || !keys.every(isApiKeySummary)) throw new Error(POOL_FAILED);
      return keys.map(({ id, label, active }) => ({ id, label, active }));
    },
    async addProviderApiKey(instance, credential, label) {
      const key = field(
        await pool("add", { instance, credential, ...(label === undefined ? {} : { label }) }),
        "key",
      );
      if (!isApiKeySummary(key)) throw new Error(POOL_FAILED);
      return { id: key.id, label: key.label, active: key.active };
    },
    async renameProviderApiKey(instance, keyId, label) {
      await pool("rename", { instance, keyId, label });
    },
    async replaceProviderApiKey(instance, keyId, credential) {
      await pool("replace", { instance, keyId, credential });
    },
    async removeProviderApiKey(instance, keyId) {
      await pool("remove", { instance, keyId });
    },
    async setActiveProviderApiKey(instance, keyId) {
      await pool("set-active", { instance, keyId });
    },
    async moveProviderApiKey(instance, keyId, direction) {
      await pool("move", { instance, keyId, direction });
    },
  };
}
