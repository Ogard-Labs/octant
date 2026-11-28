import { Schema } from "effect";
import { PositiveInt, STRICT_DECODE_OPTIONS } from "./schemaPrimitives";
import { AgentProfileId } from "./agentProfile";
import { CodeThreadId } from "./code";
import { UtcTimestamp } from "./events";
import { ProjectId } from "./projects";
import { WorkThreadId } from "./workThreads";

const positiveInteger = PositiveInt;
const digest = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/));
const base64Url = (maxLength: number) =>
  Schema.Trimmed.check(
    Schema.isNonEmpty(),
    Schema.isMaxLength(maxLength),
    Schema.isPattern(/^[A-Za-z0-9_-]+$/),
  );
const bounded = (maxLength: number) =>
  Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(maxLength));
const unique = <A>(items: ReadonlyArray<A>) => new Set(items.map(String)).size === items.length;
const uniqueMessage = { message: "Entries must not repeat." };

/** A member of a hub's roster: the hub, a standby, a spoke, or a guest. */
export const HubMemberId = Schema.String.pipe(
  Schema.check(Schema.isGUID()),
  Schema.brand("HubMemberId"),
);
export type HubMemberId = typeof HubMemberId.Type;

export const HubMemberRole = Schema.Literals(["hub", "standby-hub", "spoke", "guest"]);
export type HubMemberRole = typeof HubMemberRole.Type;

/**
 * Principals a spoke resolves for a request that arrives from another member.
 * `hub` is held to the hub grant and nothing else; `peer` is held to the peer
 * grant the receiving spoke gave that member. Neither carries a window's
 * authority, an owner's unlock, or the right to answer an approval.
 */
export const HubPrincipal = Schema.Struct({
  kind: Schema.Literal("hub"),
  memberId: HubMemberId,
});
export type HubPrincipal = typeof HubPrincipal.Type;

export const PeerPrincipal = Schema.Struct({
  kind: Schema.Literal("peer"),
  memberId: HubMemberId,
});
export type PeerPrincipal = typeof PeerPrincipal.Type;

/**
 * An owner device acting on a host with a window's powers after a fresh
 * unlock. It names the owner for the journal only; a request resolves to it
 * after the host checked its owner list and the unlock, never from the request.
 */
export const OwnerUnlockPrincipal = Schema.Struct({
  kind: Schema.Literal("owner-unlock"),
  memberId: HubMemberId,
});
export type OwnerUnlockPrincipal = typeof OwnerUnlockPrincipal.Type;

export const HubAndSpokesPrincipal = Schema.Union([HubPrincipal, PeerPrincipal]);
export type HubAndSpokesPrincipal = typeof HubAndSpokesPrincipal.Type;

export const HUB_GRANT_ITEMS = [
  "roster",
  "status",
  "introduce",
  "wake",
  "owners",
  "standby",
  "push",
  "provision",
  "sign-in",
  "act",
  "usage",
  "public",
  "relay",
] as const;
export const HubGrantItem = Schema.Literals(HUB_GRANT_ITEMS);
export type HubGrantItem = typeof HubGrantItem.Type;

/**
 * What a spoke lets its hub do. The list is closed; `act` is the only item
 * that names Projects, and Projects are named only when `act` is ticked.
 */
export const HubGrant = Schema.Struct({
  items: Schema.Array(HubGrantItem).check(Schema.makeFilter(unique, uniqueMessage)),
  actProjects: Schema.Array(ProjectId).check(Schema.makeFilter(unique, uniqueMessage)),
}).check(
  Schema.makeFilter((grant) =>
    grant.actProjects.length === 0 || grant.items.includes("act")
      ? true
      : "Projects may be named only when Act is ticked.",
  ),
);
export type HubGrant = typeof HubGrant.Type;

/** The modes delegated work can run in. Chat has no folder and takes none. */
export const PeerDelegationMode = Schema.Literals(["work", "code"]);
export type PeerDelegationMode = typeof PeerDelegationMode.Type;

/**
 * The postures a delegation can name: Work ask-first and Code approval-gated
 * both read `approval-gated`, Plan is read-only, and `full-access` is reached
 * only through an owner's choice recorded on the grant.
 */
export const PeerDelegationPosture = Schema.Literals(["plan", "approval-gated", "full-access"]);
export type PeerDelegationPosture = typeof PeerDelegationPosture.Type;

