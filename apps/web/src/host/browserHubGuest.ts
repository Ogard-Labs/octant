// A browser as a guest of a hub: what it keeps about the hub it joined, and the
// owner clients it can build from that. A browser cannot check a listener's
// certificate pin, so it reaches a host only at the origin that served its
// page, under its own certificate check (the host's Tailscale certificate).
// Everything else in the guest protocol is in @octant/client-runtime.

import { decodeSignedHubRoster } from "@octant/contracts";
import {
  createGuestSigner,
  createOwnerClient,
  guestSpokeTargets,
  type GuestHubRecord,
  type OwnerSpoke,
  type PinnedListenerTransportPort,
  type RemoteDeviceKeyStore,
} from "@octant/client-runtime";
import type { ClientHostRegistryStorage } from "@octant/client-runtime/host-federation-registry";
import { passkeyUnlockSigner, type OwnerPasskey, type PasskeyCredentials } from "./ownerPasskey";

/** What the browser keeps about the hub it joined. No key material: the device key lives in the key store, the passkey in the authenticator. */
export interface BrowserGuestState {
  readonly record: GuestHubRecord;
  readonly deviceLabel: string;
  /** Set when the browser joined with an owner code and made a passkey for this origin. */
  readonly ownerPasskey?: OwnerPasskey;
}

export interface BrowserGuestStore {
  readonly load: () => Promise<BrowserGuestState | undefined>;
  readonly save: (state: BrowserGuestState) => Promise<void>;
  readonly clear: () => Promise<void>;
}

const STORE_KEY = "octant.web.guest-hub.v1";

export function createBrowserGuestStore(storage: ClientHostRegistryStorage): BrowserGuestStore {
  return {
    async load() {
      const raw = await storage.getItem(STORE_KEY);
      if (raw === null || raw.length === 0) return undefined;
      try {
        const parsed: unknown = JSON.parse(raw);
        if (typeof parsed !== "object" || parsed === null) return undefined;
        const state = parsed as BrowserGuestState;
        decodeSignedHubRoster(state.record.roster);
        return state;
      } catch {
        // A stored hub that cannot be trusted is not used; joining again replaces it.
        return undefined;
      }
    },
    save: (state) => storage.setItem(STORE_KEY, JSON.stringify(state)),
    clear: () => storage.deleteItem(STORE_KEY),
  };
}

/**
 * The only way a browser reaches a host: the origin that served this page,
 * which the browser has already checked against its certificate authorities.
 * A pin cannot be checked here, so a request that asks for one is not sent.
 */
export function browserPageTransport(pageOrigin: string): PinnedListenerTransportPort {
  return ({ origin, trust }) =>
    origin === pageOrigin && trust.current.kind === "platform"
      ? { status: "available", fetch: (input, init) => globalThis.fetch(input, init) }
      : { status: "unavailable" };
}

/**
 * An owner client for each roster spoke this page is served by, or none when
 * the browser did not join as an owner, holds no passkey, or is not on a
 * spoke's own origin. A passkey belongs to one origin, so it can never answer
 * for a computer the page was not served by.
 */
export async function browserOwnerSpokes(input: {
  readonly state: BrowserGuestState;
  readonly deviceKeyStore: RemoteDeviceKeyStore;
  readonly credentials: PasskeyCredentials;
  readonly pageOrigin: string;
}): Promise<ReadonlyArray<OwnerSpoke>> {
  const { state } = input;
  if (state.ownerPasskey === undefined) return [];
  const keyPair = await input.deviceKeyStore.get(state.record.deviceKeyId);
  if (keyPair === undefined) return [];
  const identity = await createGuestSigner({ memberId: state.record.selfMemberId, keyPair });
  const unlock = passkeyUnlockSigner({
    credentials: input.credentials,
    passkey: state.ownerPasskey,
  });
  const transport = browserPageTransport(input.pageOrigin);
  return guestSpokeTargets(state.record)
    .filter((target) => target.role === "spoke" && target.origin === input.pageOrigin)
    .map((target) => ({
      memberId: target.memberId,
      name: target.name,
      client: createOwnerClient({
        target: { memberId: target.memberId, origin: target.origin },
        identity,
        unlock,
        transport,
      }),
    }));
}
