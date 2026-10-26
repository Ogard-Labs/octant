/**
 * The desktop-provider contribution.
 *
 * A desktop provider creates, drives, and destroys throwaway desktops a thread
 * leases. The host owns leases, journaling, authority, approvals, teardown,
 * restart reconciliation, the screen stream, and evidence; a driver owns only
 * the translation to its provider. A driver imports only `@octant/contracts`
 * and this seam. Every operation answers with a discriminated result and
 * never throws for an expected outcome.
 */
import type {
  ComputerControlCommand,
  ComputerControlResult,
} from "@octant/contracts/computer-use-plugin";
import type {
  DesktopHostTag,
  DesktopInputEvent,
  DesktopLeaseId,
  DesktopProviderId,
  DesktopProviderLocality,
  DesktopRecipe,
  UtcTimestamp,
} from "@octant/contracts";

export const DESKTOP_PROVIDER_CONTRIBUTION_KIND = "desktop-provider" as const;
export type DesktopProviderContributionKind = typeof DESKTOP_PROVIDER_CONTRIBUTION_KIND;

/**
 * The driver's reference to one desktop. `resource` is the provider's own id;
 * it never carries a stream URL or token, which stay inside the driver.
 */
export interface DesktopHandle {
  readonly leaseId: DesktopLeaseId;
  readonly resource: string;
}

/** `refused` is authority or configuration; `not-connected` is reach. */
type Unavailable =
  | { readonly status: "refused"; readonly reason: string }
  | { readonly status: "failed"; readonly reason: string }
  | { readonly status: "not-connected" };

export type DesktopProviderStatusResult =
  | { readonly status: "ready" }
  | { readonly status: "refused"; readonly reason: string }
  | { readonly status: "not-connected" };

export interface DesktopAcquireRequest {
  readonly leaseId: DesktopLeaseId;
  readonly hostTag: DesktopHostTag;
  readonly recipe: DesktopRecipe;
  readonly expiresAt: UtcTimestamp;
  readonly signal: AbortSignal;
}

/**
 * `providerExpiresAt` is when the provider's own clock destroys the desktop.
 * A billed driver must set it to the lease expiry or later; the host refuses
 * to keep a billed desktop without it.
 */
export type DesktopAcquireResult =
  | {
      readonly status: "acquired";
      readonly handle: DesktopHandle;
      readonly providerExpiresAt?: UtcTimestamp;
    }
  | { readonly status: "cancelled" }
  | Unavailable;

/** `expiresAt` is the expiry the provider reports now, not the one requested. */
export type DesktopExtendResult =
  | { readonly status: "extended"; readonly expiresAt: UtcTimestamp }
  | Unavailable;

export interface DesktopFrame {
  readonly mediaType: "image/png" | "image/jpeg";
  readonly width: number;
  readonly height: number;
  readonly bytes: Uint8Array;
}

export type DesktopFrameResult =
  | { readonly status: "frame"; readonly frame: DesktopFrame }
  | Unavailable;

export type DesktopInputResult = { readonly status: "delivered" } | Unavailable;

/** A bounded frame source and an input sink the host streams on its own channel. */
export interface DesktopScreen {
  readonly frame: (signal?: AbortSignal) => Promise<DesktopFrameResult>;
  readonly input: (event: DesktopInputEvent) => Promise<DesktopInputResult>;
  readonly close: () => Promise<void>;
}

export type DesktopScreenResult =
  | { readonly status: "ready"; readonly screen: DesktopScreen }
  | Unavailable;

export type DesktopDeliverResult = { readonly status: "delivered" } | Unavailable;

/** Destroy was asked for. It is not proof; only `verifyGone` is. */
export type DesktopReleaseResult =
  | { readonly status: "released" }
  | { readonly status: "failed"; readonly reason: string }
  | { readonly status: "not-connected" };

export type DesktopVerifyGoneResult =
  | { readonly status: "gone" }
  | { readonly status: "present" }
  | { readonly status: "failed"; readonly reason: string }
  | { readonly status: "not-connected" };

export interface DesktopOwnedResource {
  readonly hostTag: DesktopHostTag;
  readonly handle: DesktopHandle;
}

export type DesktopListOwnedResult =
  | { readonly status: "listed"; readonly resources: ReadonlyArray<DesktopOwnedResource> }
  | { readonly status: "failed"; readonly reason: string }
  | { readonly status: "not-connected" };

export interface DesktopProvider {
  readonly kind: DesktopProviderContributionKind;
  readonly id: DesktopProviderId;
  readonly displayName: string;
  readonly locality: DesktopProviderLocality;
  /** Whether a lease spends the person's money. A person confirms every billed lease. */
  readonly billed: boolean;
  /** Whether the provider can be used on this host now. Performs no work. */
  readonly status: () => Promise<DesktopProviderStatusResult>;
  /** Creates one desktop tagged with the lease id and host tag. */
  readonly acquire: (request: DesktopAcquireRequest) => Promise<DesktopAcquireResult>;
  readonly extend: (handle: DesktopHandle, expiresAt: UtcTimestamp) => Promise<DesktopExtendResult>;
  readonly screen: (handle: DesktopHandle) => Promise<DesktopScreenResult>;
  /** The `octant_computer` commands it supports; any other refuses `unsupported`. */
  readonly control: (
    handle: DesktopHandle,
    command: ComputerControlCommand,
  ) => Promise<ComputerControlResult>;
  /** Writes one read-only file into the desktop's inbox under `name`. */
  readonly deliver: (
    handle: DesktopHandle,
    name: string,
    bytes: Uint8Array,
  ) => Promise<DesktopDeliverResult>;
  readonly release: (handle: DesktopHandle) => Promise<DesktopReleaseResult>;
  readonly verifyGone: (handle: DesktopHandle) => Promise<DesktopVerifyGoneResult>;
  /** Every tagged desktop the provider holds for `hostTag`, for restart reconciliation. */
  readonly listOwned: (hostTag: DesktopHostTag) => Promise<DesktopListOwnedResult>;
}

/**
 * The only operations the host's teardown path holds. A driver kept loaded
 * after its recipe, credential, or plugin was revoked is held as this, so it
 * can destroy and verify but never acquire, extend, read the screen, or send
 * input.
 */
export type DesktopTeardownPort = Pick<
  DesktopProvider,
  "id" | "release" | "verifyGone" | "listOwned"
>;
