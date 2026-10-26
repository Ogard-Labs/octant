/**
 * An in-memory desktop provider for tests: the host lease service's tests and
 * the conformance suite's own tests run against it. It keeps the seam's
 * promises unless a test switches a behaviour off, and it records every call
 * so a test can prove the host made none.
 */
import type { DesktopHostTag, DesktopProviderId, UtcTimestamp } from "@octant/contracts";
import { decodeDesktopProviderId, decodeUtcTimestamp } from "@octant/contracts";
import type {
  DesktopHandle,
  DesktopProvider,
  DesktopProviderStatusResult,
} from "./desktopProvider";

export interface FakeDesktopBehaviour {
  status: DesktopProviderStatusResult["status"];
  /** The provider declines to move its expiry. */
  declineExtensions: boolean;
  /** Destroy answers, but the desktop keeps running. */
  lingerAfterRelease: boolean;
  /** The provider cannot be reached for destroy, verify, or listing. */
  unreachable: boolean;
  /** A billed provider that forgets to set its own expiry. */
  omitProviderExpiry: boolean;
}

export interface FakeDesktop {
  readonly handle: DesktopHandle;
  readonly hostTag: DesktopHostTag;
  readonly providerExpiresAt: UtcTimestamp | undefined;
}

export interface FakeDesktopBackend {
  readonly behaviour: FakeDesktopBehaviour;
  readonly desktops: () => ReadonlyArray<FakeDesktop>;
  readonly calls: () => ReadonlyArray<string>;
  /** A desktop left behind by an earlier host process. */
  readonly plant: (desktop: FakeDesktop) => void;
}

/** Billed providers set their own expiry this long after the lease's. */
const PROVIDER_EXPIRY_MARGIN_MS = 5 * 60_000;

export function createFakeDesktopProvider(
  options: {
    readonly id?: string;
    readonly locality?: DesktopProvider["locality"];
    readonly billed?: boolean;
    readonly behaviour?: Partial<FakeDesktopBehaviour>;
  } = {},
): { readonly provider: DesktopProvider; readonly backend: FakeDesktopBackend } {
  const id: DesktopProviderId = decodeDesktopProviderId(options.id ?? "fake-desktop");
  const billed = options.billed ?? false;
  const behaviour: FakeDesktopBehaviour = {
    status: "ready",
    declineExtensions: false,
    lingerAfterRelease: false,
    unreachable: false,
    omitProviderExpiry: false,
    ...options.behaviour,
  };
  const desktops = new Map<string, FakeDesktop>();
  const calls: Array<string> = [];
  let sequence = 0;

  const providerExpiry = (expiresAt: string): UtcTimestamp | undefined =>
    billed && !behaviour.omitProviderExpiry
      ? decodeUtcTimestamp(
          new Date(Date.parse(expiresAt) + PROVIDER_EXPIRY_MARGIN_MS).toISOString(),
        )
      : undefined;

  const provider: DesktopProvider = {
    kind: "desktop-provider",
    id,
    displayName: "Fake desktop",
    locality: options.locality ?? "host-local",
    billed,
    status: async () => {
      calls.push("status");
      if (behaviour.status === "ready") return { status: "ready" };
      if (behaviour.status === "refused") return { status: "refused", reason: "not-installed" };
      return { status: "not-connected" };
    },
    acquire: async (request) => {
      calls.push("acquire");
      if (request.signal.aborted) return { status: "cancelled" };
      if (behaviour.unreachable) return { status: "not-connected" };
      sequence += 1;
      const handle: DesktopHandle = { leaseId: request.leaseId, resource: `desktop-${sequence}` };
      const providerExpiresAt = providerExpiry(request.expiresAt);
      desktops.set(handle.resource, { handle, hostTag: request.hostTag, providerExpiresAt });
      return providerExpiresAt === undefined
        ? { status: "acquired", handle }
        : { status: "acquired", handle, providerExpiresAt };
    },
    extend: async (handle, expiresAt) => {
      calls.push("extend");
      const desktop = desktops.get(handle.resource);
      if (desktop === undefined) return { status: "failed", reason: "not-found" };
      if (behaviour.declineExtensions) return { status: "refused", reason: "declined" };
      const providerExpiresAt = providerExpiry(expiresAt);
      desktops.set(handle.resource, { ...desktop, providerExpiresAt });
      return { status: "extended", expiresAt: providerExpiresAt ?? expiresAt };
    },
    screen: async () => {
      calls.push("screen");
      return { status: "refused", reason: "unsupported" };
    },
    control: async (handle, command) => {
      calls.push("control");
      if (!desktops.has(handle.resource)) {
        return { kind: "failed", reason: "not-found", message: "The desktop is gone." };
      }
      if (command.operation === "apps") return { kind: "apps", apps: [] };
      return {
        kind: "refused",
        reason: "unsupported",
        message: "This desktop does not support that command.",
      };
    },
    deliver: async () => {
      calls.push("deliver");
      return { status: "refused", reason: "unsupported" };
    },
    release: async (handle) => {
      calls.push("release");
      if (behaviour.unreachable) return { status: "not-connected" };
      if (!behaviour.lingerAfterRelease) desktops.delete(handle.resource);
      return { status: "released" };
    },
    verifyGone: async (handle) => {
      calls.push("verifyGone");
      if (behaviour.unreachable) return { status: "not-connected" };
      return desktops.has(handle.resource) ? { status: "present" } : { status: "gone" };
    },
    listOwned: async (hostTag) => {
      calls.push("listOwned");
      if (behaviour.unreachable) return { status: "not-connected" };
      return {
        status: "listed",
        resources: [...desktops.values()]
          .filter((desktop) => String(desktop.hostTag) === String(hostTag))
          .map((desktop) => ({ hostTag: desktop.hostTag, handle: desktop.handle })),
      };
    },
  };

  return {
    provider,
    backend: {
      behaviour,
      desktops: () => [...desktops.values()],
      calls: () => [...calls],
      plant: (desktop) => {
        desktops.set(desktop.handle.resource, desktop);
      },
    },
  };
}
