import { LOCAL_HOST_ID, decodeHostId, type HostId } from "@octant/contracts/host";
import { localHostDisplayName } from "./localHostDisplayName";

/**
 * Client-local multi-host registry for Post-preview B.
 *
 * Stores host registration facts and **credential handles** only. Private keys
 * remain in `RemoteDeviceKeyStore` / platform secure storage
 * (`remotePairingClient`). Handles must never be joined across hosts.
 */

export type ClientHostKind = "local" | "remote";

/**
 * Opaque handle to a paired device credential for one host.
 * Fields mirror approved pairing metadata in `RemoteDeviceKeyMetadata`
 * without holding CryptoKey material.
 */
export interface ClientHostCredentialHandle {
  readonly keyId: string;
  readonly credentialGeneration: number;
  readonly hostKeyFingerprint: string;
  readonly deviceId?: string;
}

export interface ClientHostRegistration {
  readonly hostId: HostId;
  readonly kind: ClientHostKind;
  readonly displayName: string;
  /** Required for remote hosts; loopback/local may omit. */
  readonly origin?: string;
  readonly enabled: boolean;
  /**
   * Present for paired remote hosts. Local uses launch-session /
   * bridge authority instead of a remote device key and therefore has no handle.
   */
  readonly credential?: ClientHostCredentialHandle;
  readonly lastKnownCapabilities?: ReadonlyArray<string>;
  readonly cacheMetadata?: {
    readonly lastReadyAt?: string;
    readonly lastReplayCursor?: string;
  };
}

export interface ClientHostRegistryStorage {
  readonly getItem: (key: string) => Promise<string | null>;
  readonly setItem: (key: string, value: string) => Promise<void>;
  readonly deleteItem: (key: string) => Promise<void>;
}

const REGISTRY_KEY = "octant.client.host-registry.v1";

export interface ClientHostRegistry {
  readonly list: () => Promise<ReadonlyArray<ClientHostRegistration>>;
  readonly get: (hostId: HostId | string) => Promise<ClientHostRegistration | undefined>;
  readonly upsertRemote: (registration: ClientHostRegistration) => Promise<void>;
  /**
   * Removes a remote host registration. Never removes the local host.
   * Returns the removed registration so callers can forget that host's
   * device key independently.
   */
  readonly removeRemote: (hostId: HostId | string) => Promise<ClientHostRegistration | undefined>;
  /** Update display name / enabled / cache metadata for local or remote. */
  readonly update: (
    hostId: HostId | string,
    patch: Partial<
      Pick<
        ClientHostRegistration,
        "displayName" | "enabled" | "lastKnownCapabilities" | "cacheMetadata" | "credential"
      >
    >,
  ) => Promise<ClientHostRegistration>;
}

function localHostRegistration(): ClientHostRegistration {
  return {
    hostId: LOCAL_HOST_ID,
    kind: "local",
    displayName: localHostDisplayName(),
    enabled: true,
  };
}

function assertRemoteRegistration(registration: ClientHostRegistration): void {
  if (registration.kind !== "remote") {
    throw new Error("Only remote hosts may be upserted into the federation registry.");
  }
  if (registration.hostId === LOCAL_HOST_ID) {
    throw new Error("Remote registration cannot use the local host id.");
  }
  if (registration.origin === undefined || registration.origin.length === 0) {
    throw new Error("Remote hosts require an origin.");
  }
  if (registration.credential === undefined) {
    throw new Error("Remote hosts require an independent credential handle.");
  }
  if (registration.credential.keyId.length === 0) {
    throw new Error("Remote credential handle requires a keyId.");
  }
}

