// What a host remembers about hub membership: the hub's roster and members
// when it acts as hub, and the hub link, grant, and roster when it is a
// spoke. The journal records every change with its principal; this file holds
// the current state, in the Octant data folder where only the person's account
// reads it, beside the roster signing key. A file that cannot be read back
// exactly is treated as no state, so the host is neither hub nor spoke.

import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  HubGrant,
  HubMemberId,
  NewMemberAlert,
  PeerGrant,
  SignedHubRoster,
} from "@octant/contracts";
import { Schema } from "effect";

const SUBDIR = "hub";
const FILE = "hub-state.json";
const strict = { parseOptions: { onExcessProperty: "error" as const } };
const digest = Schema.String.pipe(Schema.pattern(/^[0-9a-f]{64}$/));
const key = Schema.NonEmptyTrimmedString.pipe(
  Schema.maxLength(512),
  Schema.pattern(/^[A-Za-z0-9_-]+$/),
);

/** What the hub keeps for a member beyond its roster entry. */
export const HubMemberRecord = Schema.Struct({
  memberId: HubMemberId,
  identityPublicKey: key,
  deviceId: Schema.UUID,
  /** Absent for a guest, which runs no listener the hub could reach. */
  listenerOrigin: Schema.optional(Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(300))),
}).annotations(strict);
export type HubMemberRecord = typeof HubMemberRecord.Type;

/** A join code the hub made and has not yet seen used. */
export const HubJoinTicketRecord = Schema.Struct({
  ticketId: Schema.UUID,
  owner: Schema.Boolean,
}).annotations(strict);
export type HubJoinTicketRecord = typeof HubJoinTicketRecord.Type;

/**
 * One entry of a host's own owner list with what the host needs to check the
 * device: its name as the roster showed it when it was added, and the unlock
 * public key. The identity key is not kept; the device presents it with each
 * request and the host compares its fingerprint.
 */
export const HostOwnerRecord = Schema.Struct({
  memberId: HubMemberId,
  name: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(128)),
  identityKeyFingerprint: digest,
  unlockKeyFingerprint: digest,
  unlockPublicKey: key,
}).annotations(strict);
export type HostOwnerRecord = typeof HostOwnerRecord.Type;

export const HubSideState = Schema.Struct({
  enabled: Schema.Boolean,
  roster: Schema.optional(SignedHubRoster),
  members: Schema.Array(HubMemberRecord),
  joinTickets: Schema.Array(HubJoinTicketRecord),
  /** The hub's own owner list. A roster's owner mark never adds to it. */
  owners: Schema.optional(Schema.Array(HostOwnerRecord)),
}).annotations(strict);
export type HubSideState = typeof HubSideState.Type;

export const GuestDeviceRecord = Schema.Struct({
  memberId: HubMemberId,
  deviceId: Schema.UUID,
}).annotations(strict);
export type GuestDeviceRecord = typeof GuestDeviceRecord.Type;

/** The hub as a spoke knows it, and what that spoke lets it do. */
export const HubLinkState = Schema.Struct({
  selfMemberId: HubMemberId,
  hubMemberId: HubMemberId,
  hubName: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(128)),
  hubOrigin: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(300)),
  hubListenerPin: digest,
  hubIdentityPublicKey: key,
  rosterSigningPublicKey: key,
  grant: HubGrant,
  roster: SignedHubRoster,
  /** What this spoke lets other members do to it. A newer roster ends the grants of a member it drops. */
  peerGrants: Schema.Array(PeerGrant),
  /** The paired devices this spoke made for guests it accepted; a dropped guest's device is revoked. */
  guestDevices: Schema.optional(Schema.Array(GuestDeviceRecord)),
  /** Set once a newer roster no longer lists this spoke: the hub principal is revoked. */
  removed: Schema.optional(Schema.Literal(true)),
  /** This spoke's own owner list; it is dropped with the rest of the link when the spoke leaves. */
  owners: Schema.optional(Schema.Array(HostOwnerRecord)),
  /** Hold a new member status-only until a window or an owner's signed unlock confirms it. Off by default. */
  confirmNewMembers: Schema.optional(Schema.Literal(true)),
  /** New members a roster added, which this spoke's windows and owner devices can read and dismiss. */
  alerts: Schema.optional(Schema.Array(NewMemberAlert)),
  /** Members a person removed from an alert here: a later roster still lists them, and this spoke does not accept them again. */
  rejectedMemberIds: Schema.optional(Schema.Array(HubMemberId)),
}).annotations(strict);
export type HubLinkState = typeof HubLinkState.Type;

export const HubState = Schema.Struct({
  hub: Schema.optional(HubSideState),
  link: Schema.optional(HubLinkState),
}).annotations(strict);
export type HubState = typeof HubState.Type;

const decodeState = Schema.decodeUnknownSync(HubState);

export interface HubStatePort {
  readonly load: () => HubState;
  readonly save: (state: HubState) => void;
}

export function createHubStateStore(dataDirectory: string): HubStatePort {
  const directory = join(dataDirectory, SUBDIR);
  const path = join(directory, FILE);
  return {
    load: () => {
      try {
        return decodeState(JSON.parse(readFileSync(path, "utf8")));
      } catch {
        return {};
      }
    },
    save: (state) => {
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      chmodSync(directory, 0o700);
      const staging = `${path}.${process.pid}.tmp`;
      writeFileSync(staging, JSON.stringify(Schema.encodeSync(HubState)(state)), { mode: 0o600 });
      // writeFileSync applies the mode only when it creates the file, so a
      // staging file left behind by a crashed save is narrowed here too.
      chmodSync(staging, 0o600);
      renameSync(staging, path);
    },
  };
}
