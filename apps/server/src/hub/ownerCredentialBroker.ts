// This host's credential broker, as a sign-in copy sees it: provider rows that
// send an API key or bearer token, and the key each stores. A row that signs in
// some other way (a provider's own app holds a subscription login) is never
// read or written here, because those logins stay per machine.

import type { ProviderInstance } from "@octant/contracts";
import { readApiKeyPool } from "@octant/host-runtime";
import type { ProviderCredentialStore } from "../providers/credentialBrokerClient";
import { usesStoredKey } from "../providers/providerCredentialRoutes";
import type {
  CredentialCopyBroker,
  CredentialReadResult,
  CredentialStoreResult,
} from "./ownerCredentialCopy";

export function createProviderCredentialCopyBroker(options: {
  readonly readProviderInstances: () => ReadonlyArray<ProviderInstance>;
  readonly credentials: Pick<ProviderCredentialStore, "has" | "set" | "delete"> & {
    readonly readStored: (providerInstanceId: string) => Promise<string>;
  };
}): CredentialCopyBroker {
  const find = (name: string): ProviderInstance | undefined =>
    options.readProviderInstances().find((instance) => String(instance.id) === name);

  return {
    async read(name): Promise<CredentialReadResult> {
      const instance = find(name);
      if (instance === undefined) return { status: "refused", kind: "no-such-credential" };
      if (!usesStoredKey(instance)) return { status: "refused", kind: "subscription-sign-in" };
      try {
        if (!(await options.credentials.has(name))) {
          return { status: "refused", kind: "no-such-credential" };
        }
        // A pool of several keys is not one sign-in; the person copies keys one at a time.
        const pool = readApiKeyPool(await options.credentials.readStored(name));
        const [only] = pool;
        if (only === undefined) return { status: "refused", kind: "no-such-credential" };
        return pool.length > 1
          ? { status: "refused", kind: "several-keys" }
          : { status: "found", value: only.secret };
      } catch {
        return { status: "refused", kind: "unavailable" };
      }
    },
    async store(name, value): Promise<CredentialStoreResult> {
      const instance = find(name);
      if (instance === undefined) return { status: "refused", kind: "no-such-provider" };
      if (!usesStoredKey(instance)) return { status: "refused", kind: "subscription-sign-in" };
      try {
        // A copy never replaces a key the person typed here.
        if (await options.credentials.has(name)) {
          return { status: "refused", kind: "already-stored" };
        }
        await options.credentials.set(name, value);
        // Settings can remove or reconfigure the row while the key is written;
        // a key must not outlive the endpoint it was entered for.
        const current = find(name);
        if (current === undefined || current.version !== instance.version) {
          await options.credentials.delete(name);
          return { status: "refused", kind: "no-such-provider" };
        }
        return { status: "stored" };
      } catch {
        return { status: "refused", kind: "unavailable" };
      }
    },
  };
}
