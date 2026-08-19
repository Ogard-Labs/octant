/**
 * Publishing to a target the person owns.
 *
 * Octant operates no deployment infrastructure and offers no target of its own.
 * Everything here describes a place the user already has and a single act of
 * putting bytes there: which target, which revision, which build, and whose
 * decision. Nothing here carries a secret — a target names a credential, and
 * the host resolves it at the moment of use.
 */

import { Schema } from "effect";
import { AggregateVersion, UtcTimestamp } from "./events";

const strict = { parseOptions: { onExcessProperty: "error" as const } };
const brandedUuid = <B extends string>(brand: B) => Schema.UUID.pipe(Schema.brand(brand));

export const ShipTargetId = brandedUuid("ShipTargetId");
export type ShipTargetId = typeof ShipTargetId.Type;

export const ShipReceiptId = brandedUuid("ShipReceiptId");
export type ShipReceiptId = typeof ShipReceiptId.Type;

/** A digest the host measured itself, never one a caller asserted. */
export const ArtifactDigest = Schema.String.pipe(
  Schema.maxLength(128),
  Schema.filter((value) => /^sha256:[0-9a-f]{64}$/.test(value)),
);

const GitRevision = Schema.String.pipe(Schema.filter((value) => /^[0-9a-f]{40}$/.test(value)));

/**
 * A name for a credential, never the credential.
 *
 * An integration holds one of these and can do nothing with it: the host
 * resolves it through the broker at the moment of use and keeps the value.
 */
export const CredentialReference = Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(256));
export type CredentialReference = typeof CredentialReference.Type;

/**
 * Where a ship puts things.
 *
 * One kind today: a branch on a Git remote the person already has. Bytes go
 * from this machine to that remote with nothing in between — there is no relay
 * to add and no Octant-hosted alternative to fall back to.
 */
export const ShipDestination = Schema.Struct({
  kind: Schema.Literal("git-branch"),
  /** A remote already configured on the checkout, by name. */
  remoteName: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(128)),
  branch: Schema.NonEmptyTrimmedString.pipe(
    Schema.maxLength(255),
    Schema.filter(
      (value) => !value.startsWith("-") && !value.includes("..") && !value.includes(" "),
    ),
  ),
  /**
   * The directory the build writes, relative to the checkout root.
   *
   * It is the evidence, not the payload: the host measures it to prove a build
   * happened at this revision, and what actually travels to the remote is the
   * reviewed revision itself.
   */
  artifactDirectory: Schema.NonEmptyTrimmedString.pipe(
    Schema.maxLength(512),
    Schema.filter(
      (value) =>
        !value.startsWith("/") &&
        !value.includes("..") &&
        !value.includes("\\") &&
        !value.split("/").includes(".git"),
    ),
  ),
}).annotations(strict);
export type ShipDestination = typeof ShipDestination.Type;

export const ShipTarget = Schema.Struct({
  id: ShipTargetId,
  /** The extension that contributed this target; core contributes none. */
  extensionId: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(128)),
  displayName: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(120)),
  destination: ShipDestination,
  /**
   * Installed, trusted, and enabled are separate decisions; this is the last of
   * them. An installed target reaches nothing on its own.
   */
  enabled: Schema.Boolean,
  credentialReference: Schema.optional(CredentialReference),
  version: AggregateVersion,
  updatedAt: UtcTimestamp,
}).annotations(strict);
export type ShipTarget = typeof ShipTarget.Type;

/** What the host is about to publish, stated before it asks. */
export const ShipPlan = Schema.Struct({
  targetId: ShipTargetId,
  targetName: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(120)),
  destination: ShipDestination,
  revision: GitRevision,
  artifactDigest: ArtifactDigest,
  /** The run this host watched produce the build. */
  producedByRunId: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(128)),
}).annotations(strict);
export type ShipPlan = typeof ShipPlan.Type;

export const ShipRefusalReason = Schema.Literal(
  "target-not-found",
  "target-not-enabled",
  "credential-unbound",
  "plan-mode",
  "checkout-dirty",
  "revision-not-reviewed",
  "artifact-unobserved",
  "artifact-digest-mismatch",
  "approval-required",
  "approval-not-per-act",
  "remote-unavailable",
  "publish-failed",
);
export type ShipRefusalReason = typeof ShipRefusalReason.Type;

/** What one publication did, kept so what left the machine is answerable. */
export const ShipReceipt = Schema.Struct({
  receiptId: ShipReceiptId,
  targetId: ShipTargetId,
  destination: ShipDestination,
  revision: GitRevision,
  artifactDigest: ArtifactDigest,
  outcome: Schema.Literal("published", "refused", "failed"),
  reason: Schema.optional(ShipRefusalReason),
  detail: Schema.optional(Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(512))),
  /** The approval this act rested on. Absent only when it never got that far. */
  approvalId: Schema.optional(Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(128))),
  observedAt: UtcTimestamp,
})
  .annotations(strict)
  // A publication that happened rested on an approval, and one that did not
  // says why. Neither is optional in practice, so neither is optional here.
  .pipe(
    Schema.filter(
      (receipt) =>
        (receipt.outcome === "published") === (receipt.approvalId !== undefined) &&
        (receipt.outcome === "published") === (receipt.reason === undefined),
    ),
  );
export type ShipReceipt = typeof ShipReceipt.Type;

export const ShipCommand = Schema.Union(
  Schema.Struct({
    kind: Schema.Literal("bind-ship-credential"),
    targetId: ShipTargetId,
    expectedVersion: AggregateVersion,
    credentialReference: CredentialReference,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("enable-ship-target"),
    targetId: ShipTargetId,
    expectedVersion: AggregateVersion,
    enabled: Schema.Boolean,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("plan-ship"),
    targetId: ShipTargetId,
    threadId: Schema.UUID,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("ship"),
    targetId: ShipTargetId,
    threadId: Schema.UUID,
    /** The approval a person just gave for this exact plan. */
    approvalId: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(128)),
    revision: GitRevision,
    artifactDigest: ArtifactDigest,
  }).annotations(strict),
);
export type ShipCommand = typeof ShipCommand.Type;

export const ShipResult = Schema.Union(
  Schema.Struct({
    kind: Schema.Literal("ship-targets"),
    targets: Schema.Array(ShipTarget),
  }).annotations(strict),
  Schema.Struct({ kind: Schema.Literal("ship-plan"), plan: ShipPlan }).annotations(strict),
  Schema.Struct({ kind: Schema.Literal("ship-receipt"), receipt: ShipReceipt }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("ship-refused"),
    reason: ShipRefusalReason,
    message: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(512)),
  }).annotations(strict),
);
export type ShipResult = typeof ShipResult.Type;

export const SHIP_AGGREGATE_TYPE = "ship-target";
export const SHIP_EVENT_NAMES = {
  targetChanged: "ship-target-changed@1",
  shipped: "ship-recorded@1",
} as const;

export const decodeShipTarget = Schema.decodeUnknownSync(ShipTarget);
export const decodeShipPlan = Schema.decodeUnknownSync(ShipPlan);
export const decodeShipReceipt = Schema.decodeUnknownSync(ShipReceipt);
export const decodeShipCommand = Schema.decodeUnknownSync(ShipCommand);
export const decodeShipResult = Schema.decodeUnknownSync(ShipResult);
