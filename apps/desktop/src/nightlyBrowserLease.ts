import { randomBytes, randomUUID } from "node:crypto";
import { uptime } from "node:os";
import { decodeWindowId } from "@octant/contracts";
import {
  decodeAdvertisedHostFeatures,
  decodeNightlyWindowBootstrap,
  type NightlyWindowBootstrap,
  type NativeWindowSource,
} from "@octant/contracts/nightly-browser";

export interface NativeWindowRequest {
  readonly requestId: number;
  /** Derived from the kernel audit token by the fixed native binding. */
  readonly peer: string;
  readonly windowId: string;
  readonly generation: number;
  readonly operation: "register" | "renew" | "revoke";
  /** The client accepts the native-main bootstrap fields; an older client does not. */
  readonly nativeMain: boolean;
}

export type NativeWindowEvent =
  | { readonly kind: "request"; readonly request: NativeWindowRequest }
  | { readonly kind: "peer-exited"; readonly peer: string };

export type NativeWindowReply =
  | NightlyWindowBootstrap
  | { readonly kind: "renewed"; readonly leaseMs: 15_000 }
  | { readonly kind: "revoked" }
  | { readonly kind: "refused"; readonly reason: "unavailable" | "expired" | "invalid-request" };

export interface NativeWindowBroker {
  readonly listenWindows: (callback: (event: unknown) => void) => Promise<unknown>;
  readonly replyWindow: (requestId: number, reply: NativeWindowReply) => boolean;
  readonly stopWindows: () => Promise<unknown>;
}

interface OwnedWindow {
  readonly windowId: string;
  readonly host: {
    readonly origin: string;
    readonly instanceId: string;
    readonly desktopBridgeSecret: string;
  };
  expiresElapsed: number;
  active: boolean;
  acknowledged: boolean;
  cancelExpiry: () => void;
  acquisition?: Promise<void>;
  cleanup?: Promise<void>;
  readonly capability: string;
  readonly rendererIdentity: string;
  /** Main-only: goes to the host and the native reply, never a renderer. */
  readonly nativeMainToken: string;
  hostFeatures: ReadonlyArray<string>;
  readonly source: NativeWindowSource;
}

