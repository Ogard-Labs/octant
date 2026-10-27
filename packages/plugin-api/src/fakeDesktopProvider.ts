/**
 * An in-memory desktop provider for tests: the host lease service's tests and
 * the conformance suite's own tests run against it. It keeps the seam's
 * promises unless a test switches a behaviour off, and it records every call
 * so a test can prove the host made none.
 */
import type {
  DesktopHostTag,
  DesktopInputEvent,
  DesktopProviderId,
  UtcTimestamp,
} from "@octant/contracts";
import { decodeDesktopProviderId, decodeUtcTimestamp } from "@octant/contracts";
import type {
  DesktopFrame,
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
  /** The frame each screen read answers with; undefined answers no frame. */
  frame: DesktopFrame | undefined;
}

export interface FakeDesktop {
  readonly handle: DesktopHandle;
  readonly hostTag: DesktopHostTag;
  readonly providerExpiresAt: UtcTimestamp | undefined;
}

/** One input a desktop's screen took. */
export interface FakeInput {
  readonly resource: string;
  readonly event: DesktopInputEvent;
}

/** One file a transfer wrote into a desktop's inbox. */
export interface FakeDelivery {
  readonly resource: string;
  readonly name: string;
  readonly bytes: Uint8Array;
}

export interface FakeDesktopBackend {
  readonly behaviour: FakeDesktopBehaviour;
  readonly desktops: () => ReadonlyArray<FakeDesktop>;
  readonly delivered: () => ReadonlyArray<FakeDelivery>;
  readonly inputs: () => ReadonlyArray<FakeInput>;
  readonly calls: () => ReadonlyArray<string>;
  /** A desktop left behind by an earlier host process. */
  readonly plant: (desktop: FakeDesktop) => void;
}

/** A 1x1 PNG's signature and header. Nothing reads its pixels. */
export const FAKE_DESKTOP_FRAME: DesktopFrame = {
  mediaType: "image/png",
  width: 1,
  height: 1,
  bytes: new Uint8Array([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 1,
    0, 0, 0, 1, 8, 6, 0, 0, 0,
  ]),
};

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
    frame: FAKE_DESKTOP_FRAME,
    ...options.behaviour,
  };
  const desktops = new Map<string, FakeDesktop>();
  const calls: Array<string> = [];
  const delivered: Array<FakeDelivery> = [];
  const inputs: Array<FakeInput> = [];
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
    screen: async (handle) => {
      calls.push("screen");
      if (!desktops.has(handle.resource)) return { status: "failed", reason: "not-found" };
      return {
        status: "ready",
        screen: {
          frame: async () => {
            calls.push("frame");
            if (!desktops.has(handle.resource)) return { status: "failed", reason: "not-found" };
            return behaviour.frame === undefined
              ? { status: "failed", reason: "no-frame" }
              : { status: "frame", frame: behaviour.frame };
          },
          input: async (event) => {
            calls.push("input");
            if (!desktops.has(handle.resource)) return { status: "failed", reason: "not-found" };
            inputs.push({ resource: handle.resource, event });
            return { status: "delivered" };
          },
          close: async () => {
            calls.push("close-screen");
          },
        },
      };
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
    deliver: async (handle, name, bytes) => {
      calls.push("deliver");
      if (!desktops.has(handle.resource)) return { status: "failed", reason: "not-found" };
      delivered.push({ resource: handle.resource, name, bytes: bytes.slice() });
      return { status: "delivered" };
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
      delivered: () => [...delivered],
      inputs: () => [...inputs],
      calls: () => [...calls],
      plant: (desktop) => {
        desktops.set(desktop.handle.resource, desktop);
      },
    },
  };
}
