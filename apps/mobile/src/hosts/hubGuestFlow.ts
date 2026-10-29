// The phone as a guest of a hub: what it keeps about the hub, how it adds each
// spoke that admitted it as a host the app can open, and how it re-reads the
// hub's roster when the app opens so a removed member disappears. The hub and
// spoke protocol is in @octant/client-runtime (hubGuestClient); this file only
// joins it to the phone's host list and device keys.

import { decodeSignedHubRoster } from "@octant/contracts";
import { decodeStableHostId } from "@octant/contracts/remote-access";
import {
  admitGuestOnSpoke,
  createGuestSigner,
  guestSpokeTargets,
  refreshGuestRoster,
  type GuestHubRecord,
  type GuestJoinFinish,
  type GuestSigner,
  type PinnedListenerTransportPort,
  type RemoteDeviceKeyStore,
} from "@octant/client-runtime";
import type { MobileHostRegistry, MobileHostRegistryStorage } from "./HostRegistry";

/** A spoke that admitted this phone, as the host list holds it. */
export interface GuestSpokeHost {
  readonly memberId: string;
  readonly hostId: string;
  /** The device the spoke made for this phone; a different one on reopening means the spoke let the old one go. */
  readonly deviceId?: string;
}

/** A spoke on the roster that refused this phone; it stays listed, with no action. */
export interface GuestSpokeRefusal {
  readonly memberId: string;
  readonly name: string;
}

/** What the phone keeps about the hub it joined. No key material: the device key lives in the key store. */
export interface GuestHubState {
  readonly record: GuestHubRecord;
  readonly deviceLabel: string;
  readonly spokes: ReadonlyArray<GuestSpokeHost>;
  readonly notAccepted: ReadonlyArray<GuestSpokeRefusal>;
  /** Set when the phone joined with an owner code and presented its unlock key. */
  readonly owner?: true;
}

export interface GuestHubStore {
  readonly load: () => Promise<GuestHubState | undefined>;
  readonly save: (state: GuestHubState) => Promise<void>;
  readonly clear: () => Promise<void>;
}

const STORE_KEY = "octant.mobile.guest-hub.v1";

