// A browser as a guest of a hub: what it keeps about the hub it joined, and the
// owner clients it can build from that. A browser cannot check a listener's
// certificate pin, so it reaches a host only at the origin that served its
// page, under its own certificate check (the host's Tailscale certificate).
// Everything else in the guest protocol is in @octant/client-runtime.

import { decodeSignedHubRoster } from "@octant/contracts";
import {
  admitGuestOnSpoke,
  createGuestSigner,
  createOwnerClient,
  guestSpokeTargets,
  type GuestHubRecord,
  type GuestSigner,
  type GuestSpokeAdmission,
  type GuestSpokeTarget,
  type OwnerSpoke,
  type OwnerUnlockSigner,
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
 * The only ways a browser reaches a host: the origin that served this page, and
 * the web app origins the hub's signed roster names for its spokes. It checks
 * each against its own certificate authorities. A pin cannot be checked here,
 * so a request that asks for one is not sent, and nothing else is reachable.
 */
export function browserPageTransport(
  pageOrigin: string,
  rosterOrigins: ReadonlyArray<string> = [],
): PinnedListenerTransportPort {
  return ({ origin, trust }) =>
    (origin === pageOrigin || rosterOrigins.includes(origin)) && trust.current.kind === "platform"
      ? { status: "available", fetch: (input, init) => globalThis.fetch(input, init) }
      : { status: "unavailable" };
}

/** The web app origins the held, hub-signed roster names: where a browser may reach a spoke directly. */
export function rosterWebOrigins(record: GuestHubRecord): ReadonlyArray<string> {
  return guestSpokeTargets(record).flatMap((target) =>
    target.webOrigin === undefined ? [] : [target.webOrigin],
  );
}

/** A member of the hub as the browser lists it, with the link to its own web app when it serves one. */
export interface BrowserMemberLink {
  readonly memberId: string;
  readonly name: string;
  readonly role: GuestSpokeTarget["role"];
  /** Where the member serves its own web app; absent when the roster names no Tailscale name for it. */
  readonly webOrigin?: string;
  /** Whether this page is that member's own web app. */
  readonly here: boolean;
}

export function browserMemberLinks(
  record: GuestHubRecord,
  pageOrigin: string,
): ReadonlyArray<BrowserMemberLink> {
  return guestSpokeTargets(record).map((target) => ({
    memberId: target.memberId,
    name: target.name,
    role: target.role,
    ...(target.webOrigin === undefined ? {} : { webOrigin: target.webOrigin }),
    here: target.webOrigin === pageOrigin || target.origin === pageOrigin,
  }));
}

async function browserIdentity(input: {
  readonly state: BrowserGuestState;
  readonly deviceKeyStore: RemoteDeviceKeyStore;
}): Promise<GuestSigner | undefined> {
  const keyPair = await input.deviceKeyStore.get(input.state.record.deviceKeyId);
  if (keyPair === undefined) return undefined;
  return createGuestSigner({ memberId: input.state.record.selfMemberId, keyPair });
}

/**
 * Asks one spoke, at its own web app origin, to admit this browser as a guest.
 * The introduction is the hub-signed roster the spoke already holds, which lists
 * this browser's device key; the spoke refuses a browser it did not accept, and
 * this browser takes the refusal as it was said. Nothing goes through the hub.
 */
export async function admitBrowserOnSpoke(input: {
  readonly state: BrowserGuestState;
  readonly deviceKeyStore: RemoteDeviceKeyStore;
  readonly pageOrigin: string;
  readonly memberId: string;
}): Promise<GuestSpokeAdmission> {
  const target = guestSpokeTargets(input.state.record).find(
    (entry) => entry.memberId === input.memberId && entry.role === "spoke",
  );
  const signer = await browserIdentity(input);
  if (target === undefined || signer === undefined) return { status: "unreachable" };
  return admitGuestOnSpoke({
    target,
    signer,
    deviceLabel: input.state.deviceLabel,
    transport: browserPageTransport(input.pageOrigin, rosterWebOrigins(input.state.record)),
    via: "web-origin",
  });
}

/**
 * An owner client for each roster spoke the browser can reach, or none when the
 * browser did not join as an owner or holds no passkey. A passkey belongs to one
 * origin, so only a spoke whose own web app served this page can be unlocked
 * with it. A spoke the roster names a web app origin for is read from there
 * with the browser's device key alone, and a client that can only read says
 * where to go to act (`openAt`); the passkey is asked for there.
 */
export async function browserOwnerSpokes(input: {
  readonly state: BrowserGuestState;
  readonly deviceKeyStore: RemoteDeviceKeyStore;
  readonly credentials: PasskeyCredentials;
  readonly pageOrigin: string;
}): Promise<ReadonlyArray<OwnerSpoke>> {
  const { state } = input;
  if (state.ownerPasskey === undefined) return [];
  const identity = await browserIdentity(input);
  if (identity === undefined) return [];
  const unlock = passkeyUnlockSigner({
    credentials: input.credentials,
    passkey: state.ownerPasskey,
  });
  // Reading needs no unlock; a signer that cannot answer keeps any action here
  // from asking a passkey for an origin it was not made for.
  const readOnly: OwnerUnlockSigner = {
    shape: "webauthn",
    publicKey: state.ownerPasskey.publicKey,
    assert: async () => ({ status: "unavailable" }),
  };
  const transport = browserPageTransport(input.pageOrigin, rosterWebOrigins(state.record));
  return guestSpokeTargets(state.record)
    .filter((target) => target.role === "spoke")
    .flatMap((target): ReadonlyArray<OwnerSpoke> => {
      const here = target.origin === input.pageOrigin || target.webOrigin === input.pageOrigin;
      const origin = here ? input.pageOrigin : target.webOrigin;
      if (origin === undefined) return [];
      return [
        {
          memberId: target.memberId,
          name: target.name,
          ...(here ? {} : { openAt: origin }),
          client: createOwnerClient({
            target: { memberId: target.memberId, origin },
            identity,
            unlock: here ? unlock : readOnly,
            transport,
          }),
        },
      ];
    });
}