function parseStored(raw: string): ClientHostRegistration[] {
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed)) {
    throw new Error("Host registry is corrupt.");
  }
  return parsed.map((entry) => {
    if (entry === null || typeof entry !== "object") {
      throw new Error("Host registry entry is corrupt.");
    }
    const record = entry as Record<string, unknown>;
    const hostId = decodeHostId(record.hostId);
    const kind = record.kind;
    if (kind !== "local" && kind !== "remote") {
      throw new Error("Host registry entry has an invalid kind.");
    }
    if (typeof record.displayName !== "string" || record.displayName.length === 0) {
      throw new Error("Host registry entry is missing displayName.");
    }
    if (typeof record.enabled !== "boolean") {
      throw new Error("Host registry entry is missing enabled.");
    }
    const base: ClientHostRegistration = {
      hostId,
      kind,
      displayName: record.displayName,
      enabled: record.enabled,
    };
    if (typeof record.origin === "string") {
      return {
        ...base,
        origin: record.origin,
        ...(Array.isArray(record.lastKnownCapabilities)
          ? {
              lastKnownCapabilities: record.lastKnownCapabilities.filter(
                (c): c is string => typeof c === "string",
              ),
            }
          : {}),
        ...(record.cacheMetadata !== undefined &&
        record.cacheMetadata !== null &&
        typeof record.cacheMetadata === "object"
          ? {
              cacheMetadata: record.cacheMetadata as NonNullable<
                ClientHostRegistration["cacheMetadata"]
              >,
            }
          : {}),
        ...(record.credential !== undefined &&
        record.credential !== null &&
        typeof record.credential === "object"
          ? { credential: record.credential as ClientHostCredentialHandle }
          : {}),
      };
    }
    return {
      ...base,
      ...(Array.isArray(record.lastKnownCapabilities)
        ? {
            lastKnownCapabilities: record.lastKnownCapabilities.filter(
              (c): c is string => typeof c === "string",
            ),
          }
        : {}),
      ...(record.cacheMetadata !== undefined &&
      record.cacheMetadata !== null &&
      typeof record.cacheMetadata === "object"
        ? {
            cacheMetadata: record.cacheMetadata as NonNullable<
              ClientHostRegistration["cacheMetadata"]
            >,
          }
        : {}),
      ...(kind === "remote" &&
      record.credential !== undefined &&
      record.credential !== null &&
      typeof record.credential === "object"
        ? { credential: record.credential as ClientHostCredentialHandle }
        : {}),
    };
  });
}

/**
 * Ensure the local host is always first and present. Remote entries keep their
 * order. Local credential handles are never synthesized.
 */
function withLocalHost(hosts: ReadonlyArray<ClientHostRegistration>): ClientHostRegistration[] {
  const remotes = hosts.filter((host) => host.kind === "remote" && host.hostId !== LOCAL_HOST_ID);
  const existingLocal = hosts.find(
    (host) => host.hostId === LOCAL_HOST_ID && host.kind === "local",
  );
  const local: ClientHostRegistration = existingLocal
    ? {
        hostId: LOCAL_HOST_ID,
        kind: "local",
        displayName:
          existingLocal.displayName.length > 0 ? existingLocal.displayName : localHostDisplayName(),
        enabled: existingLocal.enabled,
        ...(existingLocal.lastKnownCapabilities !== undefined
          ? { lastKnownCapabilities: existingLocal.lastKnownCapabilities }
          : {}),
        ...(existingLocal.cacheMetadata !== undefined
          ? { cacheMetadata: existingLocal.cacheMetadata }
          : {}),
      }
    : localHostRegistration();
  return [local, ...remotes];
}

/**
 * True when two credential handles refer to distinct device credentials.
 * Used by tests and callers to prove no cross-host join.
 */
export function credentialHandlesAreIndependent(
  left: ClientHostCredentialHandle | undefined,
  right: ClientHostCredentialHandle | undefined,
): boolean {
  if (left === undefined || right === undefined) return true;
  return left.keyId !== right.keyId;
}