export function createGuestHubStore(storage: MobileHostRegistryStorage): GuestHubStore {
  return {
    async load() {
      const raw = await storage.getItem(STORE_KEY);
      if (raw === null || raw.length === 0) return undefined;
      try {
        const parsed: unknown = JSON.parse(raw);
        if (typeof parsed !== "object" || parsed === null) return undefined;
        const state = parsed as GuestHubState;
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

export interface GuestSpokeDependencies {
  readonly transport: PinnedListenerTransportPort;
  readonly deviceKeyStore: RemoteDeviceKeyStore;
  readonly registry: Pick<MobileHostRegistry, "upsert">;
  /** Takes a host off the phone and deletes what the phone holds for it. */
  readonly removeHost: (hostId: string) => Promise<unknown>;
  /** Waits before asking a spoke again; the phone uses a real timer, tests an instant one. */
  readonly retryDelay?: (milliseconds: number) => Promise<void>;
}

// The hub publishes a new roster without waiting for the spokes, so the first
// ask can reach a spoke that has not heard of this phone yet.
const ROSTER_RETRY_DELAYS_MS = [500, 1500, 4000] as const;

const wait = (milliseconds: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

async function admitGuestWithRetry(
  input: Parameters<typeof admitGuestOnSpoke>[0],
  retryDelay: (milliseconds: number) => Promise<void>,
): ReturnType<typeof admitGuestOnSpoke> {
  let admission = await admitGuestOnSpoke(input);
  for (const delay of ROSTER_RETRY_DELAYS_MS) {
    if (admission.status !== "refused" || admission.kind !== "not-in-roster") break;
    await retryDelay(delay);
    admission = await admitGuestOnSpoke(input);
  }
  return admission;
}

/**
 * Brings the phone's hosts in line with a roster: every spoke on it is asked,
 * directly, to admit this phone and is added as a host when it does; a spoke
 * that refuses is recorded as not accepting; a host for a spoke that left the
 * roster is removed. A spoke that cannot be reached is left as it was and asked
 * again the next time the app opens.
 */
export async function connectGuestSpokes(
  input: GuestSpokeDependencies & {
    readonly record: GuestHubRecord;
    readonly signer: GuestSigner;
    readonly deviceLabel: string;
    readonly previous?: GuestHubState;
  },
): Promise<GuestHubState> {
  const targets = guestSpokeTargets(input.record).filter((target) => target.role === "spoke");
  const onRoster = new Set(targets.map((target) => target.memberId));
  const held = new Map((input.previous?.spokes ?? []).map((spoke) => [spoke.memberId, spoke]));
  const refusedBefore = new Map(
    (input.previous?.notAccepted ?? []).map((spoke) => [spoke.memberId, spoke]),
  );

  for (const [memberId, spoke] of held) {
    if (onRoster.has(memberId)) continue;
    await input.removeHost(spoke.hostId);
    held.delete(memberId);
  }

  const notAccepted = new Map<string, GuestSpokeRefusal>();
  for (const target of targets) {
    // A saved spoke is asked again: one that left and rejoined while the phone
    // was away revoked its device and now answers with a new one.
    const saved = held.get(target.memberId);
    const admission = await admitGuestWithRetry(
      {
        target,
        signer: input.signer,
        deviceLabel: input.deviceLabel,
        transport: input.transport,
      },
      input.retryDelay ?? wait,
    );
    if (admission.status === "refused") {
      if (saved !== undefined) {
        await input.removeHost(saved.hostId);
        held.delete(target.memberId);
      }
      notAccepted.set(target.memberId, { memberId: target.memberId, name: target.name });
      continue;
    }
    if (admission.status === "unreachable") {
      const before = refusedBefore.get(target.memberId);
      if (before !== undefined && saved === undefined) notAccepted.set(target.memberId, before);
      continue;
    }
    if (saved !== undefined) {
      if (saved.deviceId === admission.deviceId) continue;
      await input.removeHost(saved.hostId);
      held.delete(target.memberId);
    }
    const member = input.record.roster.roster.members.find(
      (entry) => String(entry.memberId) === target.memberId,
    );
    if (member === undefined) continue;
    // The phone reaches the spoke with the key it paired with at the hub, held
    // to the pin the roster gave: the spoke admitted that key as a paired device.
    // The key is copied inside the store, never read out: the phone's store hands
    // a saved key back non-extractable and could not save it again.
    const hostId = decodeStableHostId(target.memberId);
    let keyId: string | undefined;
    try {
      keyId = await input.deviceKeyStore.copyKey(input.record.deviceKeyId, {
        origin: target.origin,
        hostId,
      });
      if (keyId === undefined) continue;
      await input.deviceKeyStore.updateMetadata(keyId, {
        deviceId: admission.deviceId,
        credentialGeneration: 1,
        hostKeyFingerprint: member.identityKeyFingerprint,
        listenerTrust: { current: { kind: "pinned", pin: target.pin } },
      });
      await input.registry.upsert({
        hostId: target.memberId,
        origin: target.origin,
        label: target.name,
        keyId,
        credentialGeneration: 1,
        hostKeyFingerprint: member.identityKeyFingerprint,
      });
    } catch {
      // One spoke that cannot be saved must not undo the others or the join:
      // it is left out and admitted again the next time the app opens.
      if (keyId !== undefined) await input.deviceKeyStore.remove(keyId).catch(() => undefined);
      continue;
    }
    held.set(target.memberId, {
      memberId: target.memberId,
      hostId: target.memberId,
      deviceId: admission.deviceId,
    });
  }

  return {
    record: input.record,
    deviceLabel: input.deviceLabel,
    spokes: [...held.values()],
    notAccepted: [...notAccepted.values()],
  };
}

export type GuestJoinOutcome =
  | { readonly status: "waiting" }
  | { readonly status: "joined"; readonly state: GuestHubState }
  | {
      readonly status: "refused";
      readonly kind: Extract<GuestJoinFinish, { status: "refused" }>["kind"];
    };

/** One check of the hub's answer; once approved, the spokes are added and the hub is remembered. */
export async function finishGuestJoin(
  input: GuestSpokeDependencies & {
    readonly finish: () => Promise<GuestJoinFinish>;
    readonly deviceLabel: string;
    readonly store: GuestHubStore;
    /** The phone presented its unlock key with an owner code. */
    readonly owner?: boolean;
  },
): Promise<GuestJoinOutcome> {
  const finished = await input.finish();
  if (finished.status === "awaiting-approval") return { status: "waiting" };
  if (finished.status === "refused") return { status: "refused", kind: finished.kind };
  // The hub is a host in its own right, for the threads it runs. It is reached
  // with the pairing the person just approved, not through spoke admission.
  try {
    await input.registry.upsert({
      hostId: finished.approval.hostId,
      origin: finished.approval.origin,
      label: finished.record.hub.name,
      keyId: finished.approval.deviceKeyId,
      credentialGeneration: finished.approval.credentialGeneration,
      hostKeyFingerprint: finished.approval.hostKeyFingerprint,
    });
  } catch {
    // The join is done at the hub; a full store must not forget the hub or retry it.
  }
  const connected = await connectGuestSpokes({
    ...input,
    record: finished.record,
    signer: finished.signer,
  });
  const state: GuestHubState = input.owner === true ? { ...connected, owner: true } : connected;
  await input.store.save(state);
  return { status: "joined", state };
}

export type GuestReopenOutcome =
  | { readonly status: "none" }
  | { readonly status: "unchanged"; readonly state: GuestHubState }
  | { readonly status: "updated"; readonly state: GuestHubState }
  /** The hub refused the read for a reason that is not membership; nothing changed, ask again later. */
  | { readonly status: "retry-later"; readonly state: GuestHubState }
  | { readonly status: "removed" };

/**
 * Re-reads the hub's roster when the app opens. A roster the hub did not sign,
 * or an older one, changes nothing. When the hub no longer answers this phone
 * as a member, every host added through it is removed.
 */
export async function reopenGuestHub(
  input: GuestSpokeDependencies & { readonly store: GuestHubStore },
): Promise<GuestReopenOutcome> {
  const held = await input.store.load();
  if (held === undefined) return { status: "none" };
  const keyPair = await input.deviceKeyStore.get(held.record.deviceKeyId);
  if (keyPair === undefined) return { status: "unchanged", state: held };
  const signer = await createGuestSigner({ memberId: held.record.selfMemberId, keyPair });
  const refreshed = await refreshGuestRoster({
    record: held.record,
    signer,
    transport: input.transport,
  });
  if (refreshed.status === "hub-refused") {
    // Only the hub saying it does not know this guest ends membership. A stale
    // signed request (clock drift), a replay or a hub that is off is transient.
    if (refreshed.kind !== "unknown-sender") return { status: "retry-later", state: held };
    for (const spoke of held.spokes) await input.removeHost(spoke.hostId);
    await input.removeHost(held.record.hub.memberId);
    await input.store.clear();
    return { status: "removed" };
  }
  if (refreshed.status !== "accepted" && refreshed.status !== "unchanged") {
    return { status: "unchanged", state: held };
  }
  const connected = await connectGuestSpokes({
    ...input,
    record: refreshed.record,
    signer,
    deviceLabel: held.deviceLabel,
    previous: held,
  });
  const state: GuestHubState = held.owner === true ? { ...connected, owner: true } : connected;
  await input.store.save(state);
  return { status: "updated", state };
}
