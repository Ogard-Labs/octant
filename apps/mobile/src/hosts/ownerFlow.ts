// The phone as an owner device: it builds an owner client for each computer on
// the hub it joined with an owner code. Reading and acting on alerts is shared
// with the browser in @octant/client-runtime (ownerAlerts); the protocol is in
// hubOwnerClient, and the unlock key is in ownerUnlockKey.

import {
  createGuestSigner,
  createOwnerClient,
  guestSpokeTargets,
  type OwnerSpoke,
  type PinnedListenerTransportPort,
  type RemoteDeviceKeyStore,
} from "@octant/client-runtime";
import type { GuestHubState } from "./hubGuestFlow";
import type { PhoneUnlockKey } from "./ownerUnlockKey";

/** An owner client for each computer on the hub, or none when this phone is not an owner or holds no unlock key. */
export async function ownerSpokesOf(input: {
  readonly state: GuestHubState;
  readonly deviceKeyStore: RemoteDeviceKeyStore;
  readonly transport: PinnedListenerTransportPort;
  readonly unlockKey: PhoneUnlockKey;
}): Promise<ReadonlyArray<OwnerSpoke>> {
  if (input.state.owner !== true) return [];
  const unlock = await input.unlockKey.signer();
  if (unlock === undefined) return [];
  const keyPair = await input.deviceKeyStore.get(input.state.record.deviceKeyId);
  if (keyPair === undefined) return [];
  const identity = await createGuestSigner({
    memberId: input.state.record.selfMemberId,
    keyPair,
  });
  return guestSpokeTargets(input.state.record)
    .filter((target) => target.role === "spoke")
    .map((target) => ({
      memberId: target.memberId,
      name: target.name,
      client: createOwnerClient({ target, identity, unlock, transport: input.transport }),
    }));
}