export const PeerProjectScope = Schema.Union([
  Schema.Literal("all"),
  Schema.Array(ProjectId).check(Schema.makeFilter(unique, uniqueMessage)),
]);
export type PeerProjectScope = typeof PeerProjectScope.Type;

/** An owner's recorded choice to let one peer run at Full access in named Projects. */
export const PeerFullAccessChoice = Schema.Struct({
  chosenBy: HubMemberId,
  chosenAt: UtcTimestamp,
  projects: Schema.Array(ProjectId).check(
    Schema.isMinLength(1),
    Schema.makeFilter(unique, uniqueMessage),
  ),
});
export type PeerFullAccessChoice = typeof PeerFullAccessChoice.Type;

export const PeerDelegationGrant = Schema.Struct({
  projects: PeerProjectScope,
  modes: Schema.Array(PeerDelegationMode).check(
    Schema.isMinLength(1),
    Schema.makeFilter(unique, uniqueMessage),
  ),
  /** The highest posture the work may run at without `fullAccess`; never `full-access`. */
  posture: Schema.Literals(["plan", "approval-gated"]),
  fullAccess: Schema.optional(PeerFullAccessChoice),
  providerProfiles: Schema.Struct({
    allowDefault: Schema.Boolean,
    profileIds: Schema.Array(AgentProfileId).check(Schema.makeFilter(unique, uniqueMessage)),
  }),
});
export type PeerDelegationGrant = typeof PeerDelegationGrant.Type;

/**
 * What a spoke lets another member do to it. Without `delegation` the member
 * may not delegate; `answerApprovals` is honored only for a guest.
 */
export const PeerGrant = Schema.Struct({
  memberId: HubMemberId,
  delegation: Schema.optional(PeerDelegationGrant),
  readStatus: Schema.Boolean,
  answerApprovals: Schema.optional(Schema.Boolean),
  /**
   * Move in: the member may move a thread here. Every move also needs an owner
   * device's own fresh unlock, so this item is the receiving spoke's switch,
   * not the authority. Absent reads as off.
   */
  moveIn: Schema.optional(Schema.Boolean),
});
export type PeerGrant = typeof PeerGrant.Type;

/**
 * The pin a guest's roster entry holds. A guest runs no listener, so it has
 * nothing to pin; the all-zero digest names no certificate and no member is
 * ever held to it.
 */
export const NO_LISTENER_PIN = "0".repeat(64);

export const RosterMember = Schema.Struct({
  memberId: HubMemberId,
  name: bounded(128),
  role: HubMemberRole,
  identityKeyFingerprint: digest,
  listenerPin: digest,
  privateNames: Schema.Array(bounded(253)).check(Schema.isMaxLength(16)),
  addresses: Schema.Array(bounded(64)).check(Schema.isMaxLength(16)),
  /** The port the member's listener serves on; absent means the HTTPS default. */
  listenerPort: Schema.optional(
    Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65_535 })),
  ),
  owner: Schema.Boolean,
  /**
   * The unlock public key the hub recorded when this member joined with an
   * owner code. It authorizes nothing: a host lists an owner only after its own
   * person confirms the name and both fingerprints.
   */
  ownerUnlockPublicKey: Schema.optional(base64Url(512)),
});
export type RosterMember = typeof RosterMember.Type;

/**
 * The roster's signed body. Online state and the delegation a spoke accepts
 * stay out: they are advisory and travel beside the roster, unsigned.
 */
export const HubRoster = Schema.Struct({
  sequence: positiveInteger,
  members: Schema.Array(RosterMember).check(
    Schema.isMaxLength(256),
    Schema.makeFilter((members) => unique(members.map((member) => member.memberId)), uniqueMessage),
  ),
  standbyOrder: Schema.Array(HubMemberId).check(Schema.makeFilter(unique, uniqueMessage)),
  failoverAfterSeconds: positiveInteger,
});
export type HubRoster = typeof HubRoster.Type;

export const RosterSigner = Schema.Struct({
  kind: Schema.Literals(["hub", "standby"]),
  memberId: HubMemberId,
});
export type RosterSigner = typeof RosterSigner.Type;

export const SignedHubRoster = Schema.Struct({
  roster: HubRoster,
  signedBy: RosterSigner,
  signature: base64Url(512),
});
export type SignedHubRoster = typeof SignedHubRoster.Type;