export function ownNightlyWindowLeases(options: {
  readonly native: NativeWindowBroker;
  readonly host: () =>
    | { readonly origin: string; readonly instanceId: string; readonly desktopBridgeSecret: string }
    | undefined;
  readonly fetch?: typeof globalThis.fetch;
  readonly elapsedNow?: () => number;
  readonly schedule?: (delay: number, callback: () => void) => () => void;
  readonly closeOwnerContexts: (windowId: string) => Promise<void>;
  readonly onActiveWindowCountChanged?: (count: number) => void;
}) {
  const fetch = options.fetch ?? globalThis.fetch;
  const elapsedNow = options.elapsedNow ?? (() => uptime() * 1_000);
  const schedule =
    options.schedule ??
    ((delay, callback) => {
      const timer = setTimeout(callback, delay);
      timer.unref();
      return () => clearTimeout(timer);
    });
  const closingWindows = new Set<string>();
  const windows = new Map<string, OwnedWindow>();
  const registrations = new Map<string, string>();
  const pending = new Set<Promise<void>>();
  let closing = false;
  let close: Promise<{ readonly kind: "closed" | "failed" }> | undefined;
  const keyOf = (peer: string, windowId: string) => `${peer}:${windowId}`;
  const activeWindows = (): ReadonlyArray<OwnedWindow> => {
    if (closing) return [];
    const instance = options.host()?.instanceId;
    const elapsed = elapsedNow();
    return [...windows.values()].filter(
      (owned) =>
        owned.active &&
        owned.acknowledged &&
        owned.host.instanceId === instance &&
        owned.expiresElapsed > elapsed,
    );
  };
  let publishedCount = 0;
  const publishCount = (): void => {
    const count = activeWindows().length;
    if (count === publishedCount) return;
    publishedCount = count;
    try {
      options.onActiveWindowCountChanged?.(count);
    } catch {
      console.warn("Octant could not notify its Nightly client lifetime.");
    }
  };

  const revoke = (owned: OwnedWindow): Promise<void> => {
    if (owned.cleanup !== undefined) return owned.cleanup;
    owned.active = false;
    owned.cancelExpiry();
    owned.cleanup = Promise.allSettled([
      Promise.resolve().then(() => options.closeOwnerContexts(owned.windowId)),
      Promise.resolve().then(async () => {
        // A peer may exit while POST is still in flight. Delete after its
        // outcome so a late successful acquisition cannot outlive cleanup.
        await owned.acquisition?.catch(() => undefined);
        await request(owned.host, "DELETE", owned);
      }),
    ]).then((results) => {
      if (results.some((result) => result.status === "rejected"))
        throw new Error("Octant could not finish closing a Nightly window.");
    });
    return owned.cleanup;
  };
  const request = async (
    host: NonNullable<ReturnType<typeof options.host>>,
    method: "POST" | "PUT" | "DELETE",
    owned: OwnedWindow,
  ): Promise<void> => {
    const response = await fetch(new URL("/api/desktop/native-window-authorities", host.origin), {
      method,
      signal: AbortSignal.timeout(2_000),
      headers: {
        "content-type": "application/json",
        "x-octant-desktop-secret": host.desktopBridgeSecret,
      },
      body: JSON.stringify({
        windowId: owned.windowId,
        capability: owned.capability,
        source: owned.source,
        ...(method === "POST"
          ? { rendererIdentity: owned.rendererIdentity, nativeMainToken: owned.nativeMainToken }
          : {}),
      }),
    });
    if (response.status !== (method === "POST" ? 201 : method === "PUT" ? 200 : 204))
      throw new Error("Nightly window authority is unavailable.");
    if (method !== "DELETE") {
      const value: unknown = await response.json();
      if (
        typeof value !== "object" ||
        value === null ||
        !("generation" in value) ||
        value.generation !== owned.source.generation ||
        !("leaseMs" in value) ||
        value.leaseMs !== 15_000
      )
        throw new Error("Nightly window authority returned an invalid lease.");
      if (method === "POST")
        // A newer host may name features this build does not know; the
        // Nightly main ignores those rather than refusing the window.
        owned.hostFeatures =
          "hostFeatures" in value ? decodeAdvertisedHostFeatures(value.hostFeatures) : [];
    }
  };
  const closeOwned = async (key: string, owned: OwnedWindow): Promise<void> => {
    if (windows.get(key) === owned) windows.delete(key);
    closingWindows.add(key);
    publishCount();
    await revoke(owned);
    closingWindows.delete(key);
  };
  const armExpiry = (key: string, owned: OwnedWindow): void => {
    owned.cancelExpiry();
    const expire = () => {
      if (windows.get(key) !== owned) return;
      const remaining = owned.expiresElapsed - elapsedNow();
      if (Number.isFinite(remaining) && remaining > 0) {
        try {
          owned.cancelExpiry = schedule(remaining, expire);
          return;
        } catch {
          /* Fail closed below. */
        }
      }
      const cleanup = closeOwned(key, owned).catch(() =>
        console.warn("Octant could not finish expiring a Nightly window."),
      );
      pending.add(cleanup);
      void cleanup.finally(() => pending.delete(cleanup));
    };
    try {
      owned.cancelExpiry = schedule(Math.max(0, owned.expiresElapsed - elapsedNow()), expire);
    } catch {
      expire();
    }
  };
  const receive = async (event: NativeWindowEvent): Promise<void> => {
    if (event.kind === "peer-exited") {
      registrations.delete(event.peer);
      const owned = [...windows.entries()].filter(([key]) => key.startsWith(`${event.peer}:`));
      const outcomes = await Promise.allSettled(
        owned.map(([key, value]) => closeOwned(key, value)),
      );
      if (outcomes.some((outcome) => outcome.status === "rejected"))
        console.warn("Octant could not finish closing an exited Nightly client's windows.");
      return;
    }
    const input = event.request;
    const key = keyOf(input.peer, input.windowId);
    const host = options.host();
    publishCount();
    if (closing || host === undefined) {
      options.native.replyWindow(input.requestId, { kind: "refused", reason: "unavailable" });
      return;
    }
    let owned = windows.get(key);
    if (input.operation === "register") {
      if (
        owned !== undefined ||
        closingWindows.has(key) ||
        windows.size + closingWindows.size >= 128
      ) {
        options.native.replyWindow(input.requestId, { kind: "refused", reason: "invalid-request" });
        return;
      }
      const registration = registrations.get(input.peer) ?? randomBytes(32).toString("base64url");
      registrations.set(input.peer, registration);
      owned = {
        windowId: randomUUID(),
        host,
        expiresElapsed: elapsedNow() + 15_000,
        active: false,
        acknowledged: false,
        cancelExpiry: () => {},
        capability: randomBytes(32).toString("base64url"),
        rendererIdentity: randomBytes(32).toString("base64url"),
        nativeMainToken: randomBytes(32).toString("base64url"),
        hostFeatures: [],
        source: {
          kind: "native-nightly",
          processRegistration: registration,
          incarnation: input.peer,
          generation: input.generation,
        },
      };
      windows.set(key, owned);
      try {
        const registered = decodeNightlyWindowBootstrap({
          kind: "registered",
          protocol: 1,
          windowId: owned.windowId,
          generation: input.generation,
          hostOrigin: host.origin,
          hostInstance: host.instanceId,
          capability: owned.capability,
          rendererIdentity: owned.rendererIdentity,
          nativeMainToken: owned.nativeMainToken,
          leaseMs: 15_000,
        });
        owned.acquisition = request(host, "POST", owned);
        await owned.acquisition;
        // The host, not this main, names what it brokers for a native main.
        // An older client decodes the bootstrap strictly, so it gets the
        // original fields only and keeps working without brokered features.
        const { nativeMainToken: _withheld, ...original } = registered;
        const bootstrap: NightlyWindowBootstrap = input.nativeMain
          ? { ...registered, hostFeatures: owned.hostFeatures }
          : original;
        owned.active = true;
        armExpiry(key, owned);
        if (
          closing ||
          windows.get(key) !== owned ||
          options.host()?.instanceId !== host.instanceId ||
          !options.native.replyWindow(input.requestId, bootstrap)
        ) {
          await closeOwned(key, owned);
        } else {
          owned.acknowledged = true;
          publishCount();
        }
      } catch {
        if (windows.get(key) === owned) windows.delete(key);
        // Failed POST does not prove ownership. The ID was minted here, not
        // selected by the peer, and only an acknowledged registration may
        // have created Browser contexts that this owner can close.
        if (owned.active)
          await closeOwned(key, owned).catch(() =>
            console.warn("Octant could not revoke a refused Nightly window."),
          );
        else
          await request(owned.host, "DELETE", owned).catch(() =>
            console.warn("Octant could not settle an unacknowledged Nightly registration."),
          );
        options.native.replyWindow(input.requestId, { kind: "refused", reason: "unavailable" });
      }
      return;
    }
    if (
      owned === undefined ||
      !owned.active ||
      owned.expiresElapsed <= elapsedNow() ||
      owned.host.instanceId !== host.instanceId ||
      owned.source.generation !== input.generation
    ) {
      options.native.replyWindow(input.requestId, { kind: "refused", reason: "expired" });
      return;
    }
    if (input.operation === "revoke") {
      try {
        await closeOwned(key, owned);
        options.native.replyWindow(input.requestId, { kind: "revoked" });
      } catch {
        options.native.replyWindow(input.requestId, { kind: "refused", reason: "unavailable" });
      }
      return;
    }
    try {
      const renewalStarted = elapsedNow();
      await request(owned.host, "PUT", owned);
      if (
        closing ||
        windows.get(key) !== owned ||
        options.host()?.instanceId !== host.instanceId ||
        !options.native.replyWindow(input.requestId, { kind: "renewed", leaseMs: 15_000 })
      ) {
        await closeOwned(key, owned);
      } else {
        owned.expiresElapsed = renewalStarted + 15_000;
        armExpiry(key, owned);
      }
    } catch {
      await closeOwned(key, owned).catch(() =>
        console.warn("Octant could not revoke an expired Nightly window."),
      );
      options.native.replyWindow(input.requestId, { kind: "refused", reason: "expired" });
    }
  };
  const ready = options.native.listenWindows((raw) => {
    const event = decodeEvent(raw);
    if (event === undefined) return;
    const operation = receive(event).catch(() =>
      console.warn("Octant could not finish a Nightly window request."),
    );
    pending.add(operation);
    void operation.finally(() => pending.delete(operation));
  });
  return {
    ready,
    activeWindowCount: (): number => activeWindows().length,
    hasWindow: (windowId: string): boolean =>
      activeWindows().some((owned) => owned.windowId === windowId),
    close: () => {
      close ??= (async () => {
        closing = true;
        publishCount();
        const stopped = await options.native.stopWindows().catch(() => ({ kind: "failed" }));
        await Promise.allSettled(pending);
        const owned = [...windows.entries()];
        registrations.clear();
        const outcomes = await Promise.allSettled(
          owned.map(([key, value]) => closeOwned(key, value)),
        );
        return {
          kind:
            typeof stopped === "object" &&
            stopped !== null &&
            "kind" in stopped &&
            stopped.kind === "closed" &&
            outcomes.every((outcome) => outcome.status === "fulfilled")
              ? ("closed" as const)
              : ("failed" as const),
        };
      })();
      return close;
    },
  };
}

