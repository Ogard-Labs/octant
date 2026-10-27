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

/**
 * One place a provider that declares placements runs a desktop, such as this
 * machine or the person's own cloud account. The driver declares its
 * placements in code; a recipe names one, and the lease records it.
 */
export const DesktopPlacementId = Schema.String.pipe(
  Schema.pattern(/^[a-z0-9][a-z0-9.-]{0,63}$/),
  Schema.brand("DesktopPlacementId"),
);
export type DesktopPlacementId = typeof DesktopPlacementId.Type;

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
  /**
   * The provider's placement this recipe runs in: required for a provider
   * that declares placements, refused for one that declares none. The host
   * takes locality and billing from it.
   */
  placementId: Schema.optional(DesktopPlacementId),
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

/** One placement a provider offers a recipe, with where it runs and whether it bills. */
export const LeasableDesktopPlacement = Schema.Struct({
  placementId: DesktopPlacementId,
  displayName: text(128),
  locality: DesktopProviderLocality,
  billed: Schema.Boolean,
}).annotations(strict);
export type LeasableDesktopPlacement = typeof LeasableDesktopPlacement.Type;

/**
 * A provider computer use could lease from on this host now. A provider with
 * `placements` is leased only through a recipe that names one of them, on
 * that placement's locality and billing. `daemon` marks a provider run by a
 * local daemon that holds the person's own sign-in: its recipe names a
 * placement in place of a credential, and Octant stores no key for it.
 */
export const LeasableDesktopProvider = Schema.Struct({
  providerId: DesktopProviderId,
  displayName: text(128),
  locality: DesktopProviderLocality,
  billed: Schema.Boolean,
  placements: Schema.optional(Schema.Array(LeasableDesktopPlacement).pipe(Schema.maxItems(16))),
  daemon: Schema.optional(Schema.Literal(true)),
}).annotations(strict);
export type LeasableDesktopProvider = typeof LeasableDesktopProvider.Type;

/**
 * The local daemon a lease's desktop was made through: the socket path the
 * driver declares, relative to the home directory, and the operating-system
 * user whose home holds it. Teardown counts a listing as the provider's word
 * only from this same daemon.
 */
export const DesktopLeaseDaemon = Schema.Struct({
  socketPath: Schema.String.pipe(
    Schema.maxLength(255),
    Schema.pattern(/^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/),
    Schema.filter(
      (path) =>
        path.split("/").every((segment) => segment !== "." && segment !== "..") ||
        "A daemon socket path never leaves the home directory.",
    ),
  ),
  userId: Schema.Int.pipe(Schema.between(0, 4_294_967_295)),
}).annotations(strict);
export type DesktopLeaseDaemon = typeof DesktopLeaseDaemon.Type;

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
  placementId: Schema.optional(DesktopPlacementId),
  daemon: Schema.optional(DesktopLeaseDaemon),
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
 * so teardown can still find the key after the recipe is removed. For a
 * provider that declares placements, `locality` and `billed` are the
 * placement's, and `placementId` names it. A provider run by a local daemon
 * records that daemon in `daemon`, never a token.
 */
export const DesktopLeaseRequested = Schema.Struct({
  leaseId: DesktopLeaseId,
  owner: DesktopLeaseOwner,
  providerId: DesktopProviderId,
  locality: DesktopProviderLocality,
  billed: Schema.Boolean,
  hostTag: DesktopHostTag,
  credentialRef: Schema.optional(DesktopCredentialRef),
  placementId: Schema.optional(DesktopPlacementId),
  daemon: Schema.optional(DesktopLeaseDaemon),
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

/**
 * One Desktop tab's view of one lease. The host mints it when a person opens
 * the view and keeps it in memory only, so a reloaded window or a restarted
 * host holds none and a restored tab cannot stream or send input until a
 * person opens a view again.
 */
export const DesktopViewId = Schema.UUID.pipe(Schema.brand("DesktopViewId"));
export type DesktopViewId = typeof DesktopViewId.Type;

/**
 * Why a view refuses beyond the lease's own refusals: `view-ended` names a
 * view the host does not hold for this caller (closed, lapsed, from another
 * window or device, or minted before a restart); `view-limit` is the per-lease
 * cap on open views.
 */
export const DesktopViewRefusalReason = Schema.Literal("view-ended", "view-limit");
export type DesktopViewRefusalReason = typeof DesktopViewRefusalReason.Type;

export const DesktopPaneRefusal = Schema.Struct({
  status: Schema.Literal("refused"),
  reason: Schema.Union(DesktopLeaseRefusalReason, DesktopViewRefusalReason),
}).annotations(strict);
export type DesktopPaneRefusal = typeof DesktopPaneRefusal.Type;

const paneThread = { threadId: Schema.UUID };
const paneLease = { ...paneThread, leaseId: DesktopLeaseId };
const paneView = { ...paneLease, viewId: DesktopViewId };

/**
 * What a person's Desktop tab asks the host for one Code thread. The host
 * derives the person from the authenticated window or paired device that
 * sent it, never from the body.
 */
export const DesktopPaneRequest = Schema.Union(
  Schema.Struct({ kind: Schema.Literal("overview"), ...paneThread }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("acquire"),
    ...paneThread,
    /**
     * The billed provider the person confirmed in the tab before asking. A
     * billed desktop starts only with it, and only on that provider.
     */
    confirmedBilledProvider: Schema.optional(DesktopProviderId),
  }).annotations(strict),
  Schema.Struct({ kind: Schema.Literal("release"), ...paneLease }).annotations(strict),
  Schema.Struct({ kind: Schema.Literal("retry-release"), ...paneLease }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("extend"),
    ...paneLease,
    byMinutes: leaseMinutes,
  }).annotations(strict),
  Schema.Struct({ kind: Schema.Literal("open-view"), ...paneLease }).annotations(strict),
  Schema.Struct({ kind: Schema.Literal("close-view"), ...paneView }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("input"),
    ...paneView,
    event: DesktopInputEvent,
  }).annotations(strict),
  /** The providers a Project's recipe may name on this host now, for the recipe editor. */
  Schema.Struct({ kind: Schema.Literal("recipe-providers") }).annotations(strict),
);
export type DesktopPaneRequest = typeof DesktopPaneRequest.Type;

