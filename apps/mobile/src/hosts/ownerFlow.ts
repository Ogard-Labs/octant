// The phone as an owner device: it builds an owner client for each computer on
// the hub it joined with an owner code. Reading and acting on alerts is shared
// with the browser in @octant/client-runtime (ownerAlerts); confirming a move a
// window holds for the phone is in ownerThreadMove; the protocol is in
// hubOwnerClient, and the unlock key is in ownerUnlockKey.

import type { ThreadMovePhoneConfirmation } from "@octant/contracts";
import {
  confirmThreadMoveOnPhone,
  createGuestSigner,
  createOwnerClient,
  guestSpokeTargets,
  holdUnlockForOneAction,
  type OwnerActionResult,
  type OwnerMergeUnlock,
  type OwnerSpoke,
  type OwnerUnlockSigner,
  type PinnedListenerTransportPort,
  type RemoteDeviceKeyStore,
} from "@octant/client-runtime";
import type { GuestHubState, GuestHubStore } from "./hubGuestFlow";
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

/** A move a computer holds until this phone confirms it, with the computer that holds it. */
export interface PhoneHeldMove {
  readonly source: { readonly memberId: string; readonly name: string };
  readonly confirmation: ThreadMovePhoneConfirmation;
}

export interface PhoneThreadMoves {
  /** Every move the hub's spokes hold for an owner phone, and the computers that did not answer. */
  readonly read: () => Promise<{
    readonly moves: ReadonlyArray<PhoneHeldMove>;
    readonly unanswered: ReadonlyArray<string>;
  }>;
  /**
   * Confirms one held move: the destination issues the ticket after this
   * phone's own unlock there, then the source is handed the ticket id. The
   * person is asked for Face ID, Touch ID, or the passcode once for both.
   */
  readonly confirm: (move: PhoneHeldMove) => Promise<OwnerActionResult>;
}

/**
 * Moves a window holds for this phone to confirm, or undefined when this phone
 * is not an owner or holds no unlock key. Only a spoke moves a thread away; a
 * destination may be a spoke or the hub, and each checks this phone against
 * its own owner list.
 */
export async function phoneThreadMovesOf(input: {
  readonly state: GuestHubState;
  readonly deviceKeyStore: RemoteDeviceKeyStore;
  readonly transport: PinnedListenerTransportPort;
  readonly unlockKey: PhoneUnlockKey;
}): Promise<PhoneThreadMoves | undefined> {
  if (input.state.owner !== true) return undefined;
  const unlock = await input.unlockKey.signer();
  const keyPair = await input.deviceKeyStore.get(input.state.record.deviceKeyId);
  if (unlock === undefined || keyPair === undefined) return undefined;
  const identity = await createGuestSigner({
    memberId: input.state.record.selfMemberId,
    keyPair,
  });
  const targets = guestSpokeTargets(input.state.record);
  const clientFor = (target: (typeof targets)[number], signer: OwnerUnlockSigner) =>
    createOwnerClient({ target, identity, unlock: signer, transport: input.transport });
  return {
    read: async () => {
      const answers = await Promise.all(
        targets
          .filter((target) => target.role === "spoke")
          .map(async (target) => ({
            target,
            answer: await clientFor(target, unlock).moveConfirmations(),
          })),
      );
      return {
        moves: answers.flatMap(({ target, answer }) =>
          answer.status === "read"
            ? answer.confirmations.map((confirmation) => ({
                source: { memberId: target.memberId, name: target.name },
                confirmation,
              }))
            : [],
        ),
        unanswered: answers
          .filter(({ answer }) => answer.status === "unreachable")
          .map(({ target }) => target.name),
      };
    },
    confirm: async (move) => {
      const source = targets.find((target) => target.memberId === move.source.memberId);
      const destination = targets.find(
        (target) => target.memberId === String(move.confirmation.destinationMemberId),
      );
      if (source === undefined || destination === undefined) {
        return { status: "refused", kind: "not-an-owner" };
      }
      const held = holdUnlockForOneAction(unlock);
      try {
        return await confirmThreadMoveOnPhone({
          source: { memberId: source.memberId, ...clientFor(source, held.signer) },
          destination: clientFor(destination, held.signer),
          confirmation: move.confirmation,
        });
      } finally {
        held.release();
      }
    },
  };
}

/**
 * The unlock a paired host may ask this phone's merge for. The host names
 * itself by its hub member id; the phone answers only if it joined the hub as
 * an owner and that computer, the hub or a spoke, is on its roster. The person
 * is asked for Face ID, Touch ID, or the passcode once, for that merge alone.
 */
export function phoneOwnerMergeUnlock(input: {
  readonly guestHubStore: Pick<GuestHubStore, "load">;
  readonly deviceKeyStore: RemoteDeviceKeyStore;
  readonly transport: PinnedListenerTransportPort;
  readonly unlockKey: PhoneUnlockKey;
}): OwnerMergeUnlock {
  return async ({ hostMemberId, path, body }) => {
    const state = await input.guestHubStore.load();
    if (state?.owner !== true) return { status: "no-owner-device" };
    const target = guestSpokeTargets(state.record).find(
      (candidate) => candidate.memberId === hostMemberId,
    );
    const unlock = await input.unlockKey.signer();
    const keyPair = await input.deviceKeyStore.get(state.record.deviceKeyId);
    if (target === undefined || unlock === undefined || keyPair === undefined) {
      return { status: "no-owner-device" };
    }
    const identity = await createGuestSigner({ memberId: state.record.selfMemberId, keyPair });
    return createOwnerClient({ target, identity, unlock, transport: input.transport }).unlockMerge(
      path,
      body,
    );
  };
}