function decodeEvent(value: unknown): NativeWindowEvent | undefined {
  if (typeof value !== "object" || value === null || !("kind" in value)) return;
  if (
    value.kind === "peer-exited" &&
    "peer" in value &&
    typeof value.peer === "string" &&
    /^[0-9a-f]{64}$/.test(value.peer)
  )
    return { kind: "peer-exited", peer: value.peer };
  if (
    value.kind !== "request" ||
    !("request" in value) ||
    typeof value.request !== "object" ||
    value.request === null
  )
    return;
  const request = value.request;
  if (
    !("requestId" in request) ||
    typeof request.requestId !== "number" ||
    !Number.isSafeInteger(request.requestId) ||
    request.requestId < 1 ||
    !("peer" in request) ||
    typeof request.peer !== "string" ||
    !/^[0-9a-f]{64}$/.test(request.peer) ||
    !("windowId" in request) ||
    typeof request.windowId !== "string" ||
    !("generation" in request) ||
    typeof request.generation !== "number" ||
    !Number.isSafeInteger(request.generation) ||
    request.generation < 1 ||
    !("operation" in request) ||
    (request.operation !== "register" &&
      request.operation !== "renew" &&
      request.operation !== "revoke")
  )
    return;
  try {
    decodeWindowId(request.windowId);
  } catch {
    return;
  }
  return {
    kind: "request",
    request: {
      requestId: request.requestId,
      peer: request.peer,
      windowId: request.windowId,
      generation: request.generation,
      operation: request.operation,
      nativeMain: "nativeMain" in request && request.nativeMain === true,
    },
  };
}