export function createClientHostRegistry(storage: ClientHostRegistryStorage): ClientHostRegistry {
  const readAll = async (): Promise<ClientHostRegistration[]> => {
    const raw = await storage.getItem(REGISTRY_KEY);
    if (raw === null || raw.length === 0) {
      return withLocalHost([]);
    }
    return withLocalHost(parseStored(raw));
  };

  const writeAll = async (hosts: ReadonlyArray<ClientHostRegistration>): Promise<void> => {
    const normalized = withLocalHost(hosts);
    await storage.setItem(REGISTRY_KEY, JSON.stringify(normalized));
  };

  return {
    async list() {
      return readAll();
    },

    async get(hostId) {
      const id = decodeHostId(hostId);
      return (await readAll()).find((host) => host.hostId === id);
    },

    async upsertRemote(registration) {
      assertRemoteRegistration(registration);
      const hostId = decodeHostId(registration.hostId);
      const hosts = await readAll();
      const credential = registration.credential!;
      const conflicting = hosts.find(
        (host) =>
          host.hostId !== hostId &&
          host.credential !== undefined &&
          host.credential.keyId === credential.keyId,
      );
      if (conflicting !== undefined) {
        throw new Error(
          `Credential keyId is already bound to host ${conflicting.hostId}; credentials must not join across hosts.`,
        );
      }
      const nextRemote: ClientHostRegistration = {
        ...registration,
        hostId,
        kind: "remote",
        credential,
      };
      const index = hosts.findIndex((host) => host.hostId === hostId);
      if (index >= 0) {
        const existing = hosts[index];
        if (existing?.kind === "local") {
          throw new Error("Cannot replace the local host with a remote registration.");
        }
        hosts[index] = nextRemote;
      } else {
        hosts.push(nextRemote);
      }
      await writeAll(hosts);
    },

    async removeRemote(hostId) {
      const id = decodeHostId(hostId);
      if (id === LOCAL_HOST_ID) {
        throw new Error("Cannot remove the local host from the federation registry.");
      }
      const hosts = await readAll();
      const removed = hosts.find((host) => host.hostId === id && host.kind === "remote");
      if (removed === undefined) return undefined;
      await writeAll(hosts.filter((host) => host.hostId !== id));
      return removed;
    },

    async update(hostId, patch) {
      const id = decodeHostId(hostId);
      const hosts = await readAll();
      const index = hosts.findIndex((host) => host.hostId === id);
      if (index < 0) {
        throw new Error(`Unknown host ${id}.`);
      }
      const current = hosts[index]!;
      if (current.kind === "local" && patch.credential !== undefined) {
        throw new Error("The local host cannot carry a remote device credential handle.");
      }
      if (patch.credential !== undefined) {
        const conflicting = hosts.find(
          (host) =>
            host.hostId !== id &&
            host.credential !== undefined &&
            host.credential.keyId === patch.credential!.keyId,
        );
        if (conflicting !== undefined) {
          throw new Error(
            `Credential keyId is already bound to host ${conflicting.hostId}; credentials must not join across hosts.`,
          );
        }
      }
      const updated: ClientHostRegistration = {
        hostId: current.hostId,
        kind: current.kind,
        displayName: patch.displayName ?? current.displayName,
        enabled: patch.enabled ?? current.enabled,
        ...(current.origin !== undefined ? { origin: current.origin } : {}),
        ...(patch.lastKnownCapabilities !== undefined
          ? { lastKnownCapabilities: patch.lastKnownCapabilities }
          : current.lastKnownCapabilities !== undefined
            ? { lastKnownCapabilities: current.lastKnownCapabilities }
            : {}),
        ...(patch.cacheMetadata !== undefined
          ? { cacheMetadata: patch.cacheMetadata }
          : current.cacheMetadata !== undefined
            ? { cacheMetadata: current.cacheMetadata }
            : {}),
        ...(current.kind === "remote"
          ? {
              credential: patch.credential !== undefined ? patch.credential : current.credential!,
            }
          : {}),
      };
      hosts[index] = updated;
      await writeAll(hosts);
      return (await readAll()).find((host) => host.hostId === id)!;
    },
  };
}

export function createInMemoryClientHostRegistryStorage(): ClientHostRegistryStorage {
  const values = new Map<string, string>();
  return {
    async getItem(key) {
      return values.get(key) ?? null;
    },
    async setItem(key, value) {
      values.set(key, value);
    },
    async deleteItem(key) {
      values.delete(key);
    },
  };
}

/**
 * Forget one host's device key by handle without touching other hosts' keys.
 * Reuses `RemoteDeviceKeyStore.remove` — no cross-host credential join.
 */
export async function forgetHostCredential(
  store: { readonly remove: (keyId: string) => Promise<void> },
  handle: ClientHostCredentialHandle | undefined,
): Promise<void> {
  if (handle === undefined) return;
  await store.remove(handle.keyId);
}
