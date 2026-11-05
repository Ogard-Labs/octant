import { randomUUID } from "node:crypto";
import { uptime } from "node:os";
import type { NightlyWindowBootstrap } from "@octant/contracts/nightly-browser";
import { boundedDesktopPeerOperation } from "./desktopPeerStatus";
import { registerNightlyWindow, type NativeDesktopWindows } from "./desktopPeerWindows";

export interface NightlyClientWindow {
  readonly load: () => Promise<void>;
  readonly destroy: () => void;
  readonly isDestroyed: () => boolean;
  readonly onClosed: (listener: () => void) => void;
}

/** Owns one native client handle; its server window ID is issued by Stable. */
export async function openNightlyClientWindow(options: {
  readonly native: NativeDesktopWindows;
  readonly createWindow: (bootstrap: NightlyWindowBootstrap) => NightlyClientWindow;
  readonly isClosing?: () => boolean;
  readonly elapsedNow?: () => number;
  readonly schedule?: (delay: number, callback: () => void) => () => void;
}): Promise<
  | {
      readonly kind: "opened";
      readonly close: () => Promise<{ readonly kind: "closed" | "failed" }>;
    }
  | { readonly kind: "refused"; readonly reason: string }
> {
  const handle = randomUUID();
  const generation = 1;
  const elapsedNow = options.elapsedNow ?? (() => uptime() * 1_000);
  const schedule =
    options.schedule ??
    ((delay, callback) => {
      const timer = setTimeout(callback, delay);
      timer.unref();
      return () => clearTimeout(timer);
    });
  const began = elapsedNow();
  const registration = await registerNightlyWindow(options.native, handle, generation);
  if (registration.kind === "refused") {
    // A missing receipt does not prove the peer failed to mint the lease.
    await boundedDesktopPeerOperation(() => options.native.revokeWindow(handle, generation));
    return registration;
  }
  if (options.isClosing?.() === true) {
    await boundedDesktopPeerOperation(() => options.native.revokeWindow(handle, generation));
    return { kind: "refused", reason: "native-unavailable" };
  }
  let expires = began + registration.bootstrap.leaseMs;
  let window: NightlyClientWindow;
  try {
    window = options.createWindow(registration.bootstrap);
  } catch {
    await boundedDesktopPeerOperation(() => options.native.revokeWindow(handle, generation));
    return { kind: "refused", reason: "native-unavailable" };
  }
  let closing: Promise<{ readonly kind: "closed" | "failed" }> | undefined;
  let stopped = false;
  let cancelTimer = () => {};
  let pendingRenewal: Promise<unknown> | undefined;
  let cancelHardDeadline = () => {};
  const close = () => {
    if (closing !== undefined) return closing;
    stopped = true;
    cancelTimer();
    cancelHardDeadline();
    closing = Promise.resolve().then(async () => {
      await pendingRenewal;
      const reply = await boundedDesktopPeerOperation(() =>
        options.native.revokeWindow(handle, generation),
      );
      return {
        kind:
          typeof reply === "object" && reply !== null && "kind" in reply && reply.kind === "revoked"
            ? ("closed" as const)
            : ("failed" as const),
      };
    });
    if (!window.isDestroyed()) window.destroy();
    return closing;
  };
  const tick = () => {
    if (stopped) return;
    if (!Number.isFinite(elapsedNow()) || elapsedNow() >= expires || window.isDestroyed()) {
      void close();
      return;
    }
    const started = elapsedNow();
    pendingRenewal = boundedDesktopPeerOperation(() =>
      options.native.renewWindow(handle, generation),
    );
    void pendingRenewal.then((reply) => {
      if (stopped) return;
      if (
        typeof reply !== "object" ||
        reply === null ||
        !("kind" in reply) ||
        reply.kind !== "renewed" ||
        !("leaseMs" in reply) ||
        reply.leaseMs !== 15_000 ||
        elapsedNow() >= expires
      ) {
        void close();
        return;
      }
      expires = started + 15_000;
      armHardDeadline();
      arm();
    });
  };
  const arm = () => {
    cancelTimer();
    if (!stopped) {
      try {
        cancelTimer = schedule(Math.min(5_000, Math.max(0, expires - elapsedNow())), tick);
      } catch {
        void close();
      }
    }
  };
  const armHardDeadline = () => {
    cancelHardDeadline();
    if (!stopped) {
      try {
        cancelHardDeadline = schedule(Math.max(0, expires - elapsedNow()), () => {
          if (elapsedNow() >= expires) void close();
          else armHardDeadline();
        });
      } catch {
        void close();
      }
    }
  };
  window.onClosed(() => {
    void close();
  });
  try {
    armHardDeadline();
    await window.load();
    if (window.isDestroyed() || elapsedNow() >= expires) {
      await close();
      return { kind: "refused", reason: "deadline-exceeded" };
    }
    arm();
    return { kind: "opened", close };
  } catch {
    await close();
    return { kind: "refused", reason: "native-unavailable" };
  }
}