/** One frame of a view. The answer is the image itself, never stored by the host. */
export const DesktopFrameRequest = Schema.Struct(paneView).annotations(strict);
export type DesktopFrameRequest = typeof DesktopFrameRequest.Type;

/** Whether the thread could start a desktop now, or the refusal that stands in the way. */
export const DesktopPaneStart = Schema.Union(
  Schema.Struct({
    status: Schema.Literal("available"),
    provider: LeasableDesktopProvider,
  }).annotations(strict),
  DesktopLeaseRefusal,
);
export type DesktopPaneStart = typeof DesktopPaneStart.Type;

const leaseAnswer = <S extends string>(status: S) =>
  Schema.Struct({ status: Schema.Literal(status), lease: DesktopLease }).annotations(strict);

export const DesktopPaneAnswer = Schema.Union(
  Schema.Struct({
    status: Schema.Literal("overview"),
    /** The thread's leases that may still hold a desktop, then its most recent ended one. */
    leases: Schema.Array(DesktopLease),
    /** Every provider the host has loaded, so a lease names its provider even once it is not leasable. */
    providers: Schema.Array(LeasableDesktopProvider),
    start: DesktopPaneStart,
  }).annotations(strict),
  leaseAnswer("acquired"),
  leaseAnswer("not-acquired"),
  leaseAnswer("released"),
  leaseAnswer("releasing"),
  leaseAnswer("release-failed"),
  leaseAnswer("extended"),
  Schema.Struct({ status: Schema.Literal("viewing"), viewId: DesktopViewId }).annotations(strict),
  Schema.Struct({ status: Schema.Literal("view-closed") }).annotations(strict),
  /** A frame the desktop could not give, or the host would not pass on; the view stays open. */
  Schema.Struct({ status: Schema.Literal("no-frame") }).annotations(strict),
  Schema.Struct({ status: Schema.Literal("delivered") }).annotations(strict),
  /** The host journaled the input, but the desktop did not take it. */
  Schema.Struct({ status: Schema.Literal("not-delivered") }).annotations(strict),
  Schema.Struct({
    status: Schema.Literal("recipe-providers"),
    /** Providers ready for leasing on this host; a recipe naming any other is refused. */
    providers: Schema.Array(LeasableDesktopProvider),
  }).annotations(strict),
  DesktopPaneRefusal,
);
export type DesktopPaneAnswer = typeof DesktopPaneAnswer.Type;

export const decodeDesktopLeaseId = Schema.decodeUnknownSync(DesktopLeaseId);
export const decodeDesktopHostTag = Schema.decodeUnknownSync(DesktopHostTag);
export const decodeDesktopProviderId = Schema.decodeUnknownSync(DesktopProviderId);
export const decodeDesktopCredentialRef = Schema.decodeUnknownSync(DesktopCredentialRef);
export const decodeDesktopPlacementId = Schema.decodeUnknownSync(DesktopPlacementId);
export const decodeDesktopRecipe = Schema.decodeUnknownSync(DesktopRecipe);
export const decodeLeasableDesktopProvider = Schema.decodeUnknownSync(LeasableDesktopProvider);
export const decodeDesktopLeaseDaemon = Schema.decodeUnknownSync(DesktopLeaseDaemon);
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
export const decodeDesktopViewId = Schema.decodeUnknownSync(DesktopViewId);
export const decodeDesktopPaneRequest = Schema.decodeUnknownSync(DesktopPaneRequest);
export const decodeDesktopFrameRequest = Schema.decodeUnknownSync(DesktopFrameRequest);
export const decodeDesktopPaneAnswer = Schema.decodeUnknownSync(DesktopPaneAnswer);
