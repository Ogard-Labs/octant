import {
  relayAddressFromResponse,
  REMOTE_RELAY_ADDRESS_PATH,
  type RemoteSessionBridge,
} from "@octant/client-runtime";
import type { RelayChoiceStore } from "../hosts/relayChoiceStore";

/** How often a connected computer is asked again where its hub's relay is. */
export const RELAY_ADDRESS_REFRESH_MS = 10 * 60 * 1000;

type Connection = NonNullable<ReturnType<RemoteSessionBridge["connection"]>>;

interface LookupSlot {
  readonly registration: { readonly origin: string };
  readonly state: { readonly kind: string };
  readonly bridge: {
    readonly connection: () => Pick<Connection, "authenticatedFetch"> | undefined;
  };
}

/**
 * Asks each connected computer where its hub's relay is. It answers only on
 * the private network, so a lookup through the relay is refused and changes
 * nothing. A computer is asked when its connection becomes ready, every ten
 * minutes while it stays so, and when the person turns its relay switch on:
 * its own person may have allowed the phone only after an earlier lookup
 * answered unavailable, and a phone that leaves home without the address
 * cannot learn it there.
 */
export function createRelayAddressLookup(input: {
  readonly hub: {
    readonly slots: () => ReadonlyArray<LookupSlot>;
    readonly subscribe: (listener: () => void) => () => void;
  };
  readonly choices: RelayChoiceStore;
}): {
  /** The choices, with turning one on asking that computer at once. */
  readonly choices: RelayChoiceStore;
  /** Looks up on each new connection and on a timer; returns the stop. */
  readonly start: () => () => void;
} {
  const latest = new Map<string, number>();
  const ask = (slot: LookupSlot): void => {
    if (slot.state.kind !== "ready") return;
    const connection = slot.bridge.connection();
    if (connection === undefined) return;
    const origin = slot.registration.origin;
    const turn = (latest.get(origin) ?? 0) + 1;
    latest.set(origin, turn);
    void connection
      .authenticatedFetch({ method: "GET", path: REMOTE_RELAY_ADDRESS_PATH })
      .then(relayAddressFromResponse)
      .then((learned) => {
        // An older answer arriving late must not undo a newer one, and a
        // computer removed meanwhile keeps nothing.
        if (learned === "unchanged" || latest.get(origin) !== turn) return undefined;
        if (!input.hub.slots().some((held) => held.registration.origin === origin)) {
          return undefined;
        }
        return input.choices.rememberAddress(origin, learned);
      })
      .catch(() => undefined);
  };
  return {
    choices: {
      ...input.choices,
      setEnabled: async (origin, enabled) => {
        await input.choices.setEnabled(origin, enabled);
        if (!enabled) return;
        for (const slot of input.hub.slots()) {
          if (slot.registration.origin === origin) ask(slot);
        }
      },
    },
    start: () => {
      let ready = new Set<string>();
      const askNewlyReady = (): void => {
        const now = new Set<string>();
        for (const slot of input.hub.slots()) {
          if (slot.state.kind !== "ready") continue;
          now.add(slot.registration.origin);
          if (!ready.has(slot.registration.origin)) ask(slot);
        }
        ready = now;
      };
      askNewlyReady();
      const unsubscribe = input.hub.subscribe(askNewlyReady);
      const refresh = setInterval(() => {
        for (const slot of input.hub.slots()) ask(slot);
      }, RELAY_ADDRESS_REFRESH_MS);
      return () => {
        unsubscribe();
        clearInterval(refresh);
      };
    },
  };
}