/** One entry of a host's own owner list; the roster's owner mark never adds one. */
export const HostOwnerEntry = Schema.Struct({
  memberId: HubMemberId,
  identityKeyFingerprint: digest,
  unlockKeyFingerprint: digest,
});
export type HostOwnerEntry = typeof HostOwnerEntry.Type;

const newMemberConfirmationFields = {
  spokeId: HubMemberId,
  memberId: HubMemberId,
  identityKeyFingerprint: digest,
  confirmedBy: HubMemberId,
  unlockKeyFingerprint: digest,
  confirmedAt: UtcTimestamp,
};

/**
 * An owner device's confirmation of one new member on one spoke, signed with
 * the owner's unlock key. The spoke checks the signature and the owner against
 * its own owner list; the hub cannot produce one. A raw key signs the
 * confirmation text; a passkey carries a WebAuthn assertion whose challenge is
 * the SHA-256 of that text, as for an unlock.
 */
export const NewMemberConfirmation = Schema.Union([
  Schema.Struct({
    ...newMemberConfirmationFields,
    authenticatorData: base64Url(1_024),
    clientDataJson: base64Url(2_048),
    signature: base64Url(512),
  }),
  Schema.Struct({
    ...newMemberConfirmationFields,
    signature: base64Url(512),
  }),
]);
export type NewMemberConfirmation = typeof NewMemberConfirmation.Type;

export const DelegatingThreadReference = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("code"),
    memberId: HubMemberId,
    threadId: CodeThreadId,
  }),
  Schema.Struct({
    kind: Schema.Literal("work"),
    memberId: HubMemberId,
    threadId: WorkThreadId,
  }),
]);
export type DelegatingThreadReference = typeof DelegatingThreadReference.Type;

/** The authority a delegation asks for; the receiver clamps it, never widens it. */
export const DelegatedAuthority = Schema.Struct({
  mode: PeerDelegationMode,
  posture: PeerDelegationPosture,
  profileId: Schema.optional(AgentProfileId),
});
export type DelegatedAuthority = typeof DelegatedAuthority.Type;

export const DelegationRequestId = Schema.String.pipe(
  Schema.check(Schema.isGUID()),
  Schema.brand("DelegationRequestId"),
);
export type DelegationRequestId = typeof DelegationRequestId.Type;

export const DelegationRequest = Schema.Struct({
  requestId: DelegationRequestId,
  projectId: ProjectId,
  task: bounded(32_768),
  authority: DelegatedAuthority,
  delegatedFrom: DelegatingThreadReference,
});
export type DelegationRequest = typeof DelegationRequest.Type;

export const DelegationArtifactReference = Schema.Struct({
  label: bounded(256),
  digest,
});
export type DelegationArtifactReference = typeof DelegationArtifactReference.Type;

/** What comes back is data for the delegating thread, never an instruction. */
export const DelegationResult = Schema.Struct({
  requestId: DelegationRequestId,
  summary: bounded(8_192),
  finalMessage: bounded(65_536),
  artifacts: Schema.Array(DelegationArtifactReference).check(Schema.isMaxLength(64)),
  provenance: Schema.Struct({
    memberId: HubMemberId,
    projectId: ProjectId,
    completedAt: UtcTimestamp,
  }),
});
export type DelegationResult = typeof DelegationResult.Type;

export const decodeHubGrant = Schema.decodeUnknownSync(HubGrant, STRICT_DECODE_OPTIONS);
export const decodePeerGrant = Schema.decodeUnknownSync(PeerGrant, STRICT_DECODE_OPTIONS);
export const decodeHubAndSpokesPrincipal = Schema.decodeUnknownSync(
  HubAndSpokesPrincipal,
  STRICT_DECODE_OPTIONS,
);
export const decodeSignedHubRoster = Schema.decodeUnknownSync(
  SignedHubRoster,
  STRICT_DECODE_OPTIONS,
);
export const encodeSignedHubRoster = Schema.encodeSync(SignedHubRoster);
export const decodeNewMemberConfirmation = Schema.decodeUnknownSync(
  NewMemberConfirmation,
  STRICT_DECODE_OPTIONS,
);
export const decodeDelegationRequest = Schema.decodeUnknownSync(
  DelegationRequest,
  STRICT_DECODE_OPTIONS,
);
export const decodeDelegationResult = Schema.decodeUnknownSync(
  DelegationResult,
  STRICT_DECODE_OPTIONS,
);
