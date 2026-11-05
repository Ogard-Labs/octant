import { randomUUID } from "node:crypto";
import { uptime } from "node:os";
import type { NightlyWindowBootstrap } from "@octant/contracts/nightly-browser";
import { boundedDesktopPeerOperation } from "./desktopPeerStatus";
import { registerNightlyWindow, type NativeDesktopWindows } from "./desktopPeerWindows";

export interface NightlyClientWindow {
  readonly load: () => Promise<void>;
  readonly show: () => void;
  readonly destroy: () => void;
  readonly isDestroyed: () => boolean;
  readonly onClosed: (listener: () => void) => void;
}

/** Owns one native client handle; its server window ID is issued by Stable. */
export async function openNightlyClientWindow(options: {
  readonly native: NativeDesktopWindows;
  readonly createWindow: (bootstrap: NightlyWindowBootstrap) => NightlyClientWindow;
  readonly isClosing?: () => boolean;
  readonly signal?: AbortSignal;
  readonly onLeaseLost?: () => void;
  readonly elapsedNow?: () => number;
  readonly schedule?: (delay: number, callback: () => void) => () => void;
}): Promise<
  | {
      readonly kind: "opened";
      readonly close: () => Promise<{ readonly kind: "closed" | "failed" }>;
    }
  | { readonly kind: "refused"; readonly reason: string; readonly cleanupFailed?: true }
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
  const isClosing = () => options.isClosing?.() === true || options.signal?.aborted === true;
  const revoke = async () => {
    const reply = await boundedDesktopPeerOperation(() =>
      options.native.revokeWindow(handle, generation),
    );
    return typeof reply === "object" &&
      reply !== null &&
      "kind" in reply &&
      reply.kind === "revoked"
      ? ("closed" as const)
      : ("failed" as const);
  };
  const refused = (reason: string, cleanup: "closed" | "failed") => ({
    kind: "refused" as const,
    reason,
    ...(cleanup === "failed" ? { cleanupFailed: true as const } : {}),
  });
  const registration = await registerNightlyWindow(options.native, handle, generation);
  if (registration.kind === "refused") {
    // A missing receipt does not prove the peer failed to mint the lease.
    return refused(registration.reason, await revoke());
  }
  if (isClosing()) {
    return refused("native-unavailable", await revoke());
  }
  let expires = began + registration.bootstrap.leaseMs;
  let window: NightlyClientWindow;
  try {
    window = options.createWindow(registration.bootstrap);
  } catch {
    return refused("native-unavailable", await revoke());
  }
  let closing: Promise<{ readonly kind: "closed" | "failed" }> | undefined;
  let stopped = false;
  let delivered = false;
  let cancelTimer = () => {};
  let pendingRenewal: Promise<unknown> | undefined;
  let cancelHardDeadline = () => {};
  let stopLoading = () => {};
  const loadingStopped = new Promise<void>((resolve) => {
    stopLoading = resolve;
  });
  const close = () => {
    if (closing !== undefined) return closing;
    stopped = true;
    stopLoading();
    options.signal?.removeEventListener("abort", abort);
    cancelTimer();
    cancelHardDeadline();
    closing = Promise.resolve().then(async () => {
      await pendingRenewal;
      return { kind: await revoke() };
    });
    if (!window.isDestroyed()) window.destroy();
    return closing;
  };
  const abort = () => {
    void close();
  };
  const loseLease = () => {
    if (stopped) return;
    if (delivered) {
      try {
        options.onLeaseLost?.();
      } catch {
        console.warn("Octant could not begin Nightly recovery.");
      }
    }
    void close();
  };
  options.signal?.addEventListener("abort", abort, { once: true });
  const tick = () => {
    if (stopped) return;
    if (!Number.isFinite(elapsedNow()) || elapsedNow() >= expires || window.isDestroyed()) {
      loseLease();
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
        loseLease();
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
        loseLease();
      }
    }
  };
  const armHardDeadline = () => {
    cancelHardDeadline();
    if (!stopped) {
      try {
        cancelHardDeadline = schedule(Math.max(0, expires - elapsedNow()), () => {
          if (elapsedNow() >= expires) loseLease();
          else armHardDeadline();
        });
      } catch {
        loseLease();
      }
    }
  };
  window.onClosed(() => {
    void close();
  });
  try {
    armHardDeadline();
    await Promise.race([window.load(), loadingStopped]);
    if (stopped || isClosing() || window.isDestroyed() || elapsedNow() >= expires) {
      return refused("deadline-exceeded", (await close()).kind);
    }
    arm();
    window.show();
    delivered = true;
    return { kind: "opened", close };
  } catch {
    return refused("native-unavailable", (await close()).kind);
  }
}
