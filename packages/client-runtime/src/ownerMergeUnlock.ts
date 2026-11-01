// A paired phone or web client's merge on a host that asks for an owner unlock
// first. The client sends the merge as before; a host whose switch is on
// answers `owner-unlock-required` with its own hub member id and merges
// nothing. If this device is an owner of that host, the person unlocks once,
// the owner route issues a challenge for the merge route's own path and the
// exact same body, and the merge is sent again with the proof. A client never
// learns or keeps the switch's state, so a host with the switch off costs it
// nothing.

import type { CodeOwnerMergeUnlockRefusal } from "@octant/contracts";
import { describeOwnerRefusal, type OwnerUnlockProofResult } from "./hubOwnerClient";

/** Signs the unlock for one merge on the host with this hub member id, or says why it cannot. */
export type OwnerMergeUnlock = (input: {
  readonly hostMemberId: string;
  readonly path: string;
  readonly body: string;
}) => Promise<OwnerUnlockProofResult | { readonly status: "no-owner-device" }>;

/** Nothing merged: this device could not give the unlock the host asked for. */
export interface OwnerUnlockNotGiven {
  readonly status: "owner-unlock-not-given";
  readonly reason: "cancelled" | "unavailable" | "unreachable" | "no-owner-device" | "refused";
  /** The owner route's refusal, when it refused the challenge. */
  readonly kind?: string;
}

/**
 * Sends one merge, and once more with an owner unlock when the host asks for
 * one and this device can give it. `send` must send `body` exactly, both
 * times: the unlock is bound to its hash.
 */
export async function sendWithOwnerUnlock<T extends { readonly status: string }>(input: {
  readonly path: string;
  readonly body: string;
  readonly send: (proof: string | undefined) => Promise<T>;
  readonly unlock: OwnerMergeUnlock | undefined;
}): Promise<T | OwnerUnlockNotGiven> {
  const first = await input.send(undefined);
  if (!isOwnerUnlockRefusal(first)) return first;
  // Only a merge sent without an unlock is worth unlocking for; any other
  // reason is the host's verdict on an unlock, or it has no owner to ask.
  if (first.reason !== "missing" || first.hostMemberId === undefined) return first;
  if (input.unlock === undefined)
    return { status: "owner-unlock-not-given", reason: "no-owner-device" };
  const proved = await input.unlock({
    hostMemberId: String(first.hostMemberId),
    path: input.path,
    body: input.body,
  });
  switch (proved.status) {
    case "signed":
      return input.send(proved.proof);
    case "no-owner-device":
    case "unreachable":
      return { status: "owner-unlock-not-given", reason: proved.status };
    case "not-unlocked":
      return { status: "owner-unlock-not-given", reason: proved.reason };
    case "refused":
      return { status: "owner-unlock-not-given", reason: "refused", kind: proved.kind };
  }
}

function isOwnerUnlockRefusal(value: {
  readonly status: string;
}): value is CodeOwnerMergeUnlockRefusal {
  return value.status === "owner-unlock-required";
}

const REASON_COPY: Readonly<Record<CodeOwnerMergeUnlockRefusal["reason"], string>> = {
  missing:
    "This computer asks for a fresh unlock on one of your owner devices before a phone or browser merges.",
  invalid: "The unlock could not be read. Unlock again.",
  "no-owner-list":
    "This computer asks for an owner unlock before a phone or browser merges, but it has no owner devices. Merge in its own window, or turn that setting off there.",
  "not-an-owner": "This computer does not list this device as an owner.",
  "owners-not-honored": "This computer does not let owner devices act. Its person can change that.",
  "device-revoked": "This computer revoked this device.",
  "hub-principal": "The hub cannot act as an owner.",
  "no-such-challenge": "That unlock was already used or never issued. Unlock again for this merge.",
  expired: "The unlock ran out after 60 seconds. Unlock again.",
  "wrong-owner": "That unlock was issued to a different device. Unlock again.",
  "action-mismatch": "That unlock was for a different merge. Unlock again.",
  "signature-invalid":
    "The unlock did not check out against the key this computer recorded for you.",
  "user-verification-missing": "The passkey did not confirm that you were present. Try again.",
};

const NOT_GIVEN_COPY: Readonly<Record<Exclude<OwnerUnlockNotGiven["reason"], "refused">, string>> =
  {
    cancelled: "You cancelled the unlock.",
    unavailable: "This device could not ask you to unlock.",
    unreachable: "This device could not reach that computer to ask for the unlock.",
    "no-owner-device":
      "This computer asks for a fresh unlock on one of your owner devices before a phone or browser merges, and this device is not one of its owners. Merge from an owner device or in the computer's own window.",
  };

/** Why nothing merged, as plain sentences the person can act on. */
export function ownerMergeUnlockCopy(
  outcome: CodeOwnerMergeUnlockRefusal | OwnerUnlockNotGiven,
): string {
  const why =
    outcome.status === "owner-unlock-required"
      ? REASON_COPY[outcome.reason]
      : outcome.reason === "refused"
        ? describeOwnerRefusal(outcome.kind ?? "refused")
        : NOT_GIVEN_COPY[outcome.reason];
  return `${why} Nothing merged.`;
}
