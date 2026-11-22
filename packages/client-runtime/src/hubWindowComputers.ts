// A desktop window on a hub member, adding the hub and its other members as
// its computers. The window is a guest of the hub as a phone is: it holds a
// device key of its own, its host asks the hub to list that key on the roster,
// and the window then asks each member, directly over the private network, for
// a device of its own. Each member issues its own device and session, holds
// the window to its Act item (the hub to its own Act list), and drops it with
// the roster. Nothing goes through the hub but the introduction and the
// window's own session there.

import {
  HubMemberId,
  type HubWindowComputer,
  type HubWindowComputers,
  type HubWindowGuestRequest,
} from "@octant/contracts";
import { Schema } from "effect";
import { decodeHostId } from "@octant/contracts/host";
import { decodeStableHostId } from "@octant/contracts/remote-access";
import type { PinnedListenerTransportPort } from "./appPairingCode";
import type { ClientHostRegistry, ClientHostRegistryStorage } from "./hostFederationRegistry";
import { admitGuestOnSpoke, createGuestSigner, type GuestSpokeAdmission } from "./hubGuestClient";
import type { RemoteDeviceKeyStore } from "./remotePairingClient";

/** What the window keeps about its guest identity; the key itself stays in the key store. */
export interface HubWindowIdentity {
  readonly memberId: string;
  readonly keyId: string;
}

export interface HubWindowIdentityStore {
  readonly load: () => Promise<HubWindowIdentity | undefined>;
  readonly save: (identity: HubWindowIdentity) => Promise<void>;
}

const decodeHubMemberId = Schema.decodeUnknownSync(HubMemberId);

const IDENTITY_KEY = "octant.client.hub-window-identity.v1";

/**
 * The key store files the window's guest key under this origin. It is not a
 * listener origin, so no session is ever resumed with the key itself; each
 * member's copy is filed under that member's origin.
 */
export const HUB_WINDOW_KEY_ORIGIN = "octant-hub-window";

export function createHubWindowIdentityStore(
  storage: ClientHostRegistryStorage,
): HubWindowIdentityStore {
  return {
    async load() {
      const raw = await storage.getItem(IDENTITY_KEY);
      if (raw === null || raw.length === 0) return undefined;
      try {
        const value: unknown = JSON.parse(raw);
        if (typeof value !== "object" || value === null) return undefined;
        const { memberId, keyId } = value as Record<string, unknown>;
        return typeof memberId === "string" && typeof keyId === "string"
          ? { memberId, keyId }
          : undefined;
      } catch {
        // An unreadable identity is replaced by a new one, which the hub lists in its place.
        return undefined;
      }
    },
    save: (identity) => storage.setItem(IDENTITY_KEY, JSON.stringify(identity)),
  };
}

/**
 * What the window's host answered: its hub's members, no hub, or
 * `unavailable` when it could not be asked, which changes nothing listed.
 */
export type HubWindowIntroduction = HubWindowComputers | { readonly membership: "unavailable" };

export type HubWindowComputersSync =
  | { readonly status: "unavailable" }
  | { readonly status: "not-in-hub"; readonly removed: ReadonlyArray<string> }
  | {
      readonly status: "synced";
      /** Members the window now lists as computers, by member id. */
      readonly listed: ReadonlyArray<string>;
      /** Members that refused this window, with what each said. */
      readonly refused: ReadonlyArray<{ readonly memberId: string; readonly kind: string }>;
      /** Members this pass could not reach; a computer already listed for one stays. */
      readonly unreachable: ReadonlyArray<string>;
      /** Members dropped because the roster no longer lists them or they refused. */
      readonly removed: ReadonlyArray<string>;
      /** Members whose device changed; their sessions must be opened again with the new one. */
      readonly replaced: ReadonlyArray<string>;
    };

export interface SyncHubWindowComputersInput {
  /** The window's host: asks the hub to list the window, and names the members it may reach. */
  readonly introduce: (request: HubWindowGuestRequest) => Promise<HubWindowIntroduction>;
  /** How the window reaches a member, held to the pin the host's roster gives. */
  readonly transport: PinnedListenerTransportPort;
  readonly registry: ClientHostRegistry;
  readonly deviceKeyStore: RemoteDeviceKeyStore;
  readonly identity: HubWindowIdentityStore;
  readonly deviceLabel: string;
  /** Takes a computer off the window, with its key and whatever else the window keeps for it. */
  readonly removeHost: (hostId: string) => Promise<unknown>;
  /** Waits before asking a member again; tests pass an instant one. */
  readonly retryDelay?: (milliseconds: number) => Promise<void>;
}

// The hub sends the new roster before it answers, but a member that was slow
// to take it may not list this window on the first ask.
const ROSTER_RETRY_DELAYS_MS = [500, 1500, 4000] as const;

