import type {
  AppleDeviceLease,
  AppleDeviceLeaseEndReason,
  AppleDeviceLeaseHolder,
  AppleDeviceState,
} from "@octant/contracts";

/**
 * How long a leased device may stay unplugged or out of reach before its lease
 * ends. A phone carried away from the Mac for a moment keeps its lease; one
 * that is gone longer is a different session nobody confirmed.
 */
export const APPLE_DEVICE_DISCONNECT_GRACE_MS = 5 * 60_000;

export interface EndedAppleDeviceLease {
  readonly lease: AppleDeviceLease;
  readonly reason: AppleDeviceLeaseEndReason;
}

/**
 * Which thread may use each paired device. A lease lives in host memory only,
 * so a restart forgets every one and each thread asks again: that is the safe
 * direction to forget in, as with Simulator input grants. The host starts a
 * lease only after the device policy allowed it, and ends it when the person
 * releases it, the thread is archived, purged, or bound to another checkout,
 * or the device is gone for longer than five minutes.
 */
export class AppleDeviceLeases {
  readonly #now: () => number;
  readonly #leases = new Map<string, AppleDeviceLease>();
  /** When each leased device was first seen gone, on the authority clock. */
  readonly #goneSince = new Map<string, number>();
  readonly #endedListeners = new Set<(ended: EndedAppleDeviceLease) => void>();

  /**
   * `now` measures the disconnect grace: the host passes its suspend-aware
   * authority clock, so a clock set back cannot keep a lease alive.
   */
  constructor(now: () => number = Date.now) {
    this.#now = now;
  }

  /**
   * Tells the host each lease that ends, however it ends, so what the thread
   * started on the device under it stops with it.
   */
  onEnded(listener: (ended: EndedAppleDeviceLease) => void): () => void {
    this.#endedListeners.add(listener);
    return () => this.#endedListeners.delete(listener);
  }

  list(): ReadonlyArray<AppleDeviceLease> {
    this.#endDisconnected();
    return [...this.#leases.values()];
  }

  /** Whose lease a device is under, as the asking thread may learn it. */
  holder(deviceId: string, threadId: string): AppleDeviceLeaseHolder | undefined {
    this.#endDisconnected();
    const lease = this.#leases.get(deviceId);
    if (lease === undefined) return undefined;
    return String(lease.threadId) === threadId ? "this-thread" : "another-thread";
  }

  /** Starts a lease the policy allowed, ending the one it moves the device from. */
  start(lease: AppleDeviceLease): ReadonlyArray<EndedAppleDeviceLease> {
    const ended = this.#endDisconnected();
    const previous = this.#leases.get(String(lease.deviceId));
    this.#leases.set(String(lease.deviceId), lease);
    this.#goneSince.delete(String(lease.deviceId));
    if (previous === undefined) return ended;
    const moved: EndedAppleDeviceLease = { lease: previous, reason: "moved" };
    this.#announce(moved);
    return [...ended, moved];
  }

  release(deviceId: string, threadId: string): EndedAppleDeviceLease | undefined {
    const lease = this.#leases.get(deviceId);
    if (lease === undefined || String(lease.threadId) !== threadId) return undefined;
    return this.#end(deviceId, "released");
  }

  /**
   * What a discovery found. A leased device missing from the list, or listed
   * as unavailable, starts its grace from the first discovery that missed it;
   * one seen again keeps its lease. Only a discovery sees a disconnect, so the
   * grace counts from then rather than from the moment the cable came out.
   */
  observeDevices(
    devices: ReadonlyArray<{ readonly deviceId: string; readonly state: AppleDeviceState }>,
  ): ReadonlyArray<EndedAppleDeviceLease> {
    const now = this.#now();
    for (const deviceId of this.#leases.keys()) {
      const seen = devices.find((device) => device.deviceId === deviceId);
      if (seen === undefined || seen.state === "unavailable") {
        if (!this.#goneSince.has(deviceId)) this.#goneSince.set(deviceId, now);
      } else {
        this.#goneSince.delete(deviceId);
      }
    }
    return this.#endDisconnected();
  }

  /** Ends every lease a thread holds when it is archived or purged. */
  threadSettled(
    threadId: string,
    reason: "thread-archived" | "thread-purged",
  ): ReadonlyArray<EndedAppleDeviceLease> {
    return this.#endWhere((lease) => String(lease.threadId) === threadId, reason);
  }

  /**
   * Ends the leases a thread took on an earlier checkout once it is bound to
   * another: the person confirmed the device for the checkout they saw.
   */
  threadCheckout(threadId: string, checkoutId: string): ReadonlyArray<EndedAppleDeviceLease> {
    return this.#endWhere(
      (lease) => String(lease.threadId) === threadId && String(lease.checkoutId) !== checkoutId,
      "checkout-rebound",
    );
  }

  #endDisconnected(): ReadonlyArray<EndedAppleDeviceLease> {
    const now = this.#now();
    const ended: EndedAppleDeviceLease[] = [];
    for (const [deviceId, since] of this.#goneSince) {
      if (now - since <= APPLE_DEVICE_DISCONNECT_GRACE_MS) continue;
      const end = this.#end(deviceId, "device-disconnected");
      if (end !== undefined) ended.push(end);
    }
    return ended;
  }

  #endWhere(
    matches: (lease: AppleDeviceLease) => boolean,
    reason: AppleDeviceLeaseEndReason,
  ): ReadonlyArray<EndedAppleDeviceLease> {
    const ended: EndedAppleDeviceLease[] = [];
    for (const [deviceId, lease] of this.#leases) {
      if (!matches(lease)) continue;
      const end = this.#end(deviceId, reason);
      if (end !== undefined) ended.push(end);
    }
    return ended;
  }

  #end(deviceId: string, reason: AppleDeviceLeaseEndReason): EndedAppleDeviceLease | undefined {
    const lease = this.#leases.get(deviceId);
    this.#goneSince.delete(deviceId);
    if (lease === undefined) return undefined;
    this.#leases.delete(deviceId);
    const ended = { lease, reason };
    this.#announce(ended);
    return ended;
  }

  #announce(ended: EndedAppleDeviceLease): void {
    for (const listener of this.#endedListeners) listener(ended);
  }
}
