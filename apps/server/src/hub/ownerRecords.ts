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
        | "no-unlock-key-listed"
        | "unlock-key-mismatch"
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
 * and the unlock key fingerprint the roster entry lists: the person (or the
 * owner who signed) confirmed both, and a roster that lists others is a
 * different device. The unlock key is copied from that entry, never taken from
 * the request, and the entry alone adds nobody.
 */
export function addOwnerRecords(input: {
  readonly roster: HubRoster;
  readonly selfMemberId: string;
  readonly owners: ReadonlyArray<HostOwnerRecord>;
  readonly candidates: ReadonlyArray<OwnerCandidate>;
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
    if (candidate.identityKeyFingerprint !== listed.identityKeyFingerprint) {
      return refuse("identity-mismatch");
    }
    const listedKey = listed.ownerUnlockPublicKey;
    if (listedKey === undefined) return refuse("no-unlock-key-listed");
    if (!isUnlockPublicKey(listedKey)) return refuse("unlock-key-invalid");
    const listedKeyFingerprint = publicKeyFingerprint(listedKey);
    if (candidate.unlockKeyFingerprint !== listedKeyFingerprint) {
      return refuse("unlock-key-mismatch");
    }
    if (next.some((owner) => String(owner.memberId) === memberId)) return refuse("already-owner");
    next.push({
      memberId: listed.memberId,
      name: listed.name,
      identityKeyFingerprint: listed.identityKeyFingerprint,
      unlockKeyFingerprint: listedKeyFingerprint,
      unlockPublicKey: listedKey,
    });
  }
  return { status: "added", owners: next };
}

/** A roster member a host's person could confirm as an owner: it lists an unlock key and is not yet on the owner list. */
export interface OwnerCandidateView {
  readonly memberId: HubMemberId;
  readonly name: string;
  readonly identityKeyFingerprint: string;
  readonly unlockKeyFingerprint: string;
}

/** An owner this host lists whose roster entry now lists a different unlock key. The host keeps the key it confirmed. */
export interface OwnerKeyMismatch {
  readonly memberId: HubMemberId;
  readonly name: string;
  readonly heldUnlockKeyFingerprint: string;
  readonly rosterUnlockKeyFingerprint: string;
}

/**
 * What a held roster says about owners, for the person to read. Nothing here
 * changes the owner list: a listed key is only a candidate until the person
 * confirms it, and a changed key is shown, never applied.
 */
export function readRosterOwners(input: {
  readonly roster: HubRoster;
  readonly selfMemberId: string;
  readonly owners: ReadonlyArray<HostOwnerRecord>;
  readonly rejectedMemberIds?: ReadonlyArray<HubMemberId>;
}): {
  readonly candidates: ReadonlyArray<OwnerCandidateView>;
  readonly mismatches: ReadonlyArray<OwnerKeyMismatch>;
} {
  const candidates: OwnerCandidateView[] = [];
  const mismatches: OwnerKeyMismatch[] = [];
  for (const member of input.roster.members) {
    const key = member.ownerUnlockPublicKey;
    if (key === undefined || !isUnlockPublicKey(key)) continue;
    const memberId = String(member.memberId);
    const held = input.owners.find((owner) => String(owner.memberId) === memberId);
    const listedFingerprint = publicKeyFingerprint(key);
    if (held !== undefined) {
      if (held.unlockKeyFingerprint !== listedFingerprint) {
        mismatches.push({
          memberId: member.memberId,
          name: member.name,
          heldUnlockKeyFingerprint: held.unlockKeyFingerprint,
          rosterUnlockKeyFingerprint: listedFingerprint,
        });
      }
      continue;
    }
    if (
      member.role === "hub" ||
      member.role === "standby-hub" ||
      memberId === input.selfMemberId ||
      input.rejectedMemberIds?.some((id) => String(id) === memberId) === true
    ) {
      continue;
    }
    candidates.push({
      memberId: member.memberId,
      name: member.name,
      identityKeyFingerprint: member.identityKeyFingerprint,
      unlockKeyFingerprint: listedFingerprint,
    });
  }
  return { candidates, mismatches };
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
