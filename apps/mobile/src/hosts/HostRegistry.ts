export interface MobileHostRegistration {
  readonly hostId: string;
  readonly origin: string;
  readonly label: string;
  readonly keyId: string;
  readonly credentialGeneration: number;
  readonly hostKeyFingerprint: string;
}

export interface MobileHostRegistryStorage {
  readonly getItem: (key: string) => Promise<string | null>;
  readonly setItem: (key: string, value: string) => Promise<void>;
  readonly deleteItem: (key: string) => Promise<void>;
}

const REGISTRY_KEY = "octant.mobile.host-registry.v1";

/** Expected failure as a value: the stored list could not be trusted. */
export type MobileHostRegistryRead =
  | { readonly kind: "ok"; readonly hosts: ReadonlyArray<MobileHostRegistration> }
  | { readonly kind: "unreadable"; readonly reason: string };

export interface MobileHostRegistry {
  readonly list: () => Promise<MobileHostRegistryRead>;
  readonly upsert: (registration: MobileHostRegistration) => Promise<void>;
  readonly remove: (hostId: string) => Promise<void>;
  readonly get: (hostId: string) => Promise<MobileHostRegistration | undefined>;
}

function isRegistration(value: unknown): value is MobileHostRegistration {
  if (typeof value !== "object" || value === null) return false;
  const entry = value as Record<string, unknown>;
  return (
    typeof entry.hostId === "string" &&
    entry.hostId.length > 0 &&
    typeof entry.origin === "string" &&
    entry.origin.length > 0 &&
    typeof entry.label === "string" &&
    typeof entry.keyId === "string" &&
    typeof entry.credentialGeneration === "number" &&
    Number.isFinite(entry.credentialGeneration) &&
    typeof entry.hostKeyFingerprint === "string"
  );
}

export function createMobileHostRegistry(storage: MobileHostRegistryStorage): MobileHostRegistry {
  const readAll = async (): Promise<MobileHostRegistryRead> => {
    const raw = await storage.getItem(REGISTRY_KEY);
    if (raw === null || raw.length === 0) return { kind: "ok", hosts: [] };
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return { kind: "unreadable", reason: "The stored host list is not valid JSON." };
    }
    if (!Array.isArray(parsed)) {
      return { kind: "unreadable", reason: "The stored host list is not a list." };
    }
    const hosts: MobileHostRegistration[] = [];
    for (const entry of parsed) {
      if (!isRegistration(entry)) {
        return { kind: "unreadable", reason: "A stored host entry is missing required fields." };
      }
      hosts.push(entry);
    }
    return { kind: "ok", hosts };
  };

  const writeAll = async (hosts: ReadonlyArray<MobileHostRegistration>): Promise<void> => {
    if (hosts.length === 0) {
      await storage.deleteItem(REGISTRY_KEY);
      return;
    }
    await storage.setItem(REGISTRY_KEY, JSON.stringify(hosts));
  };

  // Pairing and removal each read the whole list, change one entry and write it
  // back; two that overlap would each write from the old list and drop the
  // other's change. Writes therefore run one after another.
  let writes: Promise<unknown> = Promise.resolve();
  const serialised = <T>(task: () => Promise<T>): Promise<T> => {
    const run = writes.then(task);
    writes = run.catch(() => undefined);
    return run;
  };

  // An unreadable list is replaced rather than extended: pairing again is the
  // only way out of a corrupt store, and removing from it must still empty it.
  const hostsOrEmpty = (read: MobileHostRegistryRead): MobileHostRegistration[] =>
    read.kind === "ok" ? [...read.hosts] : [];

  return {
    async list() {
      return readAll();
    },
    async get(hostId) {
      const read = await readAll();
      return read.kind === "ok" ? read.hosts.find((host) => host.hostId === hostId) : undefined;
    },
    upsert(registration) {
      return serialised(async () => {
        const hosts = hostsOrEmpty(await readAll());
        const index = hosts.findIndex((host) => host.hostId === registration.hostId);
        if (index >= 0) {
          hosts[index] = registration;
        } else {
          hosts.push(registration);
        }
        await writeAll(hosts);
      });
    },
    remove(hostId) {
      return serialised(async () => {
        await writeAll(hostsOrEmpty(await readAll()).filter((host) => host.hostId !== hostId));
      });
    },
  };
}

export function createInMemoryMobileHostRegistryStorage(): MobileHostRegistryStorage {
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
