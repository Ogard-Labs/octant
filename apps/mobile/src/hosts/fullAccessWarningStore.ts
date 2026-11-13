import type { MobileHostRegistryStorage } from "./HostRegistry";

const STORE_KEY = "octant.mobile.full-access-warned.v1";

/**
 * The hosts whose one-time Full access warning this phone has shown and had
 * accepted. Kept with the phone's other per-host facts so the warning is
 * shown once per host and not once per app run.
 */
export interface FullAccessWarningStore {
  readonly acknowledged: (hostId: string) => Promise<boolean>;
  readonly acknowledge: (hostId: string) => Promise<void>;
}

export function createFullAccessWarningStore(
  storage: MobileHostRegistryStorage,
): FullAccessWarningStore {
  // A list that cannot be read reads as empty: showing the warning again is
  // the safe side.
  const read = async (): Promise<ReadonlyArray<string>> => {
    try {
      const parsed: unknown = JSON.parse((await storage.getItem(STORE_KEY)) ?? "[]");
      return Array.isArray(parsed)
        ? parsed.filter((entry): entry is string => typeof entry === "string")
        : [];
    } catch {
      return [];
    }
  };
  return {
    acknowledged: async (hostId) => (await read()).includes(hostId),
    async acknowledge(hostId) {
      const hosts = await read();
      if (hosts.includes(hostId)) return;
      try {
        await storage.setItem(STORE_KEY, JSON.stringify([...hosts, hostId]));
      } catch {
        // Not remembered: the warning is shown again next time.
      }
    },
  };
}