const wait = (milliseconds: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

/**
 * Brings the window's computers in line with its hub: the host asks the hub to
 * list the window, every member the host names is asked directly for a device
 * and listed when it gives one, a member that refuses or left the roster is
 * taken off, and a computer the person paired directly is never replaced.
 */
export async function syncHubWindowComputers(
  input: SyncHubWindowComputersInput,
): Promise<HubWindowComputersSync> {
  const held = await input.identity.load();
  const heldKey = held === undefined ? undefined : await input.deviceKeyStore.get(held.keyId);
  const keyPair =
    heldKey ??
    (await crypto.subtle.generateKey(
      { name: "ECDSA", namedCurve: "P-256" },
      input.deviceKeyStore.requiresExtractablePrivateKeys === true,
      ["sign", "verify"],
    ));
  const memberId =
    heldKey === undefined || held === undefined ? crypto.randomUUID() : held.memberId;
  const signer = await createGuestSigner({ memberId, keyPair });
  const answer = await input.introduce({
    memberId: decodeHubMemberId(memberId),
    devicePublicKey: signer.publicKey,
    deviceLabel: input.deviceLabel,
  });

  if (answer.membership === "unavailable") return { status: "unavailable" };
  const listedThroughHub = (await input.registry.list()).filter((host) => host.through === "hub");
  if (answer.membership === "none") {
    for (const host of listedThroughHub) await input.removeHost(String(host.hostId));
    return { status: "not-in-hub", removed: listedThroughHub.map((host) => String(host.hostId)) };
  }

  let identity = held !== undefined && heldKey !== undefined ? held : undefined;
  if (identity === undefined) {
    const keyId = await input.deviceKeyStore.set(keyPair, {
      origin: HUB_WINDOW_KEY_ORIGIN,
      hostId: decodeStableHostId(String(answer.hubMemberId)),
    });
    identity = { memberId, keyId };
    await input.identity.save(identity);
  }

  const removed: string[] = [];
  const onRoster = new Set(answer.members.map((member) => String(member.memberId)));
  for (const host of listedThroughHub) {
    if (onRoster.has(String(host.hostId))) continue;
    await input.removeHost(String(host.hostId));
    removed.push(String(host.hostId));
  }

  const listed: string[] = [];
  const refused: Array<{ readonly memberId: string; readonly kind: string }> = [];
  const unreachable: string[] = [];
  const replaced: string[] = [];
  for (const member of answer.members) {
    const hostId = String(member.memberId);
    const registered = await input.registry.get(hostId);
    // The person paired this computer directly: this device is that person
    // there, which a hub introduction must not narrow.
    if (registered !== undefined && registered.through !== "hub") continue;
    const admission = await admitWithRetry(
      member,
      signer,
      input.deviceLabel,
      input.transport,
      input.retryDelay ?? wait,
    );
    if (admission.status === "unreachable" || isAskAgainLater(admission)) {
      unreachable.push(hostId);
      if (registered !== undefined) listed.push(hostId);
      continue;
    }
    if (admission.status === "refused") {
      refused.push({ memberId: hostId, kind: admission.kind });
      if (registered !== undefined) {
        await input.removeHost(hostId);
        removed.push(hostId);
      }
      continue;
    }
    // The same device at the same address under the same keys needs nothing
    // new. A member whose listener moved keeps its device, but the old origin
    // and pin would be refused from now on, so it is saved again and its
    // session is made anew, as for a new device.
    const currentTrust = registered?.credential?.listenerTrust?.current;
    if (
      registered?.credential?.deviceId === admission.deviceId &&
      registered.role === member.role &&
      registered.origin === member.origin &&
      registered.credential.hostKeyFingerprint === member.identityKeyFingerprint &&
      currentTrust?.kind === "pinned" &&
      currentTrust.pin === member.pin
    ) {
      listed.push(hostId);
      continue;
    }
    // The member's key is copied inside the store, never read out: a stored
    // key may be non-extractable and could not be saved again.
    const keyId = await input.deviceKeyStore.copyKey(identity.keyId, {
      origin: member.origin,
      hostId: decodeStableHostId(hostId),
    });
    if (keyId === undefined) {
      unreachable.push(hostId);
      continue;
    }
    const listenerTrust = { current: { kind: "pinned", pin: member.pin } } as const;
    try {
      await input.deviceKeyStore.updateMetadata(keyId, {
        deviceId: admission.deviceId,
        credentialGeneration: 1,
        hostKeyFingerprint: member.identityKeyFingerprint,
        listenerTrust,
      });
      await input.registry.upsertRemote({
        hostId: decodeHostId(hostId),
        kind: "remote",
        displayName: member.name,
        origin: member.origin,
        enabled: true,
        through: "hub",
        ...(member.role === "hub" ? { role: "hub" as const } : {}),
        credential: {
          keyId,
          credentialGeneration: 1,
          hostKeyFingerprint: member.identityKeyFingerprint,
          deviceId: admission.deviceId,
          listenerTrust,
        },
      });
    } catch {
      // One member that cannot be saved must not undo the others: it is asked again next time.
      await input.deviceKeyStore.remove(keyId).catch(() => undefined);
      unreachable.push(hostId);
      continue;
    }
    // A member that left and rejoined revoked the old device and issued a new one.
    if (registered?.credential !== undefined) {
      await input.deviceKeyStore.remove(registered.credential.keyId).catch(() => undefined);
      replaced.push(hostId);
    }
    listed.push(hostId);
  }
  return { status: "synced", listed, refused, unreachable, removed, replaced };
}

/** A member whose device pairing is not running yet admits the window once it is. */
function isAskAgainLater(admission: GuestSpokeAdmission): boolean {
  return admission.status === "refused" && admission.kind === "devices-unavailable";
}

async function admitWithRetry(
  member: HubWindowComputer,
  signer: Awaited<ReturnType<typeof createGuestSigner>>,
  deviceLabel: string,
  transport: PinnedListenerTransportPort,
  retryDelay: (milliseconds: number) => Promise<void>,
): Promise<GuestSpokeAdmission> {
  const ask = () =>
    admitGuestOnSpoke({
      target: {
        memberId: String(member.memberId),
        name: member.name,
        role: "spoke",
        origin: member.origin,
        pin: member.pin,
      },
      signer,
      deviceLabel,
      transport,
    });
  let admission = await ask();
  for (const delay of ROSTER_RETRY_DELAYS_MS) {
    if (admission.status !== "refused" || admission.kind !== "not-in-roster") break;
    await retryDelay(delay);
    admission = await ask();
  }
  return admission;
}
