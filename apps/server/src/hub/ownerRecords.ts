// The owner list both roles of a host keep: who may use a window's powers on
// it after a fresh unlock. Adding to it is a person's act at this host, so
// these functions only build the next list; the callers decide who may ask.

import { createPublicKey } from "node:crypto";
import type {
  HostOwnerEntry,
  HubMemberId,
  HubRoster,
  OwnerCandidate,
  OwnerListEntry,
} from "@octant/contracts";
import { publicKeyFingerprint } from "./hubCrypto";
import type { HostOwnerRecord } from "./hubStateStore";

/** The result of changing a host's owner list; a refusal names the member it concerned when it has one. */
export type OwnerChange =
  | { readonly status: "changed"; readonly owners: ReadonlyArray<OwnerListEntry> }
  | {
      readonly status: "refused";
      readonly kind:
        | Extract<OwnerAddition, { readonly status: "refused" }>["kind"]
        | "hub-role-off"
        | "not-a-spoke"
        | "hub-revoked"
        | "not-an-owner";
      readonly memberId?: string;
    };

export type OwnerAddition =
  | { readonly status: "added"; readonly owners: ReadonlyArray<HostOwnerRecord> }
  | {
      readonly status: "refused";
      readonly kind:
        | "not-in-roster"
        | "cannot-own-the-hub"
        | "cannot-own-itself"
        | "identity-mismatch"
        | "unlock-key-invalid"
        | "already-owner";
      readonly memberId: string;
    };

/** Whether `publicKey` is a P-256 SubjectPublicKeyInfo, the one unlock key shape a host verifies. */
export function isUnlockPublicKey(publicKey: string): boolean {
  try {
    const key = createPublicKey({
      key: Buffer.from(publicKey, "base64url"),
      format: "der",
      type: "spki",
    });
    return key.asymmetricKeyType === "ec" && key.asymmetricKeyDetails?.namedCurve === "prime256v1";
  } catch {
    return false;
  }
}

/**
 * The owner list with `candidates` added. Each must be in the held roster, not
 * the hub or a standby, not this host, and carry the identity key fingerprint
 * the roster lists for it: the person (or the owner who signed) confirmed that
 * fingerprint, and a roster that lists another one is a different device.
 */
export function addOwnerRecords(input: {
  readonly roster: HubRoster;
  readonly selfMemberId: string;
  readonly owners: ReadonlyArray<HostOwnerRecord>;
  readonly candidates: ReadonlyArray<
    Omit<OwnerCandidate, "identityKeyFingerprint"> & {
      readonly identityKeyFingerprint?: string;
    }
  >;
}): OwnerAddition {
  const next: HostOwnerRecord[] = [...input.owners];
  for (const candidate of input.candidates) {
    const memberId = String(candidate.memberId);
    const listed = input.roster.members.find((member) => String(member.memberId) === memberId);
    const refuse = (
      kind: Extract<OwnerAddition, { status: "refused" }>["kind"],
    ): OwnerAddition => ({
      status: "refused",
      kind,
      memberId,
    });
    if (listed === undefined) return refuse("not-in-roster");
    if (listed.role === "hub" || listed.role === "standby-hub") return refuse("cannot-own-the-hub");
    if (memberId === input.selfMemberId) return refuse("cannot-own-itself");
    if (
      candidate.identityKeyFingerprint !== undefined &&
      candidate.identityKeyFingerprint !== listed.identityKeyFingerprint
    ) {
      return refuse("identity-mismatch");
    }
    if (!isUnlockPublicKey(candidate.unlockPublicKey)) return refuse("unlock-key-invalid");
    if (next.some((owner) => String(owner.memberId) === memberId)) return refuse("already-owner");
    next.push({
      memberId: listed.memberId,
      name: listed.name,
      identityKeyFingerprint: listed.identityKeyFingerprint,
      unlockKeyFingerprint: publicKeyFingerprint(candidate.unlockPublicKey),
      unlockPublicKey: candidate.unlockPublicKey,
    });
  }
  return { status: "added", owners: next };
}

export function ownerEntries(
  owners: ReadonlyArray<HostOwnerRecord>,
): ReadonlyArray<HostOwnerEntry> {
  return owners.map((owner) => ({
    memberId: owner.memberId,
    identityKeyFingerprint: owner.identityKeyFingerprint,
    unlockKeyFingerprint: owner.unlockKeyFingerprint,
  }));
}

export function ownerListView(
  owners: ReadonlyArray<HostOwnerRecord>,
): ReadonlyArray<OwnerListEntry> {
  return owners.map((owner) => ({
    memberId: owner.memberId,
    name: owner.name,
    identityKeyFingerprint: owner.identityKeyFingerprint,
    unlockKeyFingerprint: owner.unlockKeyFingerprint,
  }));
}

export function withoutOwner(
  owners: ReadonlyArray<HostOwnerRecord>,
  memberId: HubMemberId | string,
): ReadonlyArray<HostOwnerRecord> {
  return owners.filter((owner) => String(owner.memberId) !== String(memberId));
}
