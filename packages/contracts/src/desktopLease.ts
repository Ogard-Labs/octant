import { Schema } from "effect";
import { EventActor, UtcTimestamp } from "./events";

/**
 * Thread-leased disposable desktops: the recipe a Project owns, the lease a
 * thread holds, and the journal events that record every lease transition.
 * The rules these schemas carry live in docs/design/disposable-desktops.md.
 */

const strict = { parseOptions: { onExcessProperty: "error" as const } };
const text = (max: number) => Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(max));

export const DesktopLeaseId = Schema.UUID.pipe(Schema.brand("DesktopLeaseId"));
export type DesktopLeaseId = typeof DesktopLeaseId.Type;

/**
 * The host identity a driver tags each desktop with, so restart reconciliation
 * reaps only this host's desktops when two hosts share one provider account.
 */
export const DesktopHostTag = Schema.UUID.pipe(Schema.brand("DesktopHostTag"));
export type DesktopHostTag = typeof DesktopHostTag.Type;

/** A desktop provider contribution's stable identity, such as `host-local`. */
export const DesktopProviderId = Schema.String.pipe(
  Schema.pattern(/^[a-z0-9][a-z0-9.-]{0,127}$/),
  Schema.brand("DesktopProviderId"),
);
export type DesktopProviderId = typeof DesktopProviderId.Type;

/** A reference into the host credential store. The material never appears here. */
export const DesktopCredentialRef = Schema.UUID.pipe(Schema.brand("DesktopCredentialRef"));
export type DesktopCredentialRef = typeof DesktopCredentialRef.Type;

/** Chat never leases: a Chat Project has no root to send an artifact from. */
export const DesktopLeaseMode = Schema.Literal("work", "code");
export type DesktopLeaseMode = typeof DesktopLeaseMode.Type;

export const DesktopLeaseOwner = Schema.Struct({
  mode: DesktopLeaseMode,
  threadId: Schema.UUID,
}).annotations(strict);
export type DesktopLeaseOwner = typeof DesktopLeaseOwner.Type;

/** Where a desktop runs. The host-wide cap counts only host-local leases. */
export const DesktopProviderLocality = Schema.Literal("host-local", "cloud");
export type DesktopProviderLocality = typeof DesktopProviderLocality.Type;

export const DesktopNetworkPosture = Schema.Literal("none", "allow");
export type DesktopNetworkPosture = typeof DesktopNetworkPosture.Type;

/** No lease, extended or not, outlives this many minutes from acquisition. */
export const DESKTOP_LEASE_MAXIMUM_MINUTES = 240;

const leaseMinutes = Schema.Int.pipe(Schema.between(1, DESKTOP_LEASE_MAXIMUM_MINUTES));

/**
 * A Project's one desktop recipe. A person configures it; an agent cannot
 * create or edit it.
 */
export const DesktopRecipe = Schema.Struct({
  providerId: DesktopProviderId,
  /** The cloud provider's image or template; a host-local provider ignores it. */
  image: Schema.optional(text(256)),
  screen: Schema.Struct({
    width: Schema.Int.pipe(Schema.between(320, 7_680)),
    height: Schema.Int.pipe(Schema.between(240, 4_320)),
  }).annotations(strict),
  credentialRef: Schema.optional(DesktopCredentialRef),
  network: DesktopNetworkPosture,
  leaseMinutes,
  maximumLeaseMinutes: leaseMinutes,
  idleMinutes: leaseMinutes,
})
  .annotations(strict)
  .pipe(
    Schema.filter(
      (recipe) =>
        recipe.leaseMinutes <= recipe.maximumLeaseMinutes ||
        "A lease cannot start longer than the recipe maximum.",
    ),
  );
export type DesktopRecipe = typeof DesktopRecipe.Type;

/** A provider computer use could lease from on this host now. */
export const LeasableDesktopProvider = Schema.Struct({
  providerId: DesktopProviderId,
  displayName: text(128),
  locality: DesktopProviderLocality,
  billed: Schema.Boolean,
}).annotations(strict);
export type LeasableDesktopProvider = typeof LeasableDesktopProvider.Type;

/**
 * `released` is written only after the provider confirms the desktop is gone.
 * `release-failed` means it may still be running or billing; the host retries.
 */
export const DesktopLeaseState = Schema.Literal(
  "requested",
  "provisioning",
  "ready",
  "releasing",
  "released",
  "release-failed",
  "refused",
  "failed",
);
export type DesktopLeaseState = typeof DesktopLeaseState.Type;

export const DesktopLeaseEndReason = Schema.Literal(
  "released",
  "expired",
  "idle",
  "thread-ended",
  "recipe-removed",
  "provider-disabled",
  "computer-use-off",
  "host-restart",
);
export type DesktopLeaseEndReason = typeof DesktopLeaseEndReason.Type;

