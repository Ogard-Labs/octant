import { decodeRelayAddress, type RelayAddress } from "@octant/contracts";
import type { PairedHostRelayChoice } from "@octant/client-runtime";
import type { MobileHostRegistryStorage } from "./HostRegistry";

const STORE_KEY = "octant.mobile.relay-through-hub.v1";

/**
 * This phone's own choice, per paired computer, to reach it through its hub
 * when away (decision H36), and the relay address that computer told the
 * phone on the private network. Off until the person turns it on; the
 * computer's own person still decides whether this phone may come through.
 */
export interface RelayChoiceStore {
  readonly read: (origin: string) => Promise<PairedHostRelayChoice | undefined>;
  readonly setEnabled: (origin: string, enabled: boolean) => Promise<void>;
  readonly rememberAddress: (origin: string, address: RelayAddress | undefined) => Promise<void>;
  readonly forget: (origin: string) => Promise<void>;
  /** Hears of every kept change, so a shown choice follows an address learned later. */
  readonly subscribe: (listener: () => void) => () => void;
}

export function createRelayChoiceStore(storage: MobileHostRegistryStorage): RelayChoiceStore {
  // A record that cannot be read reads as no choice: the phone does not relay.
  const readAll = async (): Promise<Record<string, PairedHostRelayChoice>> => {
    try {
      const parsed: unknown = JSON.parse((await storage.getItem(STORE_KEY)) ?? "{}");
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
      const choices: Record<string, PairedHostRelayChoice> = {};
      for (const [origin, value] of Object.entries(parsed)) {
        if (typeof value !== "object" || value === null) continue;
        const { enabled, address } = value as Record<string, unknown>;
        if (typeof enabled !== "boolean") continue;
        let decoded: RelayAddress | undefined;
        try {
          decoded = address === undefined ? undefined : decodeRelayAddress(address);
        } catch {
          decoded = undefined;
        }
        choices[origin] = decoded === undefined ? { enabled } : { enabled, address: decoded };
      }
      return choices;
    } catch {
      return {};
    }
  };
  const write = async (
    origin: string,
    next: (current: PairedHostRelayChoice | undefined) => PairedHostRelayChoice | undefined,
  ): Promise<void> => {
    const all = await readAll();
    const updated = next(all[origin]);
    const { [origin]: _previous, ...rest } = all;
    await storage.setItem(
      STORE_KEY,
      JSON.stringify(updated === undefined ? rest : { ...rest, [origin]: updated }),
    );
  };
  // One change at a time: each reads every choice and writes them all back, so
  // two that overlapped could bring a forgotten computer's choice back.
  let last: Promise<unknown> = Promise.resolve();
  const listeners = new Set<() => void>();
  const change = (...args: Parameters<typeof write>): Promise<void> => {
    const run = last
      .then(() => write(...args))
      .then(() => {
        for (const listener of listeners) listener();
      });
    last = run.catch(() => undefined);
    return run;
  };
  return {
    read: async (origin) => (await readAll())[origin],
    setEnabled: (origin, enabled) =>
      change(origin, (current) => ({
        enabled,
        ...(current?.address === undefined ? {} : { address: current.address }),
      })),
    rememberAddress: (origin, address) =>
      change(origin, (current) => ({
        enabled: current?.enabled === true,
        ...(address === undefined ? {} : { address }),
      })),
    forget: (origin) => change(origin, () => undefined),
    subscribe: (listener) => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
  };
}
