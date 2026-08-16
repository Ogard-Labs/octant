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

export interface MobileHostRegistry {
  readonly list: () => Promise<ReadonlyArray<MobileHostRegistration>>;
  readonly upsert: (registration: MobileHostRegistration) => Promise<void>;
  readonly remove: (hostId: string) => Promise<void>;
  readonly get: (hostId: string) => Promise<MobileHostRegistration | undefined>;
}

export function createMobileHostRegistry(storage: MobileHostRegistryStorage): MobileHostRegistry {
  const readAll = async (): Promise<MobileHostRegistration[]> => {
    const raw = await storage.getItem(REGISTRY_KEY);
    if (raw === null || raw.length === 0) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      throw new Error("Host registry is corrupt.");
    }
    return parsed as MobileHostRegistration[];
  };

  const writeAll = async (hosts: ReadonlyArray<MobileHostRegistration>): Promise<void> => {
    if (hosts.length === 0) {
      await storage.deleteItem(REGISTRY_KEY);
      return;
    }
    await storage.setItem(REGISTRY_KEY, JSON.stringify(hosts));
  };

  return {
    async list() {
      return readAll();
    },
    async get(hostId) {
      return (await readAll()).find((host) => host.hostId === hostId);
    },
    async upsert(registration) {
      const hosts = await readAll();
      const index = hosts.findIndex((host) => host.hostId === registration.hostId);
      if (index >= 0) {
        hosts[index] = registration;
      } else {
        hosts.push(registration);
      }
      await writeAll(hosts);
    },
    async remove(hostId) {
      await writeAll((await readAll()).filter((host) => host.hostId !== hostId));
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