export const DesktopLeaseRefusalReason = Schema.Literal(
  "no-provider-configured",
  "provider-disabled",
  "provider-unavailable",
  "not-leasable-mode",
  "thread-not-active",
  "not-permitted",
  "computer-use-off",
  "plan-mode",
  "declined",
  "lease-limit",
  "release-pending",
  "leased-by-another-thread",
  "lease-ended",
  "agent-cannot-extend",
  "beyond-maximum",
  "extension-unconfirmed",
);
export type DesktopLeaseRefusalReason = typeof DesktopLeaseRefusalReason.Type;

export const DesktopLeaseRefusal = Schema.Struct({
  status: Schema.Literal("refused"),
  reason: DesktopLeaseRefusalReason,
}).annotations(strict);
export type DesktopLeaseRefusal = typeof DesktopLeaseRefusal.Type;

/** The current state of one lease, rebuilt from its journal events. */
export const DesktopLease = Schema.Struct({
  leaseId: DesktopLeaseId,
  owner: DesktopLeaseOwner,
  providerId: DesktopProviderId,
  locality: DesktopProviderLocality,
  billed: Schema.Boolean,
  credentialRef: Schema.optional(DesktopCredentialRef),
  state: DesktopLeaseState,
  requestedAt: UtcTimestamp,
  expiresAt: UtcTimestamp,
  maximumExpiresAt: UtcTimestamp,
  idleMinutes: leaseMinutes,
  endReason: Schema.optional(DesktopLeaseEndReason),
  updatedAt: UtcTimestamp,
}).annotations(strict);
export type DesktopLease = typeof DesktopLease.Type;

export const DESKTOP_LEASE_AGGREGATE_TYPE = "desktop-lease";
export const DESKTOP_LEASE_EVENT_NAMES = {
  requested: "desktop.lease-requested@1",
  transitioned: "desktop.lease-transitioned@1",
  extended: "desktop.lease-extended@1",
  artifactSent: "desktop.artifact-sent@1",
  operated: "desktop.operated@1",
} as const;

/**
 * Journaled before any provider call, with a host-minted id the driver tags
 * the desktop with. It records the credential reference, never the material,
 * so teardown can still find the key after the recipe is removed.
 */
export const DesktopLeaseRequested = Schema.Struct({
  leaseId: DesktopLeaseId,
  owner: DesktopLeaseOwner,
  providerId: DesktopProviderId,
  locality: DesktopProviderLocality,
  billed: Schema.Boolean,
  hostTag: DesktopHostTag,
  credentialRef: Schema.optional(DesktopCredentialRef),
  network: DesktopNetworkPosture,
  expiresAt: UtcTimestamp,
  maximumExpiresAt: UtcTimestamp,
  idleMinutes: leaseMinutes,
}).annotations(strict);
export type DesktopLeaseRequested = typeof DesktopLeaseRequested.Type;

/**
 * One lease transition. Teardown runs as `system`, so `requestedBy` names the
 * person or agent who asked for a release when someone did.
 */
export const DesktopLeaseTransitioned = Schema.Struct({
  leaseId: DesktopLeaseId,
  owner: DesktopLeaseOwner,
  providerId: DesktopProviderId,
  from: DesktopLeaseState,
  to: DesktopLeaseState,
  endReason: Schema.optional(DesktopLeaseEndReason),
  requestedBy: Schema.optional(EventActor),
  detail: Schema.optional(text(512)),
}).annotations(strict);
export type DesktopLeaseTransitioned = typeof DesktopLeaseTransitioned.Type;

/** Written only after the driver confirmed the provider-side expiry moved. */
export const DesktopLeaseExtended = Schema.Struct({
  leaseId: DesktopLeaseId,
  owner: DesktopLeaseOwner,
  providerId: DesktopProviderId,
  previousExpiresAt: UtcTimestamp,
  expiresAt: UtcTimestamp,
}).annotations(strict);
export type DesktopLeaseExtended = typeof DesktopLeaseExtended.Type;

/**
 * The largest file one transfer moves. The host holds the bytes it hashed
 * from the read through the person's answer to delivery, so what lands is
 * exactly what was shown; the bound keeps that in memory.
 */
export const DESKTOP_ARTIFACT_MAXIMUM_BYTES = 128 * 1024 * 1024;

/** Why the host would not read a file for a transfer. Authority refusals stay the lease's own. */
export const DesktopArtifactRefusalReason = Schema.Literal(
  "no-root",
  "path-invalid",
  "path-absolute",
  "path-escapes-root",
  "path-in-git",
  "path-symlink",
  "not-found",
  "not-a-file",
  "too-large",
  "changed-while-read",
  "path-unverifiable",
  "transfer-in-progress",
);
export type DesktopArtifactRefusalReason = typeof DesktopArtifactRefusalReason.Type;

export const DesktopArtifactRefusal = Schema.Struct({
  status: Schema.Literal("refused"),
  reason: DesktopArtifactRefusalReason,
}).annotations(strict);
export type DesktopArtifactRefusal = typeof DesktopArtifactRefusal.Type;

/** One file name: no separator, no NUL, not `.` or `..`. */
export const DesktopArtifactName = Schema.String.pipe(
  Schema.minLength(1),
  Schema.maxLength(255),
  Schema.filter(
    (name) =>
      (!name.includes("/") && !name.includes("\0") && name !== "." && name !== "..") ||
      "An artifact name is one file name.",
  ),
);

/**
 * Journaled before the bytes are handed to the driver, so a transfer that
 * fails or is cut off midway is still on record. The contents never are.
 */
export const DesktopArtifactSent = Schema.Struct({
  leaseId: DesktopLeaseId,
  owner: DesktopLeaseOwner,
  providerId: DesktopProviderId,
  /** Relative to the thread's checkout (Work: its Project root), `/`-separated. */
  path: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(4_096)),
  /** The base name the file lands under in the desktop's inbox. */
  name: DesktopArtifactName,
  size: Schema.Int.pipe(Schema.between(0, DESKTOP_ARTIFACT_MAXIMUM_BYTES)),
  sha256: Schema.String.pipe(Schema.pattern(/^[0-9a-f]{64}$/)),
}).annotations(strict);
export type DesktopArtifactSent = typeof DesktopArtifactSent.Type;

/** An input that changes what a desktop shows. Reading its screen is not one. */
export const DesktopLeaseOperation = Schema.Literal("launch", "click", "type", "press", "scroll");
export type DesktopLeaseOperation = typeof DesktopLeaseOperation.Type;

/**
 * One input an operator sent a desktop, journaled before the driver gets it
 * with the operator as actor, so the journal says whether the agent or a
 * person acted. It names the app a launch started and never the text typed
 * or the key pressed.
 */
export const DesktopLeaseOperated = Schema.Struct({
  leaseId: DesktopLeaseId,
  owner: DesktopLeaseOwner,
  providerId: DesktopProviderId,
  operation: DesktopLeaseOperation,
  appId: Schema.optional(text(256)),
}).annotations(strict);
export type DesktopLeaseOperated = typeof DesktopLeaseOperated.Type;

/**
 * A send's Computer use destination when it is not this Mac: one of the
 * sending thread's own leases. The host binds the turn's tool to it at
 * admission and never chooses between two.
 */
export const ComputerUseDestinationSelection = Schema.Struct({
  kind: Schema.Literal("desktop-lease"),
  leaseId: DesktopLeaseId,
}).annotations(strict);
export type ComputerUseDestinationSelection = typeof ComputerUseDestinationSelection.Type;

const screenCoordinate = Schema.Number.pipe(Schema.finite(), Schema.nonNegative());

/** Input for a desktop's screen, from a person in a Desktop tab or the host. */
export const DesktopInputEvent = Schema.Union(
  Schema.Struct({
    kind: Schema.Literal("pointer"),
    action: Schema.Literal("move", "down", "up"),
    button: Schema.optional(Schema.Literal("left", "middle", "right")),
    x: screenCoordinate,
    y: screenCoordinate,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("key"),
    action: Schema.Literal("down", "up"),
    key: text(64),
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("text"),
    text: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(4_096)),
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("scroll"),
    x: screenCoordinate,
    y: screenCoordinate,
    deltaX: Schema.Int.pipe(Schema.between(-10_000, 10_000)),
    deltaY: Schema.Int.pipe(Schema.between(-10_000, 10_000)),
  }).annotations(strict),
);
export type DesktopInputEvent = typeof DesktopInputEvent.Type;

export const decodeDesktopLeaseId = Schema.decodeUnknownSync(DesktopLeaseId);
export const decodeDesktopHostTag = Schema.decodeUnknownSync(DesktopHostTag);
export const decodeDesktopProviderId = Schema.decodeUnknownSync(DesktopProviderId);
export const decodeDesktopRecipe = Schema.decodeUnknownSync(DesktopRecipe);
export const decodeDesktopLease = Schema.decodeUnknownSync(DesktopLease);
export const decodeDesktopLeaseRequested = Schema.decodeUnknownSync(DesktopLeaseRequested);
export const decodeDesktopLeaseTransitioned = Schema.decodeUnknownSync(DesktopLeaseTransitioned);
export const decodeDesktopLeaseExtended = Schema.decodeUnknownSync(DesktopLeaseExtended);
export const decodeDesktopArtifactSent = Schema.decodeUnknownSync(DesktopArtifactSent);
export const decodeDesktopInputEvent = Schema.decodeUnknownSync(DesktopInputEvent);
export const decodeDesktopLeaseOperated = Schema.decodeUnknownSync(DesktopLeaseOperated);
export const decodeComputerUseDestinationSelection = Schema.decodeUnknownSync(
  ComputerUseDestinationSelection,
);
